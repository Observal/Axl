# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

defmodule AxlRelay.RouteRegistry do
  @moduledoc "Role-scoped in-memory routes with bounded pending bytes and eviction."

  use GenServer

  @default_slow_consumer_grace_ms 10_000

  def start_link(options \\ []) do
    case Keyword.get(options, :name, __MODULE__) do
      nil -> GenServer.start_link(__MODULE__, options)
      name -> GenServer.start_link(__MODULE__, options, name: name)
    end
  end

  def register(server \\ __MODULE__, pid, admission),
    do: GenServer.call(server, {:register, pid, admission})

  def unregister(server \\ __MODULE__, route_id),
    do: GenServer.call(server, {:unregister, route_id})

  def forward(server \\ __MODULE__, source_route_id, destination_route_id, attempt_id, payload) do
    GenServer.call(server, {:forward, source_route_id, destination_route_id, attempt_id, payload})
  end

  def delivered(server \\ __MODULE__, route_id, bytes),
    do: GenServer.cast(server, {:delivered, route_id, bytes})

  def revoke(server \\ __MODULE__, notification),
    do: GenServer.call(server, {:revoke, notification})

  def drain(server \\ __MODULE__), do: GenServer.call(server, :drain)
  def snapshot(server \\ __MODULE__), do: GenServer.call(server, :snapshot)

  @impl true
  def init(options) do
    {:ok,
     %{
       routes: %{},
       monitors: %{},
       generations: %{},
       draining: false,
       slow_consumer_grace_ms:
         Keyword.get(options, :slow_consumer_grace_ms, @default_slow_consumer_grace_ms)
     }}
  end

  @impl true
  def handle_call({:register, _pid, _admission}, _from, %{draining: true} = state),
    do: {:reply, {:error, :service_unavailable}, state}

  def handle_call({:register, pid, admission}, _from, state) do
    route_id = admission.source_route_id

    cond do
      Map.has_key?(state.routes, route_id) ->
        {:reply, {:error, :forbidden_route}, state}

      admission.grant_generation <= revoked_generation(state, admission) ->
        {:reply, {:error, :ticket_revoked}, state}

      true ->
        replacements =
          Enum.filter(state.routes, fn {_id, route} -> same_identity?(route, admission) end)

        Enum.each(replacements, fn {_id, route} -> send(route.pid, :route_replaced) end)

        without_replaced =
          Enum.reduce(replacements, state, fn {id, _route}, current ->
            remove_route(current, id, false)
          end)

        monitor = Process.monitor(pid)

        route =
          Map.merge(admission, %{
            pid: pid,
            monitor: monitor,
            queued_bytes: 0,
            saturation_token: nil
          })

        next = %{
          without_replaced
          | routes: Map.put(without_replaced.routes, route_id, route),
            monitors: Map.put(without_replaced.monitors, monitor, route_id)
        }

        peers = visible_peers(next, route)
        send(pid, {:route_snapshot, descriptor(route), Enum.map(peers, &descriptor/1)})
        Enum.each(peers, fn peer -> send(peer.pid, {:route_available, descriptor(route)}) end)
        {:reply, :ok, next}
    end
  end

  def handle_call({:unregister, route_id}, _from, state),
    do: {:reply, :ok, remove_route(state, route_id)}

  def handle_call(
        {:forward, source_route_id, destination_route_id, attempt_id, payload},
        _from,
        state
      ) do
    source = state.routes[source_route_id]
    destination = state.routes[destination_route_id]
    queued_bytes = byte_size(payload) + 38

    cond do
      source == nil ->
        {:reply, {:error, :unauthorized}, state}

      destination == nil ->
        {:reply, {:error, :destination_offline}, state}

      source.installation_id != destination.installation_id or source.role == destination.role ->
        {:reply, {:error, :forbidden_route}, state}

      destination.queued_bytes + queued_bytes > destination.limits.max_queued_bytes ->
        {:reply, {:error, :queue_full}, mark_saturated(state, destination_route_id)}

      true ->
        send(
          destination.pid,
          {:relay_delivery, source_route_id, attempt_id, payload, queued_bytes}
        )

        next_bytes = destination.queued_bytes + queued_bytes
        next = put_in(state, [:routes, destination_route_id, :queued_bytes], next_bytes)

        next =
          if next_bytes >= destination.limits.max_queued_bytes,
            do: mark_saturated(next, destination_route_id),
            else: next

        {:reply, :ok, next}
    end
  end

  def handle_call({:revoke, notification}, _from, state) do
    key = {notification.installation_id, notification.device_id || :all}
    previous = Map.get(state.generations, key, 0)

    if notification.generation <= previous do
      {:reply, :ok, state}
    else
      matching =
        Enum.filter(state.routes, fn {_route_id, route} ->
          route.installation_id == notification.installation_id and
            (notification.device_id == nil or route.device_id == notification.device_id) and
            route.grant_generation <= notification.generation
        end)

      Enum.each(matching, fn {_route_id, route} -> send(route.pid, :route_revoked) end)

      next =
        Enum.reduce(matching, state, fn {route_id, _route}, current ->
          remove_route(current, route_id)
        end)

      {:reply, :ok,
       %{next | generations: Map.put(next.generations, key, notification.generation)}}
    end
  end

  def handle_call(:drain, _from, state) do
    Enum.each(state.routes, fn {_route_id, route} -> send(route.pid, :relay_draining) end)
    {:reply, :ok, %{state | draining: true}}
  end

  def handle_call(:snapshot, _from, state) do
    routes =
      Map.new(state.routes, fn {route_id, route} ->
        {route_id,
         %{
           installation_id: route.installation_id,
           device_id: route.device_id,
           role: route.role,
           grant_generation: route.grant_generation,
           queued_bytes: route.queued_bytes
         }}
      end)

    {:reply, %{routes: routes, draining: state.draining}, state}
  end

  @impl true
  def handle_cast({:delivered, route_id, bytes}, state) do
    case state.routes[route_id] do
      nil ->
        {:noreply, state}

      route ->
        queued = max(0, route.queued_bytes - bytes)
        next = put_in(state, [:routes, route_id, :queued_bytes], queued)

        next =
          if queued <= div(route.limits.max_queued_bytes, 2) do
            put_in(next, [:routes, route_id, :saturation_token], nil)
          else
            next
          end

        {:noreply, next}
    end
  end

  @impl true
  def handle_info({:slow_consumer_check, route_id, token}, state) do
    case state.routes[route_id] do
      %{saturation_token: ^token} = route ->
        if route.queued_bytes > div(route.limits.max_queued_bytes, 2) do
          send(route.pid, :slow_consumer)
          {:noreply, remove_route(state, route_id)}
        else
          {:noreply, put_in(state, [:routes, route_id, :saturation_token], nil)}
        end

      _other ->
        {:noreply, state}
    end
  end

  def handle_info({:DOWN, monitor, :process, _pid, _reason}, state) do
    case state.monitors[monitor] do
      nil -> {:noreply, state}
      route_id -> {:noreply, remove_route(state, route_id)}
    end
  end

  defp mark_saturated(state, route_id) do
    case state.routes[route_id] do
      nil ->
        state

      %{saturation_token: nil} ->
        token = make_ref()

        Process.send_after(
          self(),
          {:slow_consumer_check, route_id, token},
          state.slow_consumer_grace_ms
        )

        put_in(state, [:routes, route_id, :saturation_token], token)

      _route ->
        state
    end
  end

  defp visible_peers(state, route) do
    state.routes
    |> Map.values()
    |> Enum.filter(fn candidate ->
      candidate.source_route_id != route.source_route_id and
        candidate.installation_id == route.installation_id and candidate.role != route.role
    end)
  end

  defp descriptor(route) do
    %{
      route_id: route.source_route_id,
      role: route.role,
      device_id: route.device_id
    }
  end

  defp same_identity?(left, right) do
    left.installation_id == right.installation_id and left.role == right.role and
      (left.role == :daemon or left.device_id == right.device_id)
  end

  defp revoked_generation(state, admission) do
    all = Map.get(state.generations, {admission.installation_id, :all}, 0)
    device = Map.get(state.generations, {admission.installation_id, admission.device_id}, 0)
    max(all, device)
  end

  defp remove_route(state, route_id, notify \\ true) do
    case Map.pop(state.routes, route_id) do
      {nil, _routes} ->
        state

      {route, routes} ->
        Process.demonitor(route.monitor, [:flush])
        next = %{state | routes: routes, monitors: Map.delete(state.monitors, route.monitor)}

        notify_unavailable(next, route, notify)
        next
    end
  end

  defp notify_unavailable(_state, _route, false), do: :ok

  defp notify_unavailable(state, route, true) do
    Enum.each(visible_peers(state, route), fn peer ->
      send(peer.pid, {:route_unavailable, descriptor(route)})
    end)
  end
end
