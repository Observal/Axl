# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

defmodule AxlRelay.Frame do
  @moduledoc "Bounded transport-v1 framing for opaque relay payloads."

  @magic "AXLR"
  @transport_version 1
  @max_frame_bytes 65_535
  @routed_header_bytes 38
  @max_payload_bytes @max_frame_bytes - @routed_header_bytes
  @failure_codes %{
    1 => :bad_frame,
    2 => :unsupported_transport_version,
    3 => :unauthorized,
    4 => :forbidden_route,
    5 => :ticket_expired,
    6 => :ticket_consumed,
    7 => :destination_offline,
    8 => :rate_limited,
    9 => :queue_full,
    10 => :slow_consumer,
    11 => :service_unavailable
  }

  @type relay_frame ::
          %{
            kind: :send | :delivery,
            attempt_id: String.t(),
            route_id: String.t(),
            payload: binary()
          }
          | %{kind: :receipt, attempt_id: String.t(), status: :admitted | :forwarded}
          | %{kind: :failure, attempt_id: String.t(), code: atom()}

  @spec max_frame_bytes() :: pos_integer()
  def max_frame_bytes, do: @max_frame_bytes

  @spec max_payload_bytes() :: pos_integer()
  def max_payload_bytes, do: @max_payload_bytes

  @spec decode(binary()) :: {:ok, relay_frame()} | {:error, atom()}
  def decode(frame) when is_binary(frame) and byte_size(frame) <= @max_frame_bytes do
    decode_bounded(frame)
  end

  def decode(_frame), do: {:error, :bad_frame}

  defp decode_bounded(<<@magic, version, _rest::binary>>) when version != @transport_version,
    do: {:error, :unsupported_transport_version}

  defp decode_bounded(
         <<@magic, @transport_version, kind, attempt::binary-size(16), route::binary-size(16),
           payload::binary>>
       )
       when kind in [1, 2] do
    with {:ok, attempt_id} <- decode_uuid(attempt),
         {:ok, route_id} <- decode_uuid(route) do
      {:ok,
       %{
         kind: if(kind == 1, do: :send, else: :delivery),
         attempt_id: attempt_id,
         route_id: route_id,
         payload: payload
       }}
    end
  end

  defp decode_bounded(<<@magic, @transport_version, 3, attempt::binary-size(16), status>>) do
    with {:ok, attempt_id} <- decode_uuid(attempt),
         {:ok, decoded_status} <- decode_status(status) do
      {:ok, %{kind: :receipt, attempt_id: attempt_id, status: decoded_status}}
    end
  end

  defp decode_bounded(<<@magic, @transport_version, 4, attempt::binary-size(16), code>>) do
    with {:ok, attempt_id} <- decode_uuid(attempt),
         {:ok, decoded_code} <- decode_failure(code) do
      {:ok, %{kind: :failure, attempt_id: attempt_id, code: decoded_code}}
    end
  end

  defp decode_bounded(<<@magic, @transport_version, _rest::binary>>), do: {:error, :bad_frame}
  defp decode_bounded(_frame), do: {:error, :bad_frame}

  @spec encode(relay_frame()) :: {:ok, binary()} | {:error, :bad_frame}
  def encode(%{kind: kind, attempt_id: attempt_id, route_id: route_id, payload: payload})
      when kind in [:send, :delivery] and is_binary(payload) and
             byte_size(payload) <= @max_payload_bytes do
    with {:ok, attempt} <- encode_uuid(attempt_id),
         {:ok, route} <- encode_uuid(route_id) do
      kind_byte = if kind == :send, do: 1, else: 2

      {:ok,
       <<@magic, @transport_version, kind_byte, attempt::binary, route::binary, payload::binary>>}
    end
  end

  def encode(%{kind: :receipt, attempt_id: attempt_id, status: status}) do
    with {:ok, attempt} <- encode_uuid(attempt_id),
         {:ok, status_byte} <- encode_status(status) do
      {:ok, <<@magic, @transport_version, 3, attempt::binary, status_byte>>}
    end
  end

  def encode(%{kind: :failure, attempt_id: attempt_id, code: code}) do
    with {:ok, attempt} <- encode_uuid(attempt_id),
         {:ok, code_byte} <- encode_failure(code) do
      {:ok, <<@magic, @transport_version, 4, attempt::binary, code_byte>>}
    end
  end

  def encode(_frame), do: {:error, :bad_frame}

  defp decode_status(1), do: {:ok, :admitted}
  defp decode_status(2), do: {:ok, :forwarded}
  defp decode_status(_status), do: {:error, :bad_frame}

  defp encode_status(:admitted), do: {:ok, 1}
  defp encode_status(:forwarded), do: {:ok, 2}
  defp encode_status(_status), do: {:error, :bad_frame}

  defp decode_failure(value) do
    case Map.fetch(@failure_codes, value) do
      {:ok, code} -> {:ok, code}
      :error -> {:error, :bad_frame}
    end
  end

  defp encode_failure(code) do
    case Enum.find(@failure_codes, fn {_value, candidate} -> candidate == code end) do
      nil -> {:error, :bad_frame}
      {value, _candidate} -> {:ok, value}
    end
  end

  defp encode_uuid(value) when is_binary(value) do
    case Base.decode16(String.replace(value, "-", ""), case: :lower) do
      {:ok, bytes} when byte_size(bytes) == 16 -> decode_uuid(bytes, bytes)
      _other -> {:error, :bad_frame}
    end
  end

  defp encode_uuid(_value), do: {:error, :bad_frame}

  defp decode_uuid(bytes), do: decode_uuid(bytes, format_uuid(bytes))

  defp decode_uuid(<<_::48, version::4, _::12, 2::2, _::62>>, result)
       when version >= 1 and version <= 8,
       do: {:ok, result}

  defp decode_uuid(_bytes, _result), do: {:error, :bad_frame}

  defp format_uuid(bytes) do
    hex = Base.encode16(bytes, case: :lower)

    Enum.join(
      [
        binary_part(hex, 0, 8),
        binary_part(hex, 8, 4),
        binary_part(hex, 12, 4),
        binary_part(hex, 16, 4),
        binary_part(hex, 20, 12)
      ],
      "-"
    )
  end
end
