# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

defmodule AxlRelay.HttpControlPlaneClient do
  @moduledoc "HTTP implementation of the authenticated control-plane admission boundary."

  @behaviour AxlRelay.ControlPlaneClient

  @impl true
  def consume_ticket(admission, relay_instance_id, options) do
    with {:ok, origin} <- Keyword.fetch(options, :origin),
         true <- valid_origin?(origin),
         {:ok, headers} when headers != [] <- Keyword.fetch(options, :headers),
         body <-
           :json.encode(%{
             "version" => 1,
             "ticket" => admission["ticket"],
             "relayInstanceId" => relay_instance_id,
             "connectionNonce" => admission["connectionNonce"],
             "possessionProof" => admission["possessionProof"]
           })
           |> IO.iodata_to_binary(),
         {:ok, response} <- post(origin, headers, body),
         {:ok, result} <- validate_result(response) do
      {:ok, result}
    else
      {:error, code} when is_atom(code) -> {:error, code}
      _other -> {:error, :service_unavailable}
    end
  end

  defp valid_origin?(origin) when is_binary(origin) do
    case URI.parse(origin) do
      %URI{scheme: "https", host: host, path: path, query: nil, fragment: nil, userinfo: nil}
      when is_binary(host) and path in [nil, ""] ->
        true

      _other ->
        false
    end
  end

  defp valid_origin?(_origin), do: false

  defp post(origin, headers, body) do
    url = String.to_charlist(origin <> "/internal/v1/relay/tickets/consume")
    request_headers = [{~c"content-type", ~c"application/json"} | headers]
    request = {url, request_headers, ~c"application/json", body}

    case :httpc.request(:post, request, [timeout: 5_000, connect_timeout: 3_000],
           body_format: :binary
         ) do
      {:ok, {{_http, 200, _reason}, _headers, response}} ->
        decode_json(response)

      {:ok, {{_http, status, _reason}, _headers, response}} when status in [401, 409] ->
        decode_error(response)

      _other ->
        {:error, :service_unavailable}
    end
  end

  defp decode_json(body) do
    {:ok, :json.decode(body)}
  catch
    _kind, _reason -> {:error, :service_unavailable}
  end

  defp decode_error(body) do
    with {:ok, %{"error" => %{"code" => code}}} <- decode_json(body),
         mapped when not is_nil(mapped) <-
           Map.get(
             %{
               "unauthorized" => :unauthorized,
               "ticket_expired" => :ticket_expired,
               "ticket_consumed" => :ticket_consumed,
               "ticket_revoked" => :ticket_revoked
             },
             code
           ) do
      {:error, mapped}
    else
      _other -> {:error, :service_unavailable}
    end
  end

  @doc false
  def validate_result(result) when is_map(result) do
    required =
      MapSet.new([
        "version",
        "installationId",
        "sourceRouteId",
        "role",
        "grantGeneration",
        "leaseExpiresAt",
        "limits"
      ])

    allowed = MapSet.put(required, "deviceId")
    keys = MapSet.new(Map.keys(result))

    with true <- MapSet.subset?(required, keys) and MapSet.subset?(keys, allowed),
         1 <- result["version"],
         true <- uuid?(result["installationId"]),
         true <- uuid?(result["sourceRouteId"]),
         role when role in ["daemon", "device"] <- result["role"],
         true <- valid_device?(role, result["deviceId"]),
         generation when is_integer(generation) and generation > 0 <- result["grantGeneration"],
         lease when is_integer(lease) and lease >= 0 <- result["leaseExpiresAt"],
         {:ok, limits} <- validate_limits(result["limits"]) do
      {:ok,
       %{
         installation_id: result["installationId"],
         device_id: result["deviceId"],
         source_route_id: result["sourceRouteId"],
         role: String.to_existing_atom(role),
         grant_generation: generation,
         lease_expires_at: lease,
         limits: limits
       }}
    else
      _other -> {:error, :service_unavailable}
    end
  end

  def validate_result(_result), do: {:error, :service_unavailable}

  defp validate_limits(limits) when is_map(limits) do
    keys =
      MapSet.new([
        "maxFrameBytes",
        "maxQueuedBytes",
        "heartbeatIntervalMs",
        "idleTimeoutMs"
      ])

    with ^keys <- MapSet.new(Map.keys(limits)),
         frame when is_integer(frame) and frame in 1..65_535 <- limits["maxFrameBytes"],
         queued when is_integer(queued) and queued in 1..524_288 <- limits["maxQueuedBytes"],
         heartbeat when is_integer(heartbeat) and heartbeat in 1..300_000 <-
           limits["heartbeatIntervalMs"],
         idle when is_integer(idle) and idle in 1..600_000 <- limits["idleTimeoutMs"] do
      {:ok,
       %{
         max_frame_bytes: frame,
         max_queued_bytes: queued,
         heartbeat_interval_ms: heartbeat,
         idle_timeout_ms: idle
       }}
    else
      _other -> {:error, :service_unavailable}
    end
  end

  defp validate_limits(_limits), do: {:error, :service_unavailable}

  defp valid_device?("daemon", nil), do: true
  defp valid_device?("device", value), do: uuid?(value)
  defp valid_device?(_role, _value), do: false

  defp uuid?(value) when is_binary(value) do
    Regex.match?(
      ~r/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      value
    )
  end

  defp uuid?(_value), do: false
end
