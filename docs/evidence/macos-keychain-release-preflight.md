<!-- SPDX-FileCopyrightText: 2026 VishnuM049 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# macOS Keychain remote control: release preflight, not release evidence

Initial preflight: 2026-10-05 (local IST, +05:30). Final checks: 2026-10-08 IST.
Base: `origin/RC` at `339ae6c4b27290eaf7239e349025f121649521fb`.
Code commit: `f32bdc6e36b2369c199877a29ab398af56d826e4` (DCO-signed).
Preflight builds were made in a dirty worktree on `fix/macos-keychain-release` before this
commit. No signed release artifact was produced. This report does not approve macOS support
or production storage.

## Environment and artifact

- Local host: macOS 26.2 (25C56), native arm64 (`uname -m`: arm64), Node 24.13.1;
  Rust build for host arm64. Physical Intel Mac: unavailable.
- Cargo.lock SHA-256: `2b895379b1a5a00387623426ef892e2898a3cdcabd8abbe2cd75d1e86242ee22`.
- Locally built **unsigned negative-test binary only**: `packages/e2ee/target/release/axl-keychain-helper`,
  SHA-256 `1583362869b01050b5ef8a716560a9cfa63db0f1144ecf3ba5f5d87a35c47656`.
  Not a signed or notarized artifact; do not distribute or install. No installed helper was found.
- Signed/stapled artifact hash, Developer ID signature/team, entitlements, embedded profile,
  hardened runtime, Gatekeeper and notarization verification: **blocked**. On 2026-10-05 IST,
  `security find-identity -v -p codesigning` reported 0 valid identities and 0 Developer ID
  Application identities (names suppressed). Xcode Command Line Tools and notarytool 1.1.0
  are present; this is not sufficient to sign. No signing assets were used, no notarization
  submitted, and the install script was not run.
- Install layout inspection on this Mac: `~/Library/Application Support/Axl`,
  `AxlKeychainHelper.app`, `keychain-helper-versions`, installer lock, and the old flat archive
  are absent. No legacy migration is needed **on this Mac as inspected**. Nothing was created,
  installed, stopped, or launched.
- Hosted-stack endpoint, test account and browser-phone run: **blocked pending permission**.
  Neither a deployment-test nor a production-opt-in run was performed. Even a hosted test run
  would not establish independent production witnesses: the documented three replicas share
  one failure domain.

## Design review findings

1. The desktop amendment uses one `WhenUnlockedThisDeviceOnly` data-protection Keychain item as
   the AES-GCM wrapping key, rather than the RFC's one-item-per-DEK scheme. The signed helper can
   be invoked by **any process of the same user** to unseal a copied owner-only record or sealed
   account token. This is a material reduction in per-record ACL isolation, not same-user malware
   resistance. No hardware protection or secure deletion is claimed. Independent security review
   of this trade-off is still required.
2. Helper input/output frames are bounded to 64 KiB; malformed frames fail closed. The helper
   re-reads the Keychain key for each operation. It requests the data-protection Keychain, the
   no-sync attribute, `AccessibleWhenUnlockedThisDeviceOnly`, and skips authenticated items. An
   unsigned binary was denied on this arm64 host. Real lock/no-prompt behavior with a signed
   helper is untested. `Unavailable` is mapped to `secure_store_unavailable`, not always the
   RFC's narrower `secure_store_locked`; no prompt or fallback is intentionally added.
3. Sealed records are owner-only files. Prepared/active files are synced before rename and the
   directory is synced after publication or deletion. The read path previously validated a path
   and then followed a possible replacement symlink when opening. It now uses `O_NOFOLLOW` and
   checks the *opened* file's owner, mode and type. A regression test rejects a symlinked record.
   Same-user replacement and crash/reboot at every boundary still need native runtime testing.
4. Replacing the wrapping key changes the helper identity and refuses existing records. A
   replacement helper with a different identity, or a corrupted or mismatched seal, fails closed
   in tests. The old installer destroyed an existing bundle and installed ad-hoc helpers by
   default. The revised installer requires all release inputs, notarizes and verifies the staged
   bundle and the re-extracted stapled ZIP. The original publication order could leave a visible
   app if post-install verification failed. The revised publisher stores an immutable versioned
   bundle and ZIP, then atomically switches a canonical symlink after verification. A post-switch
   verification failure restores the previous symlink, or removes a first-install symlink;
   previous bundles and Keychain data are retained. Tests cover first install, upgrade, failure
   before publication, failed post-publication verification, legacy-directory refusal, and
   rejection of an unrecognized installed pointer.
   Upgrades require the daemon to be stopped and an explicit acknowledgment; the script does
   not stop services. An old-style directory at the canonical path needs a separate reviewed
   migration. Sudden process termination after the atomic switch leaves a previously verified
   version selected, though complete runtime upgrade/crash evidence is still missing. Independent
   distribution still requires review. Runtime helper provenance is not authenticated by the
   daemon; the signed helper is callable by any same-user process.
