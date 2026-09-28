// SPDX-FileCopyrightText: 2026 Lokesh
// SPDX-License-Identifier: Apache-2.0

/**
 * `axl remote login` and `axl remote logout`: sign this machine's daemon in to remote access, or
 * forget the account. Login runs the browser sign-in, stores the account with its secrets sealed
 * by Windows DPAPI, and registers the installation's key, which also tells whether remote access
 * is enabled for the account yet.
 */

import { access, constants } from "node:fs/promises";

import {
  DEFAULT_REMOTE_ORIGIN,
  defaultDpapiHelper,
  defaultHostedBinding,
  loadDaemonSignInConfig,
  loadRemoteAccount,
  RemoteAccountError,
  RemoteAccountSession,
  removeRemoteAccount,
  saveRemoteAccount,
  startRemoteSignIn,
} from "@axl/runtime";

import { launchBrowser } from "./browser-launch.ts";

const PAGE_PATH = "/remote/";

export const REMOTE_HELP = `Usage: axl remote login [--origin <url>] [--helper <path>] [--binding <path>] [--no-open]
       axl remote logout

login   Sign this machine in to remote access with Google and register it.
logout  Forget the signed-in account on this machine.

  --origin <url>    The remote stack (default ${DEFAULT_REMOTE_ORIGIN})
  --helper <path>   axl-dpapi-helper.exe (default %LOCALAPPDATA%\\Axl\\bin in Windows)
  --binding <path>  The hosted WSL Node binding loader
  --no-open         Print the sign-in link instead of opening a browser
`;

interface RemoteOptions {
  readonly origin: string;
  readonly helper?: string;
  readonly binding?: string;
  readonly open: boolean;
}

function parse(argv: readonly string[]): RemoteOptions {
  let origin = DEFAULT_REMOTE_ORIGIN;
  let helper: string | undefined;
  let binding: string | undefined;
  let open = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    const value = () => {
      index += 1;
      const next = argv[index];
      if (next === undefined) throw new Error(`${argument} requires a value`);
      return next;
    };
    if (argument === "--origin") origin = new URL(value()).origin;
    else if (argument === "--helper") helper = value();
    else if (argument === "--binding") binding = value();
    else if (argument === "--no-open") open = false;
    else throw new Error(`Unknown option for axl remote: ${argument}`);
  }
  return {
    origin,
    open,
    ...(helper === undefined ? {} : { helper }),
    ...(binding === undefined ? {} : { binding }),
  };
}

async function exists(path: string, mode = constants.R_OK): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

async function login(axlHome: string, options: RemoteOptions, write: (text: string) => void) {
  const helper = options.helper ?? (await defaultDpapiHelper());
  if (helper === undefined || !(await exists(helper, constants.X_OK))) {
    throw new Error(
      `Remote access keeps its keys sealed by Windows, through axl-dpapi-helper.exe, which is not at ${helper ?? "%LOCALAPPDATA%\\Axl\\bin"}. Build and install it with packages/e2ee/helpers/dpapi/install-wsl.sh, or pass --helper.`,
    );
  }
  const binding = options.binding ?? defaultHostedBinding();
  if (!(await exists(binding))) {
    write(
      `Note: the hosted WSL binding is not built yet (${binding}). Pairing needs it; build it with infra/aws/hosted-path-test/daemon-binding.sh.\n`,
    );
  }
  const config = await loadDaemonSignInConfig(options.origin, PAGE_PATH);
  const pending = await startRemoteSignIn({ config });
  write(`Sign in to remote access in your browser:\n  ${pending.url}\n`);
  if (options.open) {
    await launchBrowser(pending.url).catch(() =>
      write("The browser did not open; open the link above.\n"),
    );
  }
  const tokens = await pending.complete();
  const account = await saveRemoteAccount({
    axlHome,
    origin: options.origin,
    pagePath: PAGE_PATH,
    config,
    tokens,
    helper,
    binding,
  });
  const who = account.email ?? account.accountId;
  const session = await RemoteAccountSession.open(axlHome, account);
  try {
    await session.register();
  } catch (cause) {
    if (cause instanceof RemoteAccountError && cause.code === "not_enabled") {
      write(
        `Signed in as ${who}, but remote access is not enabled for this account yet.\nAccount ID: ${account.accountId}\nOnce it is enabled, run axl daemon restart and then /remote.\n`,
      );
      return;
    }
    throw cause;
  }
  write(
    `Remote access is ready for ${who}.\nRun axl daemon restart, then /remote, and sign in on your phone with the same Google account.\n`,
  );
}

async function logout(axlHome: string, write: (text: string) => void) {
  const account = await loadRemoteAccount(axlHome).catch(() => undefined);
  if (account !== undefined) {
    // Revoke the refresh token too, so a copy of it could not be used; best effort.
    await RemoteAccountSession.open(axlHome, account)
      .then((session) => session.revoke())
      .catch(() => undefined);
  }
  if (!(await removeRemoteAccount(axlHome))) {
    write("This machine is not signed in to remote access.\n");
    return;
  }
  write(
    `Signed out${account?.email === undefined ? "" : ` ${account.email}`}. Run axl daemon restart to end remote access on this machine.\n`,
  );
}

export async function runRemoteCommand(
  argv: readonly string[],
  axlHome: string,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<void> {
  const [action, ...rest] = argv;
  if (action === "login") return login(axlHome, parse(rest), write);
  if (action === "logout") {
    parse(rest);
    return logout(axlHome, write);
  }
  if (action === undefined || action === "--help" || action === "help") {
    write(REMOTE_HELP);
    return;
  }
  throw new Error(`Unknown axl remote command: ${action}. Use login or logout.`);
}
