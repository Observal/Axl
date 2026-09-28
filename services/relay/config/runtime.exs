# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

import Config

if config_env() == :prod do
  required = fn name ->
    case System.get_env(name) do
      value when is_binary(value) and byte_size(value) > 0 -> value
      _other -> raise "#{name} is required"
    end
  end

  # The relay carries only opaque frames and holds only service credentials, so the same relay
  # serves both control-plane modes; the deployment-test mode keeps its AXL_TEST_ setting names.
  environment = required.("AXL_ENVIRONMENT")

  unless environment in ["deployment-test", "production"] do
    raise "AXL_ENVIRONMENT must be deployment-test or production"
  end

  setting = fn name ->
    required.(if environment == "production", do: "AXL_" <> name, else: "AXL_TEST_" <> name)
  end

  relay_token = setting.("RELAY_TOKEN")
  control_token = setting.("CONTROL_TOKEN")
  control_plane_origin = setting.("CONTROL_PLANE_ORIGIN")
  relay_instance_id = setting.("RELAY_INSTANCE_ID")
  port = String.to_integer(System.get_env("PORT", "4000"))

  config :axl_relay,
    mode: environment,
    listener_options: [
      scheme: :http,
      ip: {0, 0, 0, 0},
      port: port,
      connection_options: [
        control_plane: AxlRelay.HttpControlPlaneClient,
        relay_instance_id: relay_instance_id,
        control_plane_options: [
          origin: control_plane_origin,
          headers: [{~c"authorization", String.to_charlist("Bearer " <> relay_token)}],
          allow_insecure_loopback_for_tests:
            String.starts_with?(control_plane_origin, "http://127.0.0.1")
        ]
      ],
      internal_authenticator: AxlRelay.ServiceTokenAuthenticator,
      internal_authenticator_options: [token: control_token]
    ]
end
