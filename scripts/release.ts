// SPDX-FileCopyrightText: 2026 Hari Srinivasan
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_BRANCH = /^release\/(\d+)\.(\d+)$/;
const RELEASE_COMMIT = /^chore\(release\): v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/;
const CHANNELS = ["stable", "rc", "beta", "alpha"] as const;
const CATEGORIES = ["Security", "Features", "Fixes", "Documentation", "Maintenance"] as const;

type Channel = (typeof CHANNELS)[number];
type Category = (typeof CATEGORIES)[number];

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly channel?: Exclude<Channel, "stable">;
  readonly serial?: number;
}

interface Commit {
  readonly sha: string;
  readonly title: string;
  readonly body: string;
  readonly authorName: string;
  readonly authorEmail: string;
}

interface Change {
  readonly commits: readonly string[];
  readonly title: string;
  readonly category: Category;
  readonly pr?: number;
  readonly url?: string;
  readonly originalPr?: number;
  readonly contributor: string;
}

export interface ReleaseManifest {
  readonly version: string;
  readonly channel: Channel;
  readonly npmTag: string;
  readonly branch: string;
  readonly previousTag: string | null;
  readonly cutoff: string;
  readonly createdAt: string;
  readonly includedPrs: readonly number[];
  readonly backports: readonly { readonly originalPr: number; readonly backportPr: number }[];
}

interface CliOptions {
  readonly preview: boolean;
  readonly cut?: string;
  readonly channel?: Channel;
  readonly backport?: number;
  readonly to?: string;
  readonly status: boolean;
  readonly resolvePush: boolean;
  readonly before?: string;
  readonly after?: string;
  readonly branch?: string;
  readonly upstream: string;
  readonly fork: string;
}

function run(
  command: string,
  arguments_: readonly string[],
  options: { readonly cwd?: string; readonly capture?: boolean } = {},
): string {
  const result = execFileSync(command, arguments_, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    stdio: options.capture === false ? "inherit" : "pipe",
  });
  return typeof result === "string" ? result.trim() : "";
}

function git(...arguments_: string[]): string {
  return run("git", arguments_);
}

