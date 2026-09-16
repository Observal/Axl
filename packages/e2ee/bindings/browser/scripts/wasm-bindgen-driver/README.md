<!-- SPDX-FileCopyrightText: 2026 VishnuM449 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Browser binding generator

This standalone, independently locked tooling workspace calls `wasm-bindgen-cli-support` directly.
It accepts only an input `.wasm` path, output directory, and bounded output name, and always generates
ES modules for `--target web` semantics. It does not install or execute `wasm-bindgen-cli`, access the
network, or download executables.

Run its checks independently from the E2EE runtime workspace:

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo audit --deny warnings
cargo deny check
```
