// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeQrCode,
  type QrCode,
  qrTerminalWidth,
  reedSolomonDivisor,
  reedSolomonRemainder,
  renderQrCode,
} from "../src/qr-code.ts";
import { stripAnsi } from "../src/index.ts";

const LEVEL_OF_FORMAT_BITS = ["M", "L", "H", "Q"] as const;

/** Read the first format-information copy back, checking its BCH code. */
function readFormat(code: QrCode): { level: string; mask: number } {
  const at = (x: number, y: number) => (code.modules[y]?.[x] === true ? 1 : 0);
  const positions: [number, number][] = [
    [8, 0],
    [8, 1],
    [8, 2],
    [8, 3],
    [8, 4],
    [8, 5],
    [8, 7],
    [8, 8],
    [7, 8],
    [5, 8],
    [4, 8],
    [3, 8],
    [2, 8],
    [1, 8],
    [0, 8],
  ];
  let bits = 0;
  for (const [index, [x, y]] of positions.entries()) bits |= at(x, y) << index;
  bits ^= 0x5412;
  const data = bits >>> 10;
  let remainder = data;
  for (let index = 0; index < 10; index += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  assert.equal(bits & 0x3ff, remainder & 0x3ff, "format BCH");
  return { level: LEVEL_OF_FORMAT_BITS[data >>> 3] ?? "?", mask: data & 7 };
}

function assertFinder(code: QrCode, left: number, top: number): void {
  for (let dy = 0; dy < 7; dy += 1) {
    for (let dx = 0; dx < 7; dx += 1) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      assert.equal(code.modules[top + dy]?.[left + dx], ring !== 2, `finder ${left},${top}`);
    }
  }
}

test("Reed-Solomon matches the standard's worked example", () => {
  // ISO/IEC 18004 Annex I: "01234567" at version 1-M.
  const data = [
    0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11,
  ];
  assert.deepEqual(
    reedSolomonRemainder(data, reedSolomonDivisor(10)),
    [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55],
  );
});

test("a pairing-sized link is a version 18 code with valid function patterns", () => {
  const link = `https://stack.example/remote/#v=1&i=${"A".repeat(404)}&a=${"B".repeat(22)}&n=${"C".repeat(22)}&d=${"D".repeat(22)}&s=${"E".repeat(22)}&t=${"F".repeat(64)}&p=${"G".repeat(64)}`;
  const code = encodeQrCode(link, "L");
  assert.equal(code.version, 18);
  assert.equal(code.size, 89);
  assert.equal(code.modules.length, 89);
  assert.ok(code.modules.every((row) => row.length === 89));
  assertFinder(code, 0, 0);
  assertFinder(code, code.size - 7, 0);
  assertFinder(code, 0, code.size - 7);
  for (let index = 8; index < code.size - 8; index += 1) {
    assert.equal(code.modules[6]?.[index], index % 2 === 0, "horizontal timing");
    assert.equal(code.modules[index]?.[6], index % 2 === 0, "vertical timing");
  }
  assert.equal(code.modules[code.size - 8]?.[8], true, "dark module");
  assert.deepEqual(readFormat(code), { level: code.errorCorrection, mask: code.mask });
});

test("version information carries its BCH code from version 7", () => {
  const code = encodeQrCode("x".repeat(150), "L");
  assert.equal(code.version, 7);
  let bits = 0;
  for (let index = 0; index < 18; index += 1) {
    const dark = code.modules[Math.floor(index / 3)]?.[code.size - 11 + (index % 3)] === true;
    bits |= (dark ? 1 : 0) << index;
  }
  assert.equal(bits, 0x07c94);
});

test("the encoder upgrades error correction when the version has room", () => {
  const code = encodeQrCode("hi", "L");
  assert.equal(code.version, 1);
  assert.equal(code.errorCorrection, "H");
  assert.deepEqual(readFormat(code), { level: "H", mask: code.mask });
  assert.throws(() => encodeQrCode("x".repeat(3_000), "L"), RangeError);
});

test("terminal rendering packs two module rows per line inside a quiet zone", () => {
  const code = encodeQrCode("https://stack.example/remote/", "M");
  const colored = renderQrCode(code);
  assert.equal(colored.length, Math.ceil(qrTerminalWidth(code) / 2));
  for (const line of colored) {
    assert.ok(line.startsWith("\u001b["));
    assert.ok(line.endsWith("\u001b[0m"));
    assert.equal(stripAnsi(line).length, qrTerminalWidth(code));
  }
  const plain = renderQrCode(code, { quietZone: 2, color: false });
  assert.equal(plain[0], " ".repeat(qrTerminalWidth(code, 2)));
  // The second line holds the finder's solid top row over its hollow second row.
  assert.equal(plain[1]?.slice(2, 9), `█${"▀".repeat(5)}█`);
});
