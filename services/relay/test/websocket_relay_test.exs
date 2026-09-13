# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

defmodule AxlRelay.WebSocketRelayTest do
  use ExUnit.Case, async: false

  alias AxlRelay.{Connection, Frame, Listener, RouteRegistry}

  @daemon_route "11111111-1111-4111-8111-111111111111"
  @device_route "22222222-2222-4222-8222-222222222222"
  @attempt "33333333-3333-4333-8333-333333333333"

  defmodule FakeControlPlane do
    @behaviour AxlRelay.ControlPlaneClient

    @impl true
    def consume_ticket(%{"ticket" => "unavailable"}, _relay_instance_id, _options),
      do: {:error, :service_unavailable}

    def consume_ticket(%{"ticket" => "half-open"}, _relay_instance_id, options) do
      {:ok,
       %{
         installation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
         device_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
         source_route_id: Keyword.fetch!(options, :device),
         role: :device,
         grant_generation: 1,
         lease_expires_at: System.system_time(:millisecond) + 60_000,
         limits: %{
           max_frame_bytes: 65_535,
           max_queued_bytes: 524_288,
           heartbeat_interval_ms: 10,
           idle_timeout_ms: 30
         }
       }}
    end

    def consume_ticket(%{"ticket" => ticket}, _relay_instance_id, options)
        when ticket in ["daemon", "device"] do
      role = if ticket == "daemon", do: :daemon, else: :device
      route_id = Keyword.fetch!(options, role)

      {:ok,
       %{
         installation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
         device_id:
           if(ticket == "device",
             do: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
             else: nil
           ),
         source_route_id: route_id,
         role: role,
         grant_generation: 1,
         lease_expires_at: System.system_time(:millisecond) + 60_000,
         limits: %{
           max_frame_bytes: 65_535,
           max_queued_bytes: 524_288,
           heartbeat_interval_ms: 20_000,
           idle_timeout_ms: 60_000
         }
       }}
    end
  end

  defmodule FakeInternalAuthenticator do
    @behaviour AxlRelay.InternalAuthenticator

    @impl true
    def authenticate(connection, _body, _options) do
      Plug.Conn.get_req_header(connection, "authorization") == ["Bearer internal-fixture"]
    end
  end

  setup do
    registry = start_supervised!({RouteRegistry, name: nil})
    port = free_port()

    listener =
      start_supervised!(
        {Listener,
         scheme: :http,
         port: port,
         ip: {127, 0, 0, 1},
         connection_options: [
           control_plane: FakeControlPlane,
           control_plane_options: [daemon: @daemon_route, device: @device_route],
           relay_instance_id: "relay-test",
           registry: registry
         ],
         internal_authenticator: FakeInternalAuthenticator,
         registry: registry}
      )

    %{listener: listener, registry: registry, port: port}
  end

  test "admits two sockets and routes an opaque frame with distinct receipts", %{
    registry: registry,
    port: port
  } do
    daemon = connect(port, "daemon")
    device = connect(port, "device")

    assert_eventually(fn -> map_size(RouteRegistry.snapshot(registry).routes) == 2 end)

    expect_discovered_peer(daemon, @daemon_route, "device", @device_route)
    expect_discovered_peer(device, @device_route, "daemon", @daemon_route)

    assert {:ok, send_frame} =
             Frame.encode(%{
               kind: :send,
               attempt_id: @attempt,
               route_id: @daemon_route,
               payload: <<0, 1, 2, 255>>
             })

    :ok = :gen_tcp.send(device, client_binary_frame(send_frame))

    assert {:ok, admitted} = device |> receive_binary_frame() |> Frame.decode()
    assert admitted == %{kind: :receipt, attempt_id: @attempt, status: :admitted}

    assert {:ok, forwarded} = device |> receive_binary_frame() |> Frame.decode()
    assert forwarded == %{kind: :receipt, attempt_id: @attempt, status: :forwarded}

    assert {:ok, delivery} = daemon |> receive_binary_frame() |> Frame.decode()

    assert delivery == %{
             kind: :delivery,
             attempt_id: @attempt,
             route_id: @device_route,
             payload: <<0, 1, 2, 255>>
           }

    :gen_tcp.close(device)
    :gen_tcp.close(daemon)
  end

  test "closes a half-open connection after the explicit inbound idle deadline" do
    registry =
      start_supervised!(Supervisor.child_spec({RouteRegistry, name: nil}, id: make_ref()))

    {:ok, state} =
      Connection.init(
        control_plane: FakeControlPlane,
        control_plane_options: [device: @device_route],
        relay_instance_id: "relay-test",
        registry: registry
      )

    admission =
      :json.encode(%{
        "version" => 1,
        "ticket" => "half-open",
        "connectionNonce" => "fixture-nonce",
        "possessionProof" => "AAECA/8="
      })
      |> IO.iodata_to_binary()

    assert {:ok, active} = Connection.handle_in({admission, opcode: :binary}, state)
    Process.sleep(35)

    assert {:stop, :normal, {1008, "idle_timeout"}, _state} =
             Connection.handle_info(:heartbeat, active)
  end

  test "fails admission closed when the control plane is unavailable", %{
    registry: registry,
    port: port
  } do
    socket = connect(port, "unavailable")
    {:ok, <<0x88, _length>>} = :gen_tcp.recv(socket, 2, 2_000)
    assert RouteRegistry.snapshot(registry).routes == %{}
    :gen_tcp.close(socket)
  end

  test "rejects unauthenticated revocation and applies an authenticated notification", %{
    registry: registry,
    port: port
  } do
    route = "44444444-4444-4444-8444-444444444444"

    assert :ok =
             RouteRegistry.register(registry, self(), %{
               installation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
               device_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
               role: :device,
               grant_generation: 1,
               source_route_id: route,
               limits: %{max_queued_bytes: 524_288}
             })

    body =
      :json.encode(%{
        "version" => 1,
        "installationId" => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "deviceId" => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "generation" => 1,
        "effectiveAt" => 1_900_000_000_000
      })
      |> IO.iodata_to_binary()

    url = ~c"http://127.0.0.1:#{port}/internal/v1/revocations"

    assert {:ok, {{_version, 401, _reason}, _headers, _response}} =
             :httpc.request(:post, {url, [], ~c"application/json", body}, [], [])

    headers = [{~c"authorization", ~c"Bearer internal-fixture"}]

    assert {:ok, {{_version, 200, _reason}, _headers, response}} =
             :httpc.request(:post, {url, headers, ~c"application/json", body}, [],
               body_format: :binary
             )

    assert :json.decode(response) == %{"version" => 1, "accepted" => true}
    assert_receive :route_revoked
  end

  defp free_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, ip: {127, 0, 0, 1}])
    {:ok, {_address, port}} = :inet.sockname(socket)
    :gen_tcp.close(socket)
    port
  end

  defp connect(port, ticket) do
    {:ok, socket} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false])

    request = [
      "GET /v1/connect HTTP/1.1\r\n",
      "Host: 127.0.0.1:",
      Integer.to_string(port),
      "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n",
      "Sec-WebSocket-Key: AAECAwQFBgcICQoLDA0ODw==\r\n",
      "Sec-WebSocket-Version: 13\r\n\r\n"
    ]

    :ok = :gen_tcp.send(socket, request)
    {:ok, response} = :gen_tcp.recv(socket, 0, 2_000)
    assert String.starts_with?(response, "HTTP/1.1 101")

    admission =
      :json.encode(%{
        "version" => 1,
        "ticket" => ticket,
        "connectionNonce" => "fixture-nonce",
        "possessionProof" => "AAECA/8="
      })
      |> IO.iodata_to_binary()

    :ok = :gen_tcp.send(socket, client_binary_frame(admission))
    socket
  end

  defp client_binary_frame(payload) do
    mask = <<1, 2, 3, 4>>

    encoded_length =
      if byte_size(payload) < 126,
        do: <<0x80 + byte_size(payload)>>,
        else: <<0x80 + 126, byte_size(payload)::unsigned-big-16>>

    masked =
      payload
      |> :binary.bin_to_list()
      |> Enum.with_index()
      |> Enum.map(fn {byte, index} -> Bitwise.bxor(byte, :binary.at(mask, rem(index, 4))) end)
      |> :binary.list_to_bin()

    <<0x82, encoded_length::binary, mask::binary, masked::binary>>
  end

  defp expect_discovered_peer(socket, source_route, peer_role, peer_route) do
    assert %{
             "type" => "route_snapshot",
             "sourceRoute" => %{"routeId" => ^source_route},
             "peers" => peers
           } = receive_json_message(socket)

    if peers == [] do
      assert %{
               "type" => "route_available",
               "peers" => [%{"role" => ^peer_role, "routeId" => ^peer_route}]
             } =
               receive_json_message(socket)
    else
      assert [%{"role" => ^peer_role, "routeId" => ^peer_route}] = peers
    end
  end

  defp receive_json_message(socket) do
    socket |> receive_binary_frame() |> :json.decode()
  end

  defp receive_binary_frame(socket) do
    {:ok, <<0x82, length>>} = :gen_tcp.recv(socket, 2, 2_000)

    size =
      case length do
        value when value < 126 ->
          value

        126 ->
          {:ok, <<value::unsigned-big-16>>} = :gen_tcp.recv(socket, 2, 2_000)
          value
      end

    {:ok, payload} = :gen_tcp.recv(socket, size, 2_000)
    payload
  end

  defp assert_eventually(assertion, attempts \\ 40)

  defp assert_eventually(assertion, attempts) when attempts > 0 do
    if assertion.() do
      :ok
    else
      Process.sleep(5)
      assert_eventually(assertion, attempts - 1)
    end
  end

  defp assert_eventually(_assertion, 0), do: flunk("condition did not become true")
end