5. Account refresh token and PKCS#8 installation key are sealed with purpose and account in the
   account file. The negative account test verifies the unsigned helper is refused. Real signed
   login and token refresh were not exercised. Witness equality, quorum receipts, and obsolete-key
   deletion remain mandatory barriers above this store; no signed-hosted output was tested here.

**Review status:** author-side analysis only. No independent security review was obtained. Request
one before approval, covering same-user invocation, installer and verification, file lifecycle,
account sealing, witness barriers, and error mapping.

## Commands and results (redacted)

- `git status --short --branch`, `git rev-parse`, `git branch -a`, `git remote -v`:
  detached head with three existing untracked paths; no tracked modifications. `git fetch origin RC`
  and `git switch -c fix/macos-keychain-release origin/RC`: passed; untracked files left intact.
- `cat AGENTS.md AI_POLICY.md` and architecture/code inspections with `cat`, `sed`, `rg`, `ls`:
  completed. `sw_vers`, `uname -a`, `uname -m`, `command -v`, `xcrun notarytool --help`:
  completed; only native arm64 available. `ls` on installed helper: missing.
- Read-only local signing/install preflight: `date`, `uname -m`, `sw_vers`, `xcode-select -p`,
  `xcrun notarytool --version`, `security find-identity -v -p codesigning` (counts only),
  `stat`, `id -u`, `readlink` and file-existence checks: finished as reported above.
  Initial `awk` count pipeline failed on this macOS awk syntax; the corrected count pipeline
  returned 0 Developer ID and 0 valid identities.
- `bash -n packages/e2ee/helpers/keychain/install-macos.sh`: passed.
  `/usr/bin/python3 -m unittest discover -s packages/e2ee/helpers/keychain -p 'test_*.py' -v`:
  10 passed after the publication changes (the earlier run had 4). Initial run using Homebrew `python3`: failed because that interpreter cannot load
  `pyexpat` on this host; the installer now uses system `/usr/bin/python3`.
- Installer with all release variables unset: refused with exit 1 before building or installing.
- `cargo test --locked -p axl-e2ee sealed_file --lib`: 10 passed, 1 ignored (signed helper not
  supplied). `cargo test --locked -p axl-keychain-helper`: 5 passed; unsigned live test skipped
  by its environment gate. `cargo build --locked --release -p axl-keychain-helper`: passed.
- `AXL_KEYCHAIN_HELPER=<unsigned build> cargo test --locked -p axl-e2ee
  an_unsigned_keychain_helper_fails_closed -- --ignored --nocapture`: 1 passed; logged only
  `architecture=aarch64, unsigned helper result=Err(SecureStoreAccessDenied)`.
  `AXL_RUN_MACOS_KEYCHAIN_TESTS=1 cargo test --locked -p axl-keychain-helper
  an_unsigned_helper_is_refused_by_the_keychain -- --nocapture`: 1 passed; logged only
  `architecture=aarch64, unsigned result=Err(Denied)`.
- `cargo clippy --locked -p axl-e2ee -p axl-keychain-helper --all-targets -- -D warnings` and
  `cargo clippy --locked -p axl-e2ee-node --all-targets --features hosted-macos -- -D warnings`:
  passed on arm64.
- `AXL_E2EE_HOSTED_TRUST_FILE=<empty temporary file> node
  packages/e2ee/bindings/node/scripts/build.mjs hosted-macos` followed by ABI and account tests:
  timed out before packaging; Rust native release compile completed, but hosted artifact was not
  emitted. No trust material was populated. `node packages/e2ee/bindings/node/scripts/check-abi.mjs`
  against an older production artifact failed on Cargo.lock provenance drift, not an ABI pass.
- `node --test packages/runtime/test/remote-account.test.ts` initially failed due to stale
  `@axl/protocol` build. After `pnpm --filter @axl/protocol build`, the same test with
  `AXL_LIVE_KEYCHAIN_HELPER=<unsigned build>` passed 10, skipped 2 unrelated WSL/Linux live cases.
- `cargo test --locked -p axl-e2ee --lib -q`: 151 passed, 1 ignored (live helper).
  `cargo fmt --all -- --check`: passed. The Python verifier refused a missing bundle as expected.
  After correcting the date and adding versioned publication: `bash -n` and 10 Python tests
  passed, including rollback after a failed installed-bundle check. An initial assertion in the
  pointer-rejection test failed because `/var` resolves through `/private/var` on this host;
  comparing both resolved paths fixed the test, and the full suite passed.
