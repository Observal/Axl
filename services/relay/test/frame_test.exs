# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

defmodule AxlRelay.FrameTest do
  use ExUnit.Case, async: true

  alias AxlRelay.Frame

  @fixture_path Path.expand(
                  "../../../packages/protocol/test/fixtures/remote-transport-v1.json",
                  __DIR__
                )
  @fixtures @fixture_path |> File.read!() |> :json.decode()

  test "accepts and reproduces the TypeScript canonical frames" do
    for fixture <- @fixtures["accepted"] do
      bytes = Base.decode64!(fixture["base64"])
      assert {:ok, frame} = Frame.decode(bytes), fixture["name"]
      assert fixture_shape(frame) == fixture["frame"], fixture["name"]
      assert {:ok, ^bytes} = Frame.encode(frame), fixture["name"]
    end
  end

  test "rejects every malformed canonical frame" do
    for fixture <- @fixtures["rejected"] do
      bytes = Base.decode64!(fixture["base64"])
      assert {:error, _reason} = Frame.decode(bytes), fixture["name"]
    end
  end

  test "keeps failure byte assignments stable" do
    codes = [
      bad_frame: 1,
      unsupported_transport_version: 2,
      unauthorized: 3,
      forbidden_route: 4,
      ticket_expired: 5,
      ticket_consumed: 6,
      destination_offline: 7,
      rate_limited: 8,
      queue_full: 9,
      slow_consumer: 10,
      service_unavailable: 11,
      ticket_revoked: 12
    ]

    for {code, value} <- codes do
      assert {:ok, <<"AXLR", 1, 4, _attempt::binary-size(16), ^value>>} =
               Frame.encode(%{
                 kind: :failure,
                 attempt_id: "11111111-1111-4111-8111-111111111111",
                 code: code
               })
    end
  end

  test "rejects an oversized frame before parsing" do
    assert {:error, :bad_frame} = Frame.decode(:binary.copy(<<0>>, Frame.max_frame_bytes() + 1))
  end

  defp fixture_shape(%{kind: kind, attempt_id: attempt_id, route_id: route_id, payload: payload}) do
    %{
      "kind" => Atom.to_string(kind),
      "attemptId" => attempt_id,
      "routeId" => route_id,
      "opaquePayloadBase64" => Base.encode64(payload)
    }
  end

  defp fixture_shape(%{kind: :receipt, attempt_id: attempt_id, status: status}) do
    %{
      "kind" => "receipt",
      "attemptId" => attempt_id,
      "status" => Atom.to_string(status)
    }
  end

  defp fixture_shape(%{kind: :failure, attempt_id: attempt_id, code: code}) do
    %{
      "kind" => "failure",
      "attemptId" => attempt_id,
      "code" => Atom.to_string(code)
    }
  end
end
