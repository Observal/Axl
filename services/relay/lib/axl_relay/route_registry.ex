# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

defmodule AxlRelay.RouteRegistry do
  @moduledoc "In-memory, installation-scoped route table with bounded pending bytes."

  use GenServer

  @type admission :: %{
          installation_id: String.t(),
          device_id: String.t() | nil,
          source_route_id: String.t(),
          limits: %{max_queued_bytes: pos_integer()}
        }

  def start_link(options \\ []) do
    case Keyword.get(options, :name, __MODULE__) do
      nil -> GenServer.start_link(__MODULE__, options)
      name -> GenServer.start_link(__MODULE__, options, name: name)
    end
  end

  def register(server \\ __MODULE__, pid, admission) do
    GenServer.call(server, {:register, pid, admission})
  end

  def unregister(server \\ __MODULE__, route_id) do
    GenServer.call(server, {:unregister, route_id})
  end

  def forward(server \\ __MODULE__, source_route_id, destination_route_id, attempt_id, payload) do
    GenServer.call(
      server,
      {:forward, source_route_id, destination_route_id, attempt_id, payload}
    )
  end

  def delivered(server \\ __MODULE__, route_id, bytes) do
    GenServer.cast(server, {:delivered, route_id, bytes})
  end

  def revoke(server \\ __MODULE__, notification) do
    GenServer.call(server, {:revoke, notification})
  end

  def drain(server \\ __MODULE__) do
    GenServer.call(server, :drain)
  end

  def snapshot(server \\ __MODULE__) do
    GenServer.call(server, :snapshot)
  end

  @impl true
  def init(_options) do
    {:ok, %{routes: %{}, monitors: %{}, generations: %{}, draining: false}}
  end

  @impl true
  def handle_call({:register, _pid, _admission}, _from, %{draining: true} = state) do
    {:reply, {:error, :service_unavailable}, state}
  end

  def handle_call({:register, pid, admission}, _from, state) do
    route_id = admission.source_route_id

    if Map.has_key?(state.routes, route_id) do
      {:reply, {:error, :forbidden_route}, state}
    else
      monitor = Process.monitor(pid)
      route = Map.merge(admission, %{pid: pid, monitor: monitor, queued_bytes: 0})

      {:reply, :ok,
       %{
         state
         | routes: Map.put(state.routes, route_id, route),
           monitors: Map.put(state.monitors, monitor, route_id)
       }}
    end
  end

  def handle_call({:unregister, route_id}, _from, state) do
    {:reply, :ok, remove_route(state, route_id)}
  end

  def handle_call(
        {:forward, source_route_id, destination_route_id, attempt_id, payload},
        _from,
        state
      ) do
    source = state.routes[source_route_id]
    destination = state.routes[destination_route_id]
    queued_bytes = byte_size(payload) + 42

    cond do
      source == nil ->
        {:reply, {:error, :unauthorized}, state}

      destination == nil ->
        {:reply, {:error, :destination_offline}, state}

      source.installation_id != destination.installation_id ->
        {:reply, {:error, :forbidden_route}, state}

      destination.queued_bytes + queued_bytes > destination.limits.max_queued_bytes ->
        {:reply, {:error, :queue_full}, state}

      true ->
        send(
          destination.pid,
          {:relay_delivery, source_route_id, attempt_id, payload, queued_bytes}
        )

        next_state =
          put_in(
            state,
            [:routes, destination_route_id, :queued_bytes],
            destination.queued_bytes + queued_bytes
          )

        {:reply, :ok, next_state}
    end
  end

  def handle_call({:revoke, notification}, _from, state) do
    key = {notification.installation_id, notification.device_id || :all}
    previous = Map.get(state.generations, key, 0)

    if notification.generation <= previous do
      {:reply, :ok, state}
    else
      matching =
        state.routes
        |> Enum.filter(fn {_route_id, route} ->
          route.installation_id == notification.installation_id and
            (notification.device_id == nil or route.device_id == notification.device_id)
        end)

      Enum.each(matching, fn {_route_id, route} -> send(route.pid, :route_revoked) end)

      next_state =
        Enum.reduce(matching, state, fn {route_id, _route}, current ->
          remove_route(current, route_id)
        end)

      {:reply, :ok,
       %{next_state | generations: Map.put(next_state.generations, key, notification.generation)}}
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
        next_state =
          put_in(state, [:routes, route_id, :queued_bytes], max(0, route.queued_bytes - bytes))

        {:noreply, next_state}
    end
  end

  @impl true
  def handle_info({:DOWN, monitor, :process, _pid, _reason}, state) do
    case Map.pop(state.monitors, monitor) do
      {nil, _monitors} ->
        {:noreply, state}

      {route_id, monitors} ->
        {:noreply, %{state | routes: Map.delete(state.routes, route_id), monitors: monitors}}
    end
  end

  defp remove_route(state, route_id) do
    case Map.pop(state.routes, route_id) do
      {nil, _routes} ->
        state

      {route, routes} ->
        Process.demonitor(route.monitor, [:flush])
        %{state | routes: routes, monitors: Map.delete(state.monitors, route.monitor)}
    end
  end
end
