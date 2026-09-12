# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

defmodule AxlRelay.RouteRegistryTest do
  use ExUnit.Case, async: true

  alias AxlRelay.RouteRegistry

  @installation "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  @source "11111111-1111-4111-8111-111111111111"
  @destination "22222222-2222-4222-8222-222222222222"
  @attempt "33333333-3333-4333-8333-333333333333"

  setup do
    registry = start_supervised!({RouteRegistry, name: nil})
    parent = self()

    source = spawn_link(fn -> forward_messages(parent, :source) end)
    destination = spawn_link(fn -> forward_messages(parent, :destination) end)

    limits = %{max_queued_bytes: 50}

    assert :ok =
             RouteRegistry.register(registry, source, %{
               installation_id: @installation,
               device_id: nil,
               source_route_id: @source,
               limits: limits
             })

    assert :ok =
             RouteRegistry.register(registry, destination, %{
               installation_id: @installation,
               device_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
               source_route_id: @destination,
               limits: limits
             })

    %{registry: registry, destination: destination, source: source}
  end

  test "routes only inside one installation and bounds pending bytes", %{registry: registry} do
    assert :ok = RouteRegistry.forward(registry, @source, @destination, @attempt, <<1, 2, 3>>)

    assert_receive {:destination, {:relay_delivery, @source, @attempt, <<1, 2, 3>>, 45}}

    assert {:error, :queue_full} =
             RouteRegistry.forward(registry, @source, @destination, @attempt, <<1, 2, 3>>)

    RouteRegistry.delivered(registry, @destination, 45)

    assert_eventually(fn ->
      RouteRegistry.snapshot(registry).routes[@destination].queued_bytes == 0
    end)

    other_route = "44444444-4444-4444-8444-444444444444"
    parent = self()
    other = spawn_link(fn -> forward_messages(parent, :other) end)

    assert :ok =
             RouteRegistry.register(registry, other, %{
               installation_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
               device_id: nil,
               source_route_id: other_route,
               limits: %{max_queued_bytes: 50}
             })

    assert {:error, :forbidden_route} =
             RouteRegistry.forward(registry, @source, other_route, @attempt, <<1>>)
  end

  test "revocation closes matching routes and draining rejects admission", %{registry: registry} do
    assert :ok =
             RouteRegistry.revoke(registry, %{
               installation_id: @installation,
               device_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
               generation: 1
             })

    assert_receive {:destination, :route_revoked}
    refute Map.has_key?(RouteRegistry.snapshot(registry).routes, @destination)

    assert :ok = RouteRegistry.drain(registry)
    assert_receive {:source, :relay_draining}

    assert {:error, :service_unavailable} =
             RouteRegistry.register(registry, self(), %{
               installation_id: @installation,
               device_id: nil,
               source_route_id: "55555555-5555-4555-8555-555555555555",
               limits: %{max_queued_bytes: 50}
             })
  end

  defp forward_messages(parent, label) do
    receive do
      message ->
        send(parent, {label, message})
        forward_messages(parent, label)
    end
  end

  defp assert_eventually(assertion, attempts \\ 20)

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
