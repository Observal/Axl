# SPDX-FileCopyrightText: 2026 Lokesh
# SPDX-License-Identifier: Apache-2.0

defmodule AxlRelay.InternalContractTest do
  use ExUnit.Case, async: true

  alias AxlRelay.{Admission, HttpControlPlaneClient, RevocationHandler}

  @fixture_path Path.expand(
                  "../../../packages/protocol/test/fixtures/internal-relay-api-v1.json",
                  __DIR__
                )
  @fixtures @fixture_path |> File.read!() |> :json.decode()

  test "accepts the TypeScript ticket-consumption fixture" do
    result = @fixtures["consumeTicket"]["result"]

    assert {:ok, parsed} = HttpControlPlaneClient.validate_result(result)
    assert parsed.installation_id == result["installationId"]
    assert parsed.device_id == result["deviceId"]
    assert parsed.source_route_id == result["sourceRouteId"]
    assert parsed.role == :device
    assert parsed.limits.max_frame_bytes == 65_535
    assert parsed.limits.max_queued_bytes == 524_288
  end

  test "forms the admitted WebSocket message without relay-owned fields" do
    consume = @fixtures["consumeTicket"]["request"]

    admission =
      Map.take(consume, ["version", "ticket", "connectionNonce", "possessionProof"])
      |> :json.encode()
      |> IO.iodata_to_binary()

    assert {:ok, parsed} = Admission.parse(admission)
    assert parsed["ticket"] == consume["ticket"]
    refute Map.has_key?(parsed, "relayInstanceId")
  end

  test "accepts the TypeScript revocation fixture and rejects unknown fields" do
    request = @fixtures["revocation"]["request"]
    bytes = request |> :json.encode() |> IO.iodata_to_binary()

    assert {:ok, parsed} = RevocationHandler.parse_notification(bytes)
    assert parsed.installation_id == request["installationId"]
    assert parsed.device_id == request["deviceId"]
    assert parsed.generation == request["generation"]

    malformed = request |> Map.put("unexpected", true) |> :json.encode() |> IO.iodata_to_binary()
    assert {:error, :bad_request} = RevocationHandler.parse_notification(malformed)
  end
end
