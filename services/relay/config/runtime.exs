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

  if required.("AXL_ENVIRONMENT") != "deployment-test" do
    raise "The deployment-test relay cannot run as a production environment"
  end

  relay_token = required.("AXL_TEST_RELAY_TOKEN")
  control_token = required.("AXL_TEST_CONTROL_TOKEN")
  control_plane_origin = required.("AXL_TEST_CONTROL_PLANE_ORIGIN")
  relay_instance_id = required.("AXL_TEST_RELAY_INSTANCE_ID")
  port = String.to_integer(System.get_env("PORT", "4000"))

  config :axl_relay,
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
      internal_authenticator: AxlRelay.DeploymentTestAuthenticator,
      internal_authenticator_options: [token: control_token]
    ]
end
