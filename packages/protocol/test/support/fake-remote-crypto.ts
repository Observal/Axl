// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import { decodeBase64, encodeBase64, parseDeviceId, type DeviceId } from "../../src/index.ts";

export interface AuthenticatedPlaintext {
  readonly authenticatedDeviceId: DeviceId;
  readonly plaintext: Uint8Array;
}

export interface RemoteCryptoAdapter {
  open(opaqueEnvelope: Uint8Array): Promise<AuthenticatedPlaintext>;
  seal(destinationDeviceId: DeviceId, plaintext: Uint8Array): Promise<Uint8Array>;
}

interface FakeEnvelope {
  readonly warning: "TEST_ONLY_NOT_ENCRYPTED";
  readonly sourceDeviceId: string;
  readonly destinationDeviceId: string;
  readonly plaintextBase64: string;
}

/** Deterministic test framing. It provides no confidentiality, integrity, or replay protection. */
export class DeterministicFakeRemoteCryptoAdapter implements RemoteCryptoAdapter {
  private readonly localDeviceId: DeviceId;
  private readonly expectedRemoteDeviceId: DeviceId;

  constructor(localDeviceId: DeviceId, expectedRemoteDeviceId: DeviceId) {
    this.localDeviceId = localDeviceId;
    this.expectedRemoteDeviceId = expectedRemoteDeviceId;
  }

  async open(opaqueEnvelope: Uint8Array): Promise<AuthenticatedPlaintext> {
    let candidate: FakeEnvelope;
    try {
      candidate = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(opaqueEnvelope));
    } catch (cause) {
      throw new Error("Fake E2EE envelope is invalid", { cause });
    }
    if (
      candidate.warning !== "TEST_ONLY_NOT_ENCRYPTED" ||
      parseDeviceId(candidate.sourceDeviceId) !== this.expectedRemoteDeviceId ||
      parseDeviceId(candidate.destinationDeviceId) !== this.localDeviceId
    ) {
      throw new Error("Fake E2EE envelope identity does not match the test endpoints");
    }
    return {
      authenticatedDeviceId: this.expectedRemoteDeviceId,
      plaintext: decodeBase64(candidate.plaintextBase64, "fakeEnvelope.plaintextBase64", 65_535),
    };
  }

  async seal(destinationDeviceId: DeviceId, plaintext: Uint8Array): Promise<Uint8Array> {
    if (destinationDeviceId !== this.expectedRemoteDeviceId) {
      throw new Error("Fake E2EE destination does not match the configured test endpoint");
    }
    return new TextEncoder().encode(
      JSON.stringify({
        warning: "TEST_ONLY_NOT_ENCRYPTED",
        sourceDeviceId: this.localDeviceId,
        destinationDeviceId,
        plaintextBase64: encodeBase64(plaintext),
      } satisfies FakeEnvelope),
    );
  }
}