function repository(remote: string): string {
  const url = git("remote", "get-url", remote);
  const match = url.match(/github\.com(?::|\/)([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match?.[1]) throw new Error(`Cannot determine GitHub repository from ${remote}: ${url}`);
  return match[1];
}

function ghJson(repo: string, endpoint: string): unknown {
  return JSON.parse(run("gh", ["api", `repos/${repo}/${endpoint}`]));
}

function lines(value: string): string[] {
  return value.split("\n").filter(Boolean);
}

function currentBranch(): string {
  return git("branch", "--show-current");
}

function requireClean(): void {
  if (git("status", "--porcelain")) throw new Error("Working tree must be clean");
}

function requireCommand(command: string): void {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(`Required command is unavailable: ${command}`);
}

function fetch(remote: string, branch?: string): void {
  const ref = branch === undefined ? [] : [branch];
  run("git", ["fetch", "--tags", "--force", "--no-prune-tags", remote, ...ref], {
    capture: false,
  });
}

function requireCurrentBranch(remote: string, branch: string): void {
  fetch(remote, branch);
  const local = git("rev-parse", "HEAD");
  const canonical = git("rev-parse", `${remote}/${branch}`);
  if (local !== canonical) {
    throw new Error(`Local ${branch} must exactly match ${remote}/${branch}`);
  }
}

export function parseVersion(value: string): ParsedVersion {
  const match = value.match(VERSION);
  if (!match) throw new Error(`Invalid release version: ${value}`);
  const [, major, minor, patch, channel, serial] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    ...(channel === undefined ? {} : { channel: channel as Exclude<Channel, "stable"> }),
    ...(serial === undefined ? {} : { serial: Number(serial) }),
  };
}

export function parseSeries(value: string): readonly [number, number] {
  const match = value.match(/^(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid release series: ${value}`);
  return [Number(match[1]), Number(match[2])];
}

function channelRank(channel: ParsedVersion["channel"]): number {
  return channel === "alpha" ? 0 : channel === "beta" ? 1 : channel === "rc" ? 2 : 3;
}

export function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    const difference = left[key] - right[key];
    if (difference !== 0) return difference;
  }
  const rank = channelRank(left.channel) - channelRank(right.channel);
  if (rank !== 0) return rank;
  return (left.serial ?? 0) - (right.serial ?? 0);
}

export function nextVersion(
  series: string,
  channel: Channel,
  existingTags: readonly string[],
): string {
  const [major, minor] = parseSeries(series);
  const versions = existingTags
    .map((tag) => tag.replace(/^v/, ""))
    .filter((tag) => VERSION.test(tag))
    .map(parseVersion)
    .filter((version) => version.major === major && version.minor === minor)
    .sort(compareVersions);
  const stablePatches = versions
    .filter((version) => version.channel === undefined)
    .map((version) => version.patch);
  const latestStablePatch = stablePatches.length === 0 ? -1 : Math.max(...stablePatches);
  const activePrereleasePatches = versions
    .filter((version) => version.channel !== undefined && version.patch > latestStablePatch)
    .map((version) => version.patch);
  const targetPatch =
    activePrereleasePatches.length > 0
      ? Math.max(...activePrereleasePatches)
      : latestStablePatch + 1;

  if (channel === "stable") {
    return `${major}.${minor}.${targetPatch}`;
  }

  const targetVersions = versions.filter(
    (version) => version.patch === targetPatch && version.channel !== undefined,
  );
  const highestChannel = targetVersions.reduce(
    (highest, version) => Math.max(highest, channelRank(version.channel)),
    -1,
  );
  if (highestChannel > channelRank(channel)) {
    throw new Error(`Cannot move release ${series}.${targetPatch} backward to ${channel}`);
  }
  const serials = targetVersions
    .filter((version) => version.channel === channel)
    .map((version) => version.serial ?? 0);
  const serial = serials.length === 0 ? 1 : Math.max(...serials) + 1;
  return `${major}.${minor}.${targetPatch}-${channel}.${serial}`;
}

export function npmTagFor(
  version: string,
  channel: Channel,
  stableTags: readonly string[],
): string {
  if (channel === "alpha" || channel === "beta") return channel;
  if (channel === "rc") return "next";
  const candidate = parseVersion(version);
  const newestStable = stableTags
    .map((tag) => tag.replace(/^v/, ""))
    .filter((tag) => VERSION.test(tag))
    .map(parseVersion)
    .filter((tag) => tag.channel === undefined)
    .sort(compareVersions)
    .at(-1);
  if (
    newestStable === undefined ||
    candidate.major > newestStable.major ||
    (candidate.major === newestStable.major && candidate.minor >= newestStable.minor)
  ) {
    return "latest";
  }
  return `lts-${candidate.major}.${candidate.minor}`;
}

function inferCategory(title: string, labels: readonly string[]): Category {
  const normalized = new Set(labels.map((label) => label.toLowerCase()));
  if ([...normalized].some((label) => label.includes("security"))) return "Security";
  if ([...normalized].some((label) => label === "documentation" || label === "docs")) {
    return "Documentation";
  }
  const type = title.toLowerCase().match(/^([a-z]+)(?:\([^)]*\))?!?:/)?.[1];
  if (type === "feat") return "Features";
  if (type === "fix" || type === "perf") return "Fixes";
  if (type === "docs") return "Documentation";
  return "Maintenance";
}

function cleanTitle(title: string): string {
  return title
    .replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, "")
    .trim()
    .replace(/\.$/, "");
}

function commitLog(range?: string): Commit[] {
  const format = "%H%x1f%s%x1f%B%x1f%an%x1f%ae%x1e";
  const output = git("log", "--reverse", `--format=${format}`, ...(range ? [range] : []));
  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = "", title = "", body = "", authorName = "", authorEmail = ""] = record.split(
        "\x1f",
        5,
      );
      return { sha, title, body, authorName, authorEmail };
    });
}

function originalPull(body: string): number | undefined {
  const match = body.match(/^Backport-of:\s*#(\d+)\s*$/im);
  return match ? Number(match[1]) : undefined;
}

function discoverChanges(repo: string, range?: string): Change[] {
  const changes = new Map<string, Change>();
  for (const commit of commitLog(range)) {
    if (RELEASE_COMMIT.test(commit.title)) continue;
    const pulls = ghJson(repo, `commits/${commit.sha}/pulls`) as readonly {
      readonly number: number;
      readonly title: string;
      readonly html_url: string;
      readonly merged_at: string | null;
      readonly body?: string | null;
      readonly labels?: readonly { readonly name: string }[];
      readonly user?: { readonly login?: string };
    }[];
    const pull = pulls
      .filter((candidate) => candidate.merged_at !== null)
      .sort((left, right) => String(right.merged_at).localeCompare(String(left.merged_at)))[0];
    const key = pull ? `pr:${pull.number}` : `commit:${commit.sha}`;
    const existing = changes.get(key);
    if (existing) {
      changes.set(key, { ...existing, commits: [...existing.commits, commit.sha] });
      continue;
    }
    const labels = pull?.labels?.map((label) => label.name) ?? [];
    const title = pull?.title ?? commit.title;
    const originalPr = pull?.body ? originalPull(pull.body) : undefined;
    changes.set(key, {
      commits: [commit.sha],
      title,
      category: inferCategory(title, labels),
      contributor: pull?.user?.login ? `@${pull.user.login}` : commit.authorName,
      ...(pull === undefined ? {} : { pr: pull.number, url: pull.html_url }),
      ...(originalPr === undefined ? {} : { originalPr }),
    });
  }
  return [...changes.values()];
}

function reference(change: Change, repo: string): string {
  if (change.pr && change.url) return `[#${change.pr}](${change.url})`;
  const sha = change.commits.at(-1) as string;
  return `[${sha.slice(0, 7)}](https://github.com/${repo}/commit/${sha})`;
}

export function renderReleaseNotes(input: {
  readonly repo: string;
  readonly version: string;
  readonly channel: Channel;
  readonly previousTag?: string;
  readonly cutoff: string;
  readonly changes: readonly Change[];
}): string {
  const lines = [
    "<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->",
    ["<!-- SPDX-License", "Identifier: Apache-2.0 -->"].join("-"),
    "",
    `Axl ${input.version} is a ${input.channel} release built from \`${input.cutoff.slice(0, 7)}\`.`,
  ];
  for (const category of CATEGORIES) {
    const changes = input.changes.filter((change) => change.category === category);
    if (changes.length === 0) continue;
    lines.push("", `## ${category}`, "");
    for (const change of changes) {
      lines.push(`- ${cleanTitle(change.title)} (${reference(change, input.repo)})`);
    }
  }
  const contributors = [...new Set(input.changes.map((change) => change.contributor))].sort();
  if (contributors.length > 0) {
    lines.push("", "## Contributors", "", contributors.map((name) => `- ${name}`).join("\n"));
  }
  lines.push(
    "",
    "## Install",
    "",
    "```bash",
    `npm install --global @observal/axl@${input.version}`,
    "```",
    "",
    "## Verify this release",
    "",
    "Verify checksums, provenance, and the signed tag with the " +
      "[release verification guide](https://github.com/Observal/Axl/blob/main/docs/security/release-verification.md).",
    "",
    "## Full comparison",
    "",
    input.previousTag
      ? `[${input.previousTag}...v${input.version}](https://github.com/${input.repo}/compare/${input.previousTag}...v${input.version})`
      : `[History through ${input.cutoff.slice(0, 7)}](https://github.com/${input.repo}/commits/${input.cutoff})`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

function releaseBranchSeries(branch: string): string {
  const match = branch.match(RELEASE_BRANCH);
  if (!match) throw new Error(`Releases must be prepared from release/X.Y, found ${branch}`);
  return `${match[1]}.${match[2]}`;
}

function tagsMergedIntoHead(): string[] {
  return lines(git("tag", "--merged", "HEAD", "--list", "v*"));
}

function latestVersionTag(tags: readonly string[], stableOnly = false): string | undefined {
  return tags
    .filter((tag) => VERSION.test(tag.replace(/^v/, "")))
    .filter((tag) => !stableOnly || parseVersion(tag.replace(/^v/, "")).channel === undefined)
    .sort((left, right) =>
      compareVersions(parseVersion(left.replace(/^v/, "")), parseVersion(right.replace(/^v/, ""))),
    )
    .at(-1);
}

function updateDistributionVersion(path: string, version: string): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  value.version = version;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeManifest(path: string, manifest: ReleaseManifest): void {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function previousReference(tags: readonly string[], channel: Channel): string | undefined {
  return channel === "stable" ? latestVersionTag(tags, true) : latestVersionTag(tags);
}

async function ask(question: string): Promise<string> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await input.question(question)).trim();
    if (!answer) throw new Error("Release cancelled");
    return answer;
  } finally {
    input.close();
  }
}

async function chooseChannel(): Promise<Channel> {
  const answer = (await ask("Channel (stable, rc, beta, alpha): ")) as Channel;
  if (!CHANNELS.includes(answer)) throw new Error(`Unknown release channel: ${answer}`);
  return answer;
}

function releaseBody(version: string, branch: string, preview: string): string {
  return `## Purpose

Prepare Axl v${version} from the protected \`${branch}\` release line.

## Fixes

No linked issue. This is a release preparation change.

## Approach

Update release metadata, the npm package version, and attached release notes. The release workflow will build one package tarball and publish the identical bytes to npm and GitHub Releases.

## How was this tested?

- The release command validated branch ancestry, version progression, tag state, and the generated metadata.
- Required CI and publication checks remain pending on this pull request.

## Learning

The release line remains independent from \`main\`; fixes move between lines through tracked backport pull requests.

## Release preview

${preview}

## Checklist

- [x] I reviewed the complete generated release diff.
- [ ] I added or updated the smallest relevant test for behavior changes. Not applicable to generated release metadata.
- [ ] I ran the relevant formatting, lint, type-check, test, boundary, and license checks. CI pending.
- [x] Every new file has SPDX metadata, directly or through \`REUSE.toml\`.
- [x] Every commit has a matching DCO \`Signed-off-by\` trailer.
- [ ] UI changes include screenshots attached to the pull request, not committed to the repository. Not applicable.

## AI assistance

- [ ] Generative AI materially assisted this change. Tool and model/version: Not applicable to generated release metadata.
- [x] I manually reviewed, understood, and tested the generated work.
`;
}

function createReleaseWorktree(input: {
  readonly version: string;
  readonly channel: Channel;
  readonly npmTag: string;
  readonly branch: string;
  readonly previousTag?: string;
  readonly cutoff: string;
  readonly changes: readonly Change[];
  readonly repo: string;
  readonly fork: string;
}): string {
  const releaseBranch = `release-prep/v${input.version}`;
  const worktree = join(ROOT, ".worktrees", `release-v${input.version}`);
  if (existsSync(worktree) || git("branch", "--list", releaseBranch)) {
    throw new Error(`Release worktree or branch already exists: ${releaseBranch}`);
  }
  run("git", ["worktree", "add", "-b", releaseBranch, worktree, input.cutoff], { capture: false });
  let completed = false;
  try {
    updateDistributionVersion(join(worktree, "distribution", "npm", "package.json"), input.version);
    const notes = renderReleaseNotes(input);
    writeFileSync(join(worktree, ".github", "release-notes.md"), notes);
    const manifest: ReleaseManifest = {
      version: input.version,
      channel: input.channel,
      npmTag: input.npmTag,
      branch: input.branch,
      previousTag: input.previousTag ?? null,
      cutoff: input.cutoff,
      createdAt: new Date().toISOString(),
      includedPrs: input.changes.flatMap((change) => (change.pr ? [change.pr] : [])),
      backports: input.changes.flatMap((change) =>
        change.pr && change.originalPr
          ? [{ originalPr: change.originalPr, backportPr: change.pr }]
          : [],
      ),
    };
    writeManifest(join(worktree, ".release.json"), manifest);
    const files = [".release.json", ".github/release-notes.md", "distribution/npm/package.json"];
    run("git", ["add", ...files], { cwd: worktree });
    run("git", ["diff", "--cached", "--check"], { cwd: worktree });
    run("git", ["commit", "--signoff", "-m", `chore(release): v${input.version}`], {
      cwd: worktree,
      capture: false,
    });
    run("git", ["push", input.fork, releaseBranch], { cwd: worktree, capture: false });
    const forkRepo = repository(input.fork);
    const owner = forkRepo.split("/")[0] as string;
    const temporary = mkdtempSync(join(tmpdir(), "axl-release-pr-"));
    const bodyPath = join(temporary, "body.md");
    writeFileSync(bodyPath, releaseBody(input.version, input.branch, notes));
    try {
      const url = run(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          input.repo,
          "--head",
          `${owner}:${releaseBranch}`,
          "--base",
          input.branch,
          "--title",
          `chore(release): v${input.version}`,
          "--body-file",
          bodyPath,
        ],
        { cwd: worktree },
      );
      completed = true;
      return url;
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  } catch (error) {
    process.stderr.write(`Release worktree preserved for recovery: ${worktree}\n`);
    throw error;
  } finally {
    if (completed) run("git", ["worktree", "remove", worktree]);
  }
}

async function prepareRelease(options: CliOptions, channelInput?: Channel): Promise<void> {
  requireClean();
  requireCommand("git");
  requireCommand("gh");
  const branch = currentBranch();
  const series = releaseBranchSeries(branch);
  requireCurrentBranch(options.upstream, branch);
  fetch(options.upstream);
  const repo = repository(options.upstream);
  const tags = tagsMergedIntoHead();
  const allTags = lines(git("tag", "--list", "v*"));
  const channel = channelInput ?? options.channel ?? (await chooseChannel());
  const version = nextVersion(series, channel, tags);
  const previousTag = previousReference(tags, channel);
  const changes = discoverChanges(repo, previousTag ? `${previousTag}..HEAD` : undefined);
  const cutoff = git("rev-parse", "HEAD");
  const npmTag = npmTagFor(version, channel, allTags);
  const notes = renderReleaseNotes({
    repo,
    version,
    channel,
    ...(previousTag === undefined ? {} : { previousTag }),
    cutoff,
    changes,
  });
  process.stdout.write(`\nVersion: ${version}\nChannel: ${channel}\nnpm tag: ${npmTag}\n`);
  process.stdout.write(`Changes: ${changes.length}\n\n${notes}`);
  if (options.preview) return;
  if (process.stdin.isTTY) {
    const confirmation = (
      await ask("Create and push the release preparation PR? (yes/no): ")
    ).toLowerCase();
    if (confirmation !== "yes") throw new Error("Release cancelled");
  }
  const url = createReleaseWorktree({
    version,
    channel,
    npmTag,
    branch,
    ...(previousTag === undefined ? {} : { previousTag }),
    cutoff,
    changes,
    repo,
    fork: options.fork,
  });
  process.stdout.write(`Release PR created: ${url}\n`);
}

function cutRelease(series: string, options: CliOptions): void {
  requireClean();
  parseSeries(series);
  if (currentBranch() !== "main") throw new Error("Release branches must be cut from main");
  requireCurrentBranch(options.upstream, "main");
  const branch = `release/${series}`;
  const existing = spawnSync(
    "git",
    ["ls-remote", "--exit-code", "--heads", options.upstream, branch],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  if (existing.status === 0) throw new Error(`${options.upstream}/${branch} already exists`);
  if (existing.status !== 2)
    throw new Error(existing.stderr.trim() || "Cannot inspect remote branches");
  run("git", ["push", options.upstream, `HEAD:refs/heads/${branch}`], { capture: false });
  process.stdout.write(`Created ${options.upstream}/${branch} at ${git("rev-parse", "HEAD")}\n`);
}

function backportBody(original: number, target: string, commits: readonly string[]): string {
  return `## Purpose

Backport #${original} to \`${target}\`.

Backport-of: #${original}
Target: ${target}
Original-commits:
${commits.map((commit) => `- ${commit}`).join("\n")}

## Fixes

No separate issue. This backports #${original}.

## Approach

Cherry-pick the original pull request commits in order with provenance trailers.

## How was this tested?

Checks are pending on this backport pull request.

## Learning

Not applicable.

## Checklist

- [ ] I reviewed the complete diff.
- [ ] I added or updated the smallest relevant test for behavior changes.
- [ ] I ran the relevant formatting, lint, type-check, test, boundary, and license checks.
- [x] Every new file has SPDX metadata, directly or through \`REUSE.toml\`.
- [x] Every commit has a matching DCO \`Signed-off-by\` trailer.
- [ ] UI changes include screenshots attached to the pull request, not committed to the repository.

## AI assistance

- [ ] Generative AI materially assisted this change. Tool and model/version:
- [ ] I manually reviewed, understood, and tested the generated work.
`;
}

function createBackport(original: number, target: string, options: CliOptions): void {
  requireClean();
  releaseBranchSeries(target);
  fetch(options.upstream, target);
  const repo = repository(options.upstream);
  const pull = ghJson(repo, `pulls/${original}`) as {
    readonly merged: boolean;
    readonly title: string;
    readonly base: { readonly ref: string };
  };
  if (!pull.merged) throw new Error(`Pull request #${original} is not merged`);
  if (pull.base.ref !== "main") {
    throw new Error(
      `Pull request #${original} targets ${pull.base.ref}; backports must originate on main`,
    );
  }
  const commits = ghJson(repo, `pulls/${original}/commits`) as readonly { readonly sha: string }[];
  if (commits.length === 0) throw new Error(`Pull request #${original} has no commits`);
  const series = target.slice("release/".length);
  const branch = `backport/${series}/${original}`;
  const worktree = join(ROOT, ".worktrees", `backport-${series}-${original}`);
  if (existsSync(worktree) || git("branch", "--list", branch)) {
    throw new Error(`Backport worktree or branch already exists: ${branch}`);
  }
  run("git", ["worktree", "add", "-b", branch, worktree, `${options.upstream}/${target}`], {
    capture: false,
  });
  let completed = false;
  try {
    for (const commit of commits) {
      run("git", ["cherry-pick", "-x", commit.sha], { cwd: worktree, capture: false });
    }
    run("git", ["push", options.fork, branch], { cwd: worktree, capture: false });
    const forkOwner = repository(options.fork).split("/")[0] as string;
    const temporary = mkdtempSync(join(tmpdir(), "axl-backport-pr-"));
    const bodyPath = join(temporary, "body.md");
    writeFileSync(
      bodyPath,
      backportBody(
        original,
        target,
        commits.map((commit) => commit.sha),
      ),
    );
    try {
      const url = run(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          repo,
          "--head",
          `${forkOwner}:${branch}`,
          "--base",
          target,
          "--title",
          `[${series}] ${pull.title}`,
          "--body-file",
          bodyPath,
        ],
        { cwd: worktree },
      );
      process.stdout.write(`Backport PR created: ${url}\n`);
      completed = true;
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  } catch (error) {
    process.stderr.write(`Backport worktree preserved for recovery: ${worktree}\n`);
    throw error;
  } finally {
    if (completed) run("git", ["worktree", "remove", worktree]);
  }
}

function showStatus(upstream: string): void {
  requireClean();
  const branch = currentBranch();
  if (branch === "main") {
    requireCurrentBranch(upstream, branch);
    const releaseBranches = lines(
      git("for-each-ref", "--format=%(refname:short)", `refs/remotes/${upstream}/release/`),
    );
    process.stdout.write("Release lines:\n");
    for (const releaseBranch of releaseBranches) process.stdout.write(`  ${releaseBranch}\n`);
    if (releaseBranches.length === 0) process.stdout.write("  none\n");
    return;
  }
  const series = releaseBranchSeries(branch);
  requireCurrentBranch(upstream, branch);
  const tags = tagsMergedIntoHead();
  const latest = latestVersionTag(tags);
  const pending = commitLog(latest ? `${latest}..HEAD` : undefined).filter(
    (commit) => !RELEASE_COMMIT.test(commit.title),
  );
  process.stdout.write(`Release line: ${series}\n`);
  process.stdout.write(`Latest tag: ${latest ?? "none"}\n`);
  process.stdout.write(`Unreleased commits: ${pending.length}\n`);
  for (const commit of pending)
    process.stdout.write(`  ${commit.sha.slice(0, 7)} ${commit.title}\n`);
}

function resolvePush(options: CliOptions): void {
  if (!options.before || !options.after || !options.branch) {
    throw new Error("--resolve-push requires --before, --after, and --branch");
  }
  releaseBranchSeries(options.branch);
  const range = /^0+$/.test(options.before) ? options.after : `${options.before}..${options.after}`;
  const commits = commitLog(range);
  const releases = commits.filter((commit) => RELEASE_COMMIT.test(commit.title));
  if (releases.length === 0) return;
  if (releases.length !== 1) throw new Error("Push contains more than one release commit");
  const release = releases[0] as Commit;
  const changed = lines(git("diff-tree", "--no-commit-id", "--name-only", "-r", release.sha));
  if (!changed.includes(".release.json"))
    throw new Error("Release commit does not update .release.json");
  const manifest = JSON.parse(git("show", `${release.sha}:.release.json`)) as ReleaseManifest;
  parseVersion(manifest.version);
  if (!CHANNELS.includes(manifest.channel)) throw new Error(`Invalid channel ${manifest.channel}`);
  if (manifest.branch !== options.branch)
    throw new Error("Release manifest branch does not match push");
  const parent = git("show", "-s", "--format=%P", release.sha).split(" ");
  if (parent.length !== 1 || parent[0] !== manifest.cutoff) {
    throw new Error("Release manifest cutoff must be the release commit parent");
  }
  const packageManifest = JSON.parse(
    git("show", `${release.sha}:distribution/npm/package.json`),
  ) as { readonly version?: string };
  if (packageManifest.version !== manifest.version) {
    throw new Error("Release manifest and npm package versions differ");
  }
  const outputs = {
    release: "true",
    version: manifest.version,
    channel: manifest.channel,
    npm_tag: manifest.npmTag,
    tag: `v${manifest.version}`,
    target: release.sha,
    branch: manifest.branch,
  };
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    const rendered = Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    writeFileSync(outputPath, `${rendered}\n`, { flag: "a" });
  } else {
    process.stdout.write(`${JSON.stringify(outputs)}\n`);
  }
}

function parseArguments(argv: readonly string[]): CliOptions {
  const args = argv.filter((argument) => argument !== "--");
  let preview = false;
  let cut: string | undefined;
  let channel: Channel | undefined;
  let backport: number | undefined;
  let to: string | undefined;
  let status = false;
  let resolvePushFlag = false;
  let before: string | undefined;
  let after: string | undefined;
  let branch: string | undefined;
  let upstream = "upstream";
  let fork = "origin";
  const next = (index: number, option: string): string => {
    const value = args[index + 1];
    if (!value) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--preview") preview = true;
    else if (argument === "--status") status = true;
    else if (argument === "--resolve-push") resolvePushFlag = true;
    else if (argument === "--cut") cut = next(index++, argument);
    else if (argument === "--channel") {
      const value = next(index++, argument) as Channel;
      if (!CHANNELS.includes(value)) throw new Error(`Unknown release channel: ${value}`);
      channel = value;
    } else if (argument === "--backport") backport = Number(next(index++, argument));
    else if (argument === "--to") to = next(index++, argument);
    else if (argument === "--before") before = next(index++, argument);
    else if (argument === "--after") after = next(index++, argument);
    else if (argument === "--branch") branch = next(index++, argument);
    else if (argument === "--upstream") upstream = next(index++, argument);
    else if (argument === "--fork") fork = next(index++, argument);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (backport !== undefined && (!Number.isSafeInteger(backport) || backport <= 0)) {
    throw new Error("--backport requires a positive pull request number");
  }
  return {
    preview,
    ...(cut === undefined ? {} : { cut }),
    ...(channel === undefined ? {} : { channel }),
    ...(backport === undefined ? {} : { backport }),
    ...(to === undefined ? {} : { to }),
    status,
    resolvePush: resolvePushFlag,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    ...(branch === undefined ? {} : { branch }),
    upstream,
    fork,
  };
}

async function interactive(options: CliOptions): Promise<void> {
  const branch = currentBranch();
  const actions =
    branch === "main"
      ? "cut, status"
      : RELEASE_BRANCH.test(branch)
        ? "prepare, backport, status, preview"
        : "status";
  const action = await ask(`Action (${actions}): `);
  if (action === "cut") return cutRelease(await ask("Release series (X.Y): "), options);
  if (action === "prepare") return prepareRelease(options);
  if (action === "preview") return prepareRelease({ ...options, preview: true });
  if (action === "status") return showStatus(options.upstream);
  if (action === "backport") {
    const original = Number(await ask("Merged pull request number: "));
    if (!Number.isSafeInteger(original) || original <= 0)
      throw new Error("Invalid pull request number");
    return createBackport(original, branch, options);
  }
  throw new Error(`Unknown action: ${action}`);
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.resolvePush) return resolvePush(options);
  if (options.cut) return cutRelease(options.cut, options);
  if (options.backport) {
    if (!options.to) throw new Error("--backport requires --to release/X.Y");
    return createBackport(options.backport, options.to, options);
  }
  if (options.status) return showStatus(options.upstream);
  if (options.channel || options.preview) return prepareRelease(options, options.channel);
  return interactive(options);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`release: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
