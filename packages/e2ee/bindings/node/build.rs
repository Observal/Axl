// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

fn main() {
    napi_build::setup();
    // The deployment-test daemon trusts exactly the replicas named at build time. Without a trust
    // file (unit tests, lint) the pinned trust is empty and every endpoint fails closed with
    // `rollback_anchor_unavailable`; `scripts/build.mjs deployment-test` always supplies one.
    println!("cargo:rerun-if-env-changed=AXL_E2EE_DEPLOYMENT_TEST_TRUST_FILE");
    if std::env::var_os("CARGO_FEATURE_DEPLOYMENT_TEST").is_some() {
        let output = std::path::Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR"))
            .join("replica-trust.bin");
        match std::env::var("AXL_E2EE_DEPLOYMENT_TEST_TRUST_FILE") {
            Ok(source) => {
                println!("cargo:rerun-if-changed={source}");
                std::fs::copy(&source, output)
                    .expect("the deployment-test trust file must be readable");
            }
            Err(_) => std::fs::write(output, []).expect("OUT_DIR must be writable"),
        }
    }
}
