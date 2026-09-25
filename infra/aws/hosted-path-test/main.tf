# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

locals {
  name = "axl-hosted-test"
}

data "aws_secretsmanager_secret" "runtime" {
  name = var.secret_name
}

data "aws_secretsmanager_secret" "witness_keys" {
  name = var.witness_secret_name
}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_ecr_repository" "control_plane" {
  name                 = "${local.name}-control-plane"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "relay" {
  name                 = "${local.name}-relay"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "control_plane" {
  repository = aws_ecr_repository.control_plane.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain the ten newest deployment-test images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_ecr_lifecycle_policy" "relay" {
  repository = aws_ecr_repository.relay.name
  policy     = aws_ecr_lifecycle_policy.control_plane.policy
}

resource "aws_vpc" "main" {
  cidr_block           = "10.62.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = "${local.name}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-igw" }
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "${local.name}-public-${count.index + 1}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "load_balancer" {
  name        = "${local.name}-alb"
  description = "CloudFront-only ingress for the hosted-path deployment test"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "HTTP from CloudFront origin-facing network"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "Only the hosted-path load balancer may reach ECS tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Control plane from ALB"
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.load_balancer.id]
  }

  ingress {
    description     = "Relay from ALB"
    from_port       = 4000
    to_port         = 4000
    protocol        = "tcp"
    security_groups = [aws_security_group.load_balancer.id]
  }

  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "main" {
  name                       = local.name
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.load_balancer.id]
  subnets                    = aws_subnet.public[*].id
  idle_timeout               = 120
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "control_plane" {
  name        = "axl-test-control"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  health_check {
    enabled             = true
    path                = "/healthz"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 2
    timeout             = 5
    interval            = 15
  }
}

resource "aws_lb_target_group" "relay" {
  name        = "axl-test-relay"
  port        = 4000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  health_check {
    enabled             = true
    path                = "/healthz"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 2
    timeout             = 5
    interval            = 15
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.control_plane.arn
  }
}

resource "aws_lb_listener_rule" "relay" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.relay.arn
  }

  condition {
    path_pattern {
      values = ["/v1/connect", "/internal/v1/revocations"]
    }
  }
}

resource "aws_cloudfront_distribution" "main" {
  enabled         = true
  http_version    = "http2and3"
  is_ipv6_enabled = true
  price_class     = "PriceClass_100"

  origin {
    domain_name = aws_lb.main.dns_name
    origin_id   = "hosted-path-alb"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id         = "hosted-path-alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
    # CloudFront ignores this field for its default certificate and reports TLSv1.
    minimum_protocol_version = "TLSv1"
  }
}

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_dynamodb_table" "control_plane" {
  name         = "${local.name}-state"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAtSeconds"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }
}

resource "aws_cloudwatch_log_group" "control_plane" {
  name              = "/ecs/${local.name}/control-plane"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "relay" {
  name              = "/ecs/${local.name}/relay"
  retention_in_days = 14
}

resource "aws_iam_role" "execution" {
  name = "${local.name}-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "runtime_secret" {
  name = "runtime-secret"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue"]
      Resource = [
        data.aws_secretsmanager_secret.runtime.arn,
        data.aws_secretsmanager_secret.witness_keys.arn
      ]
    }]
  })
}

resource "aws_iam_role" "control_plane_task" {
  name = "${local.name}-control-plane-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "control_plane_state" {
  name = "control-plane-state"
  role = aws_iam_role.control_plane_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem"
      ]
      Resource = aws_dynamodb_table.control_plane.arn
    }]
  })
}

resource "aws_ecs_task_definition" "control_plane" {
  family                   = "${local.name}-control-plane"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.control_plane_task.arn

  container_definitions = jsonencode([{
    name                   = "control-plane"
    image                  = "${aws_ecr_repository.control_plane.repository_url}:${var.image_tag}"
    essential              = true
    readonlyRootFilesystem = true
    portMappings           = [{ containerPort = 8080, hostPort = 8080, protocol = "tcp" }]
    environment = [
      { name = "AXL_ENVIRONMENT", value = "deployment-test" },
      { name = "AXL_TEST_RELAY_URL", value = "wss://${aws_cloudfront_distribution.main.domain_name}/v1/connect" },
      { name = "AXL_TICKET_TABLE", value = aws_dynamodb_table.control_plane.name }
    ]
    secrets = [
      { name = "AXL_TEST_ACCOUNT_ID", valueFrom = "${data.aws_secretsmanager_secret.runtime.arn}:accountId::" },
      { name = "AXL_TEST_INSTALLATION_ID", valueFrom = "${data.aws_secretsmanager_secret.runtime.arn}:installationId::" },
      { name = "AXL_TEST_DEVICE_ID", valueFrom = "${data.aws_secretsmanager_secret.runtime.arn}:deviceId::" },
      { name = "AXL_TEST_PUBLIC_TOKEN", valueFrom = "${data.aws_secretsmanager_secret.runtime.arn}:publicToken::" },
      { name = "AXL_TEST_RELAY_TOKEN", valueFrom = "${data.aws_secretsmanager_secret.runtime.arn}:relayToken::" },
      { name = "AXL_TEST_POSSESSION_PROOF", valueFrom = "${data.aws_secretsmanager_secret.runtime.arn}:possessionProof::" },
      { name = "AXL_TEST_WITNESS_KEYS", valueFrom = data.aws_secretsmanager_secret.witness_keys.arn }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.control_plane.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "service"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "relay" {
  family                   = "${local.name}-relay"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([{
    name                   = "relay"
    image                  = "${aws_ecr_repository.relay.repository_url}:${var.image_tag}"
    essential              = true
    readonlyRootFilesystem = true
    portMappings           = [{ containerPort = 4000, hostPort = 4000, protocol = "tcp" }]
    environment = [
      { name = "AXL_ENVIRONMENT", value = "deployment-test" },
      { name = "AXL_TEST_CONTROL_PLANE_ORIGIN", value = "https://${aws_cloudfront_distribution.main.domain_name}" }
    ]
    secrets = [
      { name = "AXL_TEST_RELAY_TOKEN", valueFrom = "${data.aws_secretsmanager_secret.runtime.arn}:relayToken::" },
      { name = "AXL_TEST_CONTROL_TOKEN", valueFrom = "${data.aws_secretsmanager_secret.runtime.arn}:controlToken::" },
      { name = "AXL_TEST_RELAY_INSTANCE_ID", valueFrom = "${data.aws_secretsmanager_secret.runtime.arn}:relayInstanceId::" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.relay.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "service"
      }
    }
  }])
}

resource "aws_ecs_service" "control_plane" {
  name            = "control-plane"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.control_plane.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.control_plane.arn
    container_name   = "control-plane"
    container_port   = 8080
  }

  depends_on = [aws_lb_listener.http]
}

resource "aws_ecs_service" "relay" {
  name            = "relay"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.relay.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.relay.arn
    container_name   = "relay"
    container_port   = 4000
  }

  depends_on = [aws_lb_listener_rule.relay]
}
