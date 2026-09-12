# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

defmodule AxlRelay.Connection do
  @moduledoc "Ticket-admitted WebSock handler for opaque relay frames."

  @behaviour WebSock

  alias AxlRelay.{Admission, Frame, RouteRegistry}

  @admission_timeout_ms 5_000
  @rate_window_ms 10_000
  @max_frames_per_window 100

  @impl true
  def init(options) do
    Process.send_after(self(), :admission_timeout, @admission_timeout_ms)

    {:ok,
     %{
       phase: :awaiting_admission,
       control_plane: Keyword.fetch!(options, :control_plane),
       control_plane_options: Keyword.get(options, :control_plane_options, []),
       relay_instance_id: Keyword.fetch!(options, :relay_instance_id),
       registry: Keyword.get(options, :registry, RouteRegistry),
       route_id: nil,
       limits: nil,
       rate_window_started: System.monotonic_time(:millisecond),
       rate_frames: 0,
       rate_bytes: 0
     }}
  end

  @impl true
  def handle_in({message, opcode: :binary}, %{phase: :awaiting_admission} = state) do
    with {:ok, admission} <- Admission.parse(message),
         {:ok, result} <-
           state.control_plane.consume_ticket(
             admission,
             state.relay_instance_id,
             state.control_plane_options
           ),
         true <- result.lease_expires_at > System.system_time(:millisecond),
         :ok <- RouteRegistry.register(state.registry, self(), result) do
      Process.send_after(self(), :heartbeat, result.limits.heartbeat_interval_ms)

      Process.send_after(
        self(),
        :lease_expired,
        result.lease_expires_at - System.system_time(:millisecond)
      )

      {:ok, %{state | phase: :active, route_id: result.source_route_id, limits: result.limits}}
    else
      {:error, code} -> close(code, state)
      false -> close(:ticket_expired, state)
      _other -> close(:service_unavailable, state)
    end
  end

  def handle_in({message, opcode: :binary}, %{phase: :active} = state) do
    with true <- byte_size(message) <= state.limits.max_frame_bytes,
         {:ok, %{kind: :send} = frame} <- Frame.decode(message),
         {:ok, rate_state} <- rate_limit(state, byte_size(message)) do
      admitted = receipt(frame.attempt_id, :admitted)

      case RouteRegistry.forward(
             state.registry,
             state.route_id,
             frame.route_id,
             frame.attempt_id,
             frame.payload
           ) do
        :ok ->
          {:push, [binary: admitted, binary: receipt(frame.attempt_id, :forwarded)], rate_state}

        {:error, code} ->
          {:push, [binary: admitted, binary: failure(frame.attempt_id, code)], rate_state}
      end
    else
      {:error, :rate_limited} -> close(:rate_limited, state)
      _other -> close(:bad_frame, state)
    end
  end

  def handle_in(_frame, state), do: close(:bad_frame, state)

  @impl true
  def handle_control({_payload, opcode: opcode}, state) when opcode in [:ping, :pong],
    do: {:ok, state}

  @impl true
  def handle_info(
        {:relay_delivery, source_route_id, attempt_id, payload, queued_bytes},
        %{phase: :active} = state
      ) do
    encoded =
      encode!(%{
        kind: :delivery,
        attempt_id: attempt_id,
        route_id: source_route_id,
        payload: payload
      })

    send(self(), {:delivery_handed_to_socket, queued_bytes})
    {:push, {:binary, encoded}, state}
  end

  def handle_info({:delivery_handed_to_socket, queued_bytes}, %{phase: :active} = state) do
    RouteRegistry.delivered(state.registry, state.route_id, queued_bytes)
    {:ok, state}
  end

  def handle_info(:heartbeat, %{phase: :active} = state) do
    Process.send_after(self(), :heartbeat, state.limits.heartbeat_interval_ms)
    {:push, {:ping, <<>>}, state}
  end

  def handle_info(:lease_expired, state), do: close(:unauthorized, state)
  def handle_info(:route_revoked, state), do: close(:unauthorized, state)
  def handle_info(:relay_draining, state), do: close(:service_unavailable, state)

  def handle_info(:admission_timeout, %{phase: :awaiting_admission} = state),
    do: close(:unauthorized, state)

  def handle_info(:admission_timeout, state), do: {:ok, state}
  def handle_info(_message, state), do: {:ok, state}

  @impl true
  def terminate(_reason, %{route_id: nil}), do: :ok

  def terminate(_reason, state) do
    RouteRegistry.unregister(state.registry, state.route_id)
    :ok
  end

  defp rate_limit(state, bytes) do
    now = System.monotonic_time(:millisecond)

    current =
      if now - state.rate_window_started >= @rate_window_ms do
        %{state | rate_window_started: now, rate_frames: 0, rate_bytes: 0}
      else
        state
      end

    max_bytes = current.limits.max_frame_bytes * @max_frames_per_window

    if current.rate_frames + 1 > @max_frames_per_window or current.rate_bytes + bytes > max_bytes do
      {:error, :rate_limited}
    else
      {:ok,
       %{
         current
         | rate_frames: current.rate_frames + 1,
           rate_bytes: current.rate_bytes + bytes
       }}
    end
  end

  defp receipt(attempt_id, status) do
    encode!(%{kind: :receipt, attempt_id: attempt_id, status: status})
  end

  defp failure(attempt_id, code) do
    encode!(%{kind: :failure, attempt_id: attempt_id, code: code})
  end

  defp encode!(frame) do
    {:ok, encoded} = Frame.encode(frame)
    encoded
  end

  defp close(code, state),
    do: {:stop, :normal, {1008, Atom.to_string(code)}, state}
end
