// SPDX-FileCopyrightText: 2026 VishnuM449
// SPDX-License-Identifier: Apache-2.0

use std::{env, path::PathBuf, process::ExitCode};
use wasm_bindgen_cli_support::{Bindgen, EncodeInto};

fn run() -> Result<(), String> {
    for name in [
        "WASM_BINDGEN_ANYREF",
        "WASM_BINDGEN_EXTERNREF",
        "WASM_BINDGEN_MULTI_VALUE",
    ] {
        if env::var_os(name).is_some() {
            return Err(format!("unsupported environment variable: {name}"));
        }
    }

    let mut args = env::args_os();
    let _program = args.next();
    let input = args.next().map(PathBuf::from).ok_or("missing input")?;
    let output = args.next().map(PathBuf::from).ok_or("missing output")?;
    let out_name = args.next().ok_or("missing output name")?;
    if args.next().is_some() {
        return Err("unexpected argument".into());
    }
    if input.extension().and_then(|value| value.to_str()) != Some("wasm") {
        return Err("input must be a .wasm file".into());
    }
    let out_name = out_name
        .into_string()
        .map_err(|_| "output name is not UTF-8")?;
    if out_name.is_empty()
        || out_name.len() > 128
        || !out_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err("invalid output name".into());
    }

    let mut bindgen = Bindgen::new();
    #[allow(deprecated)]
    bindgen
        .input_path(input)
        .out_name(&out_name)
        .web(true)
        .map_err(|error| error.to_string())?
        .debug(false)
        .demangle(true)
        .keep_lld_exports(false)
        .keep_debug(false)
        .split_debug_info(false)
        .remove_name_section(false)
        .remove_producers_section(false)
        .typescript(true)
        .omit_imports(false)
        .omit_default_module_path(false)
        .split_linked_modules(false)
        .ts_typed_array_buffers(false)
        .reference_types(false)
        .reset_state_function(false)
        .force_enable_abort_handler(false)
        .encode_into(EncodeInto::Test);
    bindgen.generate(output).map_err(|error| error.to_string())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("wasm binding generation failed: {error}");
            ExitCode::FAILURE
        }
    }
}
