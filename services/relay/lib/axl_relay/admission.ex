# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

defmodule AxlRelay.Admission do
  @moduledoc "Parses the bounded, pre-routing WebSocket admission message."

  @max_message_bytes 4_096
  @required_keys MapSet.new([
                   "version",
                   "ticket",
                   "connectionNonce",
                   "possessionProof"
                 ])

  @spec parse(binary()) :: {:ok, map()} | {:error, :bad_frame}
  def parse(message) when is_binary(message) and byte_size(message) <= @max_message_bytes do
    with {:ok, decoded} <- decode_json(message),
         true <- is_map(decoded),
         true <- MapSet.new(Map.keys(decoded)) == @required_keys,
         1 <- decoded["version"],
         ticket when is_binary(ticket) and byte_size(ticket) in 1..1024 <- decoded["ticket"],
         nonce when is_binary(nonce) and byte_size(nonce) in 1..256 <- decoded["connectionNonce"],
         proof when is_binary(proof) <- decoded["possessionProof"],
         {:ok, proof_bytes} <- Base.decode64(proof),
         true <- byte_size(proof_bytes) <= 1_024,
         ^proof <- Base.encode64(proof_bytes) do
      {:ok,
       %{
         "ticket" => ticket,
         "connectionNonce" => nonce,
         "possessionProof" => proof
       }}
    else
      _other -> {:error, :bad_frame}
    end
  end

  def parse(_message), do: {:error, :bad_frame}

  defp decode_json(message) do
    {:ok, :json.decode(message)}
  catch
    _kind, _reason -> {:error, :bad_frame}
  end
end

defmodule AxlRelay.ControlPlaneClient do
  @moduledoc "Injected fail-closed boundary for atomic ticket consumption."

  @callback consume_ticket(map(), String.t(), keyword()) ::
              {:ok, map()} | {:error, atom()}
end
