# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

defmodule AxlRelay.InternalAuthenticator do
  @moduledoc "Injected authentication boundary for control-plane callbacks."

  @callback authenticate(Plug.Conn.t(), binary(), keyword()) :: boolean()
end

defmodule AxlRelay.RevocationHandler do
  @moduledoc "Runtime validation for best-effort route revocation."

  @doc false
  def parse_notification(body) do
    with decoded when is_map(decoded) <- :json.decode(body),
         required <- MapSet.new(["version", "installationId", "generation", "effectiveAt"]),
         allowed <- MapSet.put(required, "deviceId"),
         keys <- MapSet.new(Map.keys(decoded)),
         true <- MapSet.subset?(required, keys) and MapSet.subset?(keys, allowed),
         1 <- decoded["version"],
         true <- uuid?(decoded["installationId"]),
         true <- is_nil(decoded["deviceId"]) or uuid?(decoded["deviceId"]),
         generation when is_integer(generation) and generation > 0 <- decoded["generation"],
         effective_at when is_integer(effective_at) and effective_at >= 0 <-
           decoded["effectiveAt"] do
      {:ok,
       %{
         installation_id: decoded["installationId"],
         device_id: decoded["deviceId"],
         generation: generation,
         effective_at: effective_at
       }}
    else
      _other -> {:error, :bad_request}
    end
  catch
    _kind, _reason -> {:error, :bad_request}
  end

  defp uuid?(value) when is_binary(value) do
    Regex.match?(
      ~r/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      value
    )
  end

  defp uuid?(_value), do: false
end