- `pnpm check:boundaries && pnpm check:generated` timed out while the boundary check ran;
  neither check is recorded as passed. `reuse lint` timed out without a result. Local Mac CI
  jobs were not invoked. `git diff --check`: passed. `date '+%Y-%m-%d %Z %z'` reported
  `2026-10-05 IST +0530`; the report date was corrected. `/usr/bin/python3 -m py_compile`
  for publisher and verifier passed. `git status` confirmed unrelated untracked files were
  untouched. The release skill and `RELEASES.md` were read; no release command, tag, commit,
  or push was run. SHA-256 commands (`shasum -a 256`) completed.

## Final local checks (2026-10-08 IST)

Builds were made from the worktree that became code commit
`f32bdc6e36b2369c199877a29ab398af56d826e4` based on `origin/RC` at
`339ae6c4b27290eaf7239e349025f121649521fb`. The generated native artifacts are
local unsigned test outputs, not signed release artifacts.

- `node packages/e2ee/bindings/node/scripts/build.mjs hosted-macos` with an **empty temporary
  trust file**: passed, darwin-arm64 artifact SHA-256
  `d3e6b71f3f23a5a1c3c4a33f6a08c07fcf5acd5f3736bc767179f62013856bc1`.
  The file was removed. Empty test trust does not permit hosted production operation.
- `node packages/e2ee/bindings/node/scripts/build.mjs production`, then `... build.mjs test`
  and `... check-abi.mjs`: passed. Production darwin-arm64 artifact SHA-256
  `1de940da33f599bb9396efdca92d670e188df80c91f2ec1c65611876368c4b95`.
  ABI/isolation/provenance checks passed with current artifacts. No signed helper was tested.
- `node scripts/check-boundaries.ts` and `node scripts/check-generated.ts`: passed.
- Python publisher and verifier: 10 passed. `bash -n`, `cargo fmt --all -- --check`,
  `cargo test --locked -p axl-e2ee sealed_file --lib -q` (10 passed, 1 ignored),
  `cargo test --locked -p axl-keychain-helper -q` (5 passed), and both focused Rust
  `cargo clippy --locked ... -- -D warnings` commands: passed.
- `pnpm lint`, `pnpm typecheck`, `pnpm build` and the repository TypeScript build: passed.
  After rebuilding package output, `node --test packages/runtime/test/remote-host.test.ts`
  passed 5. The combined remote account/host run initially failed because old SDK build output
  omitted an export; the rebuild corrected this. Account tests passed 10 with 2 unrelated live
  WSL/Linux skips using the unsigned helper negative test.
- `reuse lint-file` on every changed and new file (including the new Mac CI step): passed. `reuse lint`: **failed** because a
  pre-existing, unrelated untracked browser `test-results/.last-run.json` has no SPDX notice.
  `pnpm format:check`: **failed** because that same untracked file has no final newline.
  The file was not edited, deleted, or added to the PR. A `biome format --changed --since=origin/RC`
  attempt processed no files and exited 1; no tracked TypeScript or JSON changed in this PR.
  `pnpm lint` passed separately. In a disposable `git archive HEAD` snapshot with only this
  evidence file added, `reuse --root <snapshot> lint` passed (911/911 licensed), and
  `pnpm exec biome format --config-path <snapshot>/biome.json <snapshot>` passed (564 files).
  That snapshot was removed without modifying the original untracked file.
- `pnpm test`: **failed** on macOS: 1,314 tests, 1,276 passed, 14 failed, 24 skipped.
  Failures were outside changed paths (Linux `/proc/self/mountinfo` in OCI tests, `/var` to
  `/private/var` path assumptions in extension/TUI tests, and Unix socket path behavior).
  No valid tests were deleted, skipped, or weakened. CI on supported runner environments must
  decide the broader gate; this is not reported as a full test pass. Logs are local and
  must be redacted before sharing. `git diff --check`: passed.

## Unavailable scenarios / gates

Signed key creation, protect/unprotect, endpoint creation, signed account login, daemon and phone
remote flow, restart and hard-crash/reboot recovery, lock/unlock, sleep/wake, logout/login, fast
user switching, password change, helper or wrapping-key replacement, same-Mac and cross-Mac copy
or restore, unavailable Keychain/witness under signed execution, and incorrectly entitled signed
helper: **not run**. Native Intel tests and Mac CI on both GitHub runners: **not run locally**.
Independent review, signed/notarized release, real signed installer upgrade tests, production witness
independence, and final release approval remain separate gates. `productionStorageReady` is false;
no opt-in or support declaration was changed.
