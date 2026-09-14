# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

defmodule AxlRelay.HostedPathTestAuthenticator do
  @behaviour AxlRelay.InternalAuthenticator

  @impl true
  def authenticate(connection, _body, _options) do
    Plug.Conn.get_req_header(connection, "authorization") == ["Bearer internal-fixture"]
  end
end

port = System.fetch_env!("AXL_RELAY_TEST_PORT") |> String.to_integer()
control_plane_origin = System.fetch_env!("AXL_CONTROL_PLANE_TEST_ORIGIN")

{:ok, _listener} =
  AxlRelay.Listener.start_link(
    scheme: :http,
    port: port,
    ip: {127, 0, 0, 1},
    connection_options: [
      control_plane: AxlRelay.HttpControlPlaneClient,
      control_plane_options: [
        origin: control_plane_origin,
        headers: [{~c"authorization", ~c"Bearer internal-fixture"}],
        allow_insecure_loopback_for_tests: true
      ],
      relay_instance_id: "hosted-path-test",
      registry: AxlRelay.RouteRegistry
    ],
    internal_authenticator: AxlRelay.HostedPathTestAuthenticator,
    registry: AxlRelay.RouteRegistry
  )

IO.puts("AXL_RELAY_TEST_READY")
Process.sleep(:infinity)
