// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SECCOMP_POLICY_VERSION = "axl-linux-deny-v1";

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_RET_K = 0x06;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const EPERM = 1;

const ARCHITECTURES = {
  x64: {
    audit: 0xc000003e,
    denied: [
      101, // ptrace
      155, // pivot_root
      165, // mount
      166, // umount2
      167, // swapon
      168, // swapoff
      169, // reboot
      175, // init_module
      176, // delete_module
      246, // kexec_load
      248, // add_key
      249, // request_key
      250, // keyctl
      272, // unshare
      298, // perf_event_open
      304, // open_by_handle_at
      308, // setns
      313, // finit_module
      321, // bpf
      323, // userfaultfd
      425, // io_uring_setup
      426, // io_uring_enter
      427, // io_uring_register
    ],
  },
  arm64: {
    audit: 0xc00000b7,
    denied: [
      39, // umount2
      40, // mount
      41, // pivot_root
      97, // unshare
      104, // kexec_load
      105, // init_module
      106, // delete_module
      117, // ptrace
      142, // reboot
      217, // add_key
      218, // request_key
      219, // keyctl
      224, // swapon
      225, // swapoff
      241, // perf_event_open
      265, // open_by_handle_at
      268, // setns
      273, // finit_module
      280, // bpf
      282, // userfaultfd
      425, // io_uring_setup
      426, // io_uring_enter
      427, // io_uring_register
    ],
  },
} as const;

interface Instruction {
  readonly code: number;
  readonly jt: number;
  readonly jf: number;
  readonly value: number;
}

function instruction(code: number, jt: number, jf: number, value: number): Instruction {
  return { code, jt, jf, value };
}

/** Builds a classic BPF seccomp program for the current Linux architecture. */
export function buildSeccompFilter(arch: NodeJS.Architecture = process.arch): Buffer {
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`No ${SECCOMP_POLICY_VERSION} seccomp policy for architecture ${arch}`);
  }
  const policy = ARCHITECTURES[arch];
  const instructions: Instruction[] = [
    instruction(BPF_LD_W_ABS, 0, 0, 4), // seccomp_data.arch
    instruction(BPF_JMP_JEQ_K, 1, 0, policy.audit),
    instruction(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
    instruction(BPF_LD_W_ABS, 0, 0, 0), // seccomp_data.nr
  ];
  for (const syscall of policy.denied) {
    instructions.push(
      instruction(BPF_JMP_JEQ_K, 0, 1, syscall),
      instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | EPERM),
    );
  }
  instructions.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW));

  const output = Buffer.allocUnsafe(instructions.length * 8);
  for (const [index, entry] of instructions.entries()) {
    const offset = index * 8;
    output.writeUInt16LE(entry.code, offset);
    output.writeUInt8(entry.jt, offset + 2);
    output.writeUInt8(entry.jf, offset + 3);
    output.writeUInt32LE(entry.value >>> 0, offset + 4);
  }
  return output;
}

/** Writes the deterministic policy under a private per-user temporary directory. */
export function ensureSeccompFilterFile(
  arch: NodeJS.Architecture = process.arch,
  directory = join(tmpdir(), `axl-${process.getuid?.() ?? "user"}`),
): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (
    !metadata.isDirectory() ||
    (process.getuid !== undefined && metadata.uid !== process.getuid())
  ) {
    throw new Error(`Refusing untrusted seccomp directory ${directory}`);
  }
  chmodSync(directory, 0o700);
  const path = join(directory, `${SECCOMP_POLICY_VERSION}-${arch}.bpf`);
  const temporary = join(directory, `.${SECCOMP_POLICY_VERSION}-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, 0o600);
    writeFileSync(fd, buildSeccompFilter(arch));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
  return path;
}
