import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runProcessParsed } from "../../maintenance/process.mjs";
import {
  LockHeldError,
  SchemaError,
  StateJournal,
  acquireRunLock,
  boundDetail,
  createMinimalEnvironment,
  ensurePrivateDirectory,
  evaluateDiffPolicy,
  parseIntent,
  parseStrictJson,
  prepareCandidate,
  readState,
  resolveTrustedExecutable,
  runProcess,
  validateMirrorConfigEntries,
  writeJsonAtomic,
} from "../../maintenance/index.mjs";

const gitPath = await resolveTrustedExecutable("git");
const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

function intent(runId, upstream, downstream, extra = {}) {
  return JSON.stringify({
    schema: "wayang-maintenance-run/v1",
    runId,
    operation: "prepare",
    repository: "pi",
    expected: { upstream, downstream },
    ...extra,
  });
}

async function temporary(t, prefix = "wayang-maintenance-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function fixtureEnvironment(root) {
  return {
    HOME: join(root, "fixture-home"),
    TMPDIR: join(root, "fixture-tmp"),
    PATH: process.platform === "darwin" ? "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin" : "/usr/local/bin:/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "fixture-home", ".gitconfig-disabled"),
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(root, cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync(gitPath, args, {
    cwd,
    env: fixtureEnvironment(root),
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`synthetic Git command failed: git ${args.join(" ")}\n${result.stderr}`);
  }
  return result;
}

async function createGitFixture(t, { upstreamChange, downstreamChange } = {}) {
  const root = await temporary(t, "wayang-maintenance-git-");
  await mkdir(join(root, "fixture-home"), { mode: 0o700 });
  await mkdir(join(root, "fixture-tmp"), { mode: 0o700 });
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  git(root, root, ["init", "--bare", remote]);
  await mkdir(seed, { mode: 0o700 });
  git(root, seed, ["init"]);
  await writeFile(join(seed, "shared.txt"), "base\n");
  await writeFile(join(seed, "ordinary.txt"), "base\n");
  git(root, seed, ["add", "--", "shared.txt", "ordinary.txt"]);
  git(root, seed, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-m", "base"]);
  git(root, seed, ["branch", "-M", "main"]);
  git(root, seed, ["remote", "add", "origin", remote]);
  git(root, seed, ["push", "-u", "origin", "main"]);
  git(root, root, [`--git-dir=${remote}`, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const base = git(root, seed, ["rev-parse", "HEAD"]).stdout.trim();

  git(root, seed, ["switch", "-c", "upstream", base]);
  if (upstreamChange) await upstreamChange({ root, seed });
  else await writeFile(join(seed, "ordinary.txt"), "upstream\n");
  git(root, seed, ["add", "-A"]);
  git(root, seed, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-m", "upstream"]);
  const upstream = git(root, seed, ["rev-parse", "HEAD"]).stdout.trim();
  git(root, seed, ["push", "origin", "upstream"]);

  git(root, seed, ["switch", "main"]);
  let downstream = base;
  if (downstreamChange) {
    await downstreamChange({ root, seed });
    git(root, seed, ["add", "-A"]);
    git(root, seed, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-m", "downstream"]);
    downstream = git(root, seed, ["rev-parse", "HEAD"]).stdout.trim();
    git(root, seed, ["push", "origin", "main"]);
  }
  return { root, remote, seed, base, upstream, downstream };
}

async function engineConfig(fixture) {
  const stateRoot = join(fixture.root, "state");
  const syntheticHome = join(stateRoot, "synthetic-home");
  const syntheticTmp = join(stateRoot, "tmp");
  await mkdir(stateRoot, { mode: 0o700 });
  return {
    stateRoot,
    mirrorPath: join(stateRoot, "mirrors", "pi.git"),
    worktreeRoot: join(stateRoot, "worktrees"),
    syntheticHome,
    syntheticTmp,
    gitPath,
    remote: fixture.remote,
    upstreamRef: "refs/heads/upstream",
    downstreamRef: "refs/heads/main",
  };
}

test("strict intent schema rejects duplicate, unknown, executable, and oversized input", () => {
  assert.deepEqual(parseIntent(intent("run-1", OID_A, OID_B)).expected, { upstream: OID_A, downstream: OID_B });
  assert.throws(
    () => parseIntent(`{"schema":"wayang-maintenance-run/v1","schema":"wayang-maintenance-run/v1","runId":"x","operation":"prepare","repository":"pi","expected":{"upstream":"${OID_A}","downstream":"${OID_B}"}}`),
    /duplicate object key/,
  );
  assert.throws(() => parseIntent(intent("run-2", OID_A, OID_B, { command: "git push" })), /unknown field "command"/);
  assert.throws(() => parseIntent(intent("run-3", OID_A, OID_B, { environment: {} })), /unknown field "environment"/);
  assert.throws(() => parseIntent(Buffer.alloc(16 * 1024 + 1, 0x20)), /exceeds 16384 bytes/);
  assert.throws(() => parseIntent("{\"schema\":\"wrong\"}"), SchemaError);
  assert.throws(() => parseIntent(intent("sha256", "a".repeat(64), OID_B)), /40-character SHA-1/);
  const proto = parseStrictJson('{"__proto__":{"polluted":true}}');
  assert.equal(Object.getPrototypeOf(proto), null);
  assert.equal(proto.__proto__.polluted, true);
  assert.equal({}.polluted, undefined);
  assert.throws(
    () => parseIntent(`{"schema":"wayang-maintenance-run/v1","runId":"proto","operation":"prepare","repository":"pi","expected":{"upstream":"${OID_A}","downstream":"${OID_B}"},"__proto__":{}}`),
    /unknown field "__proto__"/,
  );
});

test("trusted executable resolution ignores ambient PATH unless explicitly supplied", async (t) => {
  const root = await temporary(t);
  const fakeGit = join(root, "git");
  await writeFile(fakeGit, "synthetic fixture; never execute\n", { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = root;
  let resolved;
  try {
    resolved = await resolveTrustedExecutable("git");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
  assert.notEqual(resolved, fakeGit);
  assert.equal(await resolveTrustedExecutable("git", root), fakeGit);
});

test("first-run private hierarchy is component-wise and rejects symlink ancestors", async (t) => {
  const root = await temporary(t);
  const nested = join(root, "first", "second", "third");
  await ensurePrivateDirectory(nested);
  for (const path of [join(root, "first"), join(root, "first", "second"), nested]) {
    const metadata = await lstat(path);
    assert.equal(metadata.isDirectory(), true);
    if (process.platform !== "win32") assert.equal(metadata.mode & 0o077, 0);
  }
  const outside = join(root, "outside");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, join(root, "linked"), "dir");
  await assert.rejects(ensurePrivateDirectory(join(root, "linked", "child")), /unsafe directory ancestor/);
  assert.equal(existsSync(join(outside, "child")), false);
});

test("portable run lock is exclusive and releases without stale takeover", async (t) => {
  const root = await temporary(t);
  const lockPath = join(root, "locks", "run.lock");
  const first = await acquireRunLock(lockPath);
  await assert.rejects(acquireRunLock(lockPath), LockHeldError);
  await first.release();
  const second = await acquireRunLock(lockPath);
  await second.release();
  assert.equal(existsSync(lockPath), false);
});

test("raced lock replacement is never unlinked", async (t) => {
  const root = await temporary(t);
  const lockPath = join(root, "locks", "run.lock");
  const held = await acquireRunLock(lockPath);
  await rm(lockPath);
  await writeFile(lockPath, "replacement\n", { mode: 0o600 });
  await assert.rejects(held.release(), /refusing to unlink replacement/);
  assert.equal(await readFile(lockPath, "utf8"), "replacement\n");
});

test("state journal allows only declared atomic transitions and rejects unknown persisted fields", async (t) => {
  const root = await temporary(t);
  const statePath = join(root, "run", "state.json");
  const journal = new StateJournal(statePath, "state-run", { now: () => new Date("2026-08-14T12:00:00.000Z") });
  await journal.initialize();
  await journal.transition("initialized", "locked");
  await assert.rejects(journal.transition("locked", "completed"), /forbidden/);
  await journal.transition("locked", "failed", { reason: "internal_error", details: ["SyntheticError"] });
  const terminal = await readState(statePath);
  assert.equal(terminal.phase, "failed");
  assert.equal(terminal.sequence, 2);
  await assert.rejects(journal.transition("failed", "locked"), /forbidden/);

  await writeJsonAtomic(statePath, { ...terminal, phase: "completed", reason: null, candidateOid: OID_A });
  await assert.rejects(readState(statePath), /predecessor|sequence/);
  await writeJsonAtomic(statePath, { ...terminal, surprise: true });
  await assert.rejects(readState(statePath), /unknown field "surprise"/);
  const bounded = boundDetail(`critical:${"x".repeat(4096)}`);
  assert.ok(Buffer.byteLength(bounded) <= 512);
  assert.match(bounded, /\.\.\.\[truncated\]$/);
});

test("shell-free process runner sanitizes environment and bounds/redacts malicious output", async (t) => {
  const root = await temporary(t);
  const home = join(root, "home");
  const scratch = join(root, "tmp");
  await mkdir(home, { mode: 0o700 });
  await mkdir(scratch, { mode: 0o700 });
  const environment = createMinimalEnvironment({ home, tmpDir: scratch });
  const syntheticSecret = "synthetic-secret-value";
  process.env.MAINTENANCE_AMBIENT_SECRET = syntheticSecret;
  let probe;
  try {
    probe = await runProcess({
      executable: process.execPath,
      args: ["--input-type=module", "-e", `console.log(JSON.stringify({ambient:process.env.MAINTENANCE_AMBIENT_SECRET||null,nodeOptions:process.env.NODE_OPTIONS||null,home:process.env.HOME})); console.error("API_TOKEN=${syntheticSecret}");`],
      cwd: root,
      environment,
      redactionSecrets: [syntheticSecret],
    });
  } finally {
    delete process.env.MAINTENANCE_AMBIENT_SECRET;
  }
  assert.equal(probe.ok, true);
  assert.deepEqual(JSON.parse(probe.stdout), { ambient: null, nodeOptions: null, home });
  assert.doesNotMatch(probe.stderr, /synthetic-secret-value/);
  assert.match(probe.stderr, /API_TOKEN=\[REDACTED\]/);
  const protocol = await runProcessParsed({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('API_TOKEN=synthetic-protocol-value\\n')"],
    cwd: root,
    environment,
  }, (bytes) => Object.freeze({ exact: bytes.toString("utf8") === "API_TOKEN=synthetic-protocol-value\n" }));
  assert.deepEqual(protocol.parsedStdout, { exact: true });
  assert.match(protocol.stdout, /API_TOKEN=\[REDACTED\]/);
  assert.doesNotMatch(protocol.stdout, /synthetic-protocol-value/);
  await assert.rejects(runProcess({
    executable: process.execPath,
    args: ["--version"],
    cwd: root,
    environment: { ...environment, NODE_OPTIONS: "--inspect" },
  }), /exactly the minimal allowlist/);

  const flood = await runProcess({
    executable: process.execPath,
    args: ["--input-type=module", "-e", "process.stdout.write('x'.repeat(200000)); setInterval(()=>{},1000)"],
    cwd: root,
    environment,
    maxOutputBytes: 1024,
    timeoutMs: 5_000,
  });
  assert.equal(flood.ok, false);
  assert.equal(flood.outputLimitExceeded, true);
  assert.match(flood.stderr, /\[output truncated: limit exceeded\]$/);
  assert.ok(Buffer.byteLength(flood.stdout) + Buffer.byteLength(flood.stderr) <= 1024);

  const descendantSentinel = join(root, "descendant-must-die");
  const descendantCode = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); setTimeout(()=>fs.writeFileSync(${JSON.stringify(descendantSentinel)},'survived'),900); setInterval(()=>{},1000);`;
  const leaderCode = `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:'ignore'}); process.stdout.write('x'.repeat(200000)); setInterval(()=>{},1000);`;
  const outputStopStarted = Date.now();
  const descendants = await runProcess({
    executable: process.execPath,
    args: ["-e", leaderCode],
    cwd: root,
    environment,
    maxOutputBytes: 1024,
    timeoutMs: 5_000,
  });
  assert.equal(descendants.outputLimitExceeded, true);
  assert.ok(Date.now() - outputStopStarted >= 450);
  assert.equal(existsSync(descendantSentinel), false);

  const timeoutSentinel = join(root, "timeout-descendant-must-die");
  const timeoutDescendant = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); setTimeout(()=>fs.writeFileSync(${JSON.stringify(timeoutSentinel)},'survived'),900); setInterval(()=>{},1000);`;
  const timeoutLeader = `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',${JSON.stringify(timeoutDescendant)}],{stdio:'ignore'}); setInterval(()=>{},1000);`;
  const timeoutStarted = Date.now();
  const timedOut = await runProcess({
    executable: process.execPath,
    args: ["-e", timeoutLeader],
    cwd: root,
    environment,
    timeoutMs: 200,
  });
  assert.equal(timedOut.timedOut, true);
  assert.ok(Date.now() - timeoutStarted >= 650);
  assert.equal(existsSync(timeoutSentinel), false);
  await delay(300);
  assert.equal(existsSync(timeoutSentinel), false);
});

test("critical path policy is deterministic and fails closed on unsafe paths", () => {
  const allowed = evaluateDiffPolicy(["src/z.mjs", "README.md", "src/z.mjs"]);
  assert.deepEqual({ allowed: allowed.allowed, checkedPaths: allowed.checkedPaths }, { allowed: true, checkedPaths: 2 });
  const blocked = evaluateDiffPolicy(["src/native.cc", ".github/workflows/check.yml", "package.json", ".gitattributes"]);
  assert.equal(blocked.allowed, false);
  assert.deepEqual(blocked.violations.map((item) => item.path), [".gitattributes", ".github/workflows/check.yml", "package.json", "src/native.cc"]);
  assert.throws(() => evaluateDiffPolicy(["../package.json"]), /not normalized/);
  const collision = evaluateDiffPolicy(["src/Name.mjs", "src/name.mjs"]);
  assert.equal(collision.allowed, false);
  assert.match(collision.violations[0].reason, /collision/);
  assert.equal(evaluateDiffPolicy(["PaCkAgE.JsOn"]).violations[0].reason, "package_manifest");
  assert.throws(() => evaluateDiffPolicy(["src/evil\u202Ename.mjs"]), /path controls/);
  assert.throws(() => evaluateDiffPolicy(["src/trailing."]), /trailing dot or space/);
  assert.throws(() => evaluateDiffPolicy(["src/trailing "]), /trailing dot or space/);
});

test("mirror trust boundary accepts only exact inert M1 mirror configuration", () => {
  const remote = "/synthetic/remote.git";
  const entries = [
    { name: "core.repositoryformatversion", values: ["0"] },
    { name: "core.filemode", values: ["true"] },
    { name: "core.bare", values: ["true"] },
    { name: "remote.origin.url", values: [remote] },
    { name: "remote.origin.tagopt", values: ["--no-tags"] },
  ];
  assert.deepEqual(validateMirrorConfigEntries(entries, remote), {
    "core.bare": "true",
    "core.filemode": "true",
    "core.repositoryformatversion": "0",
    "remote.origin.tagopt": "--no-tags",
    "remote.origin.url": remote,
  });
  assert.throws(
    () => validateMirrorConfigEntries(entries.map((entry) => entry.name === "remote.origin.tagopt" ? { ...entry, values: ["--upload-pack=malicious"] } : entry), remote),
    /tag option is invalid/,
  );
  for (const forbidden of [
    { name: "remote.origin.uploadpack", values: ["malicious"] },
    { name: "remote.origin.fetch", values: ["+refs/*:refs/*"] },
    { name: "remote.origin.mirror", values: ["true"] },
    { name: "extensions.objectformat", values: ["sha256"] },
  ]) {
    assert.throws(() => validateMirrorConfigEntries([...entries, forbidden], remote), /forbidden Git configuration/);
  }
});

test("trusted engine resources must remain inside one locked state root", async (t) => {
  const root = await temporary(t);
  const stateRoot = join(root, "state");
  const config = {
    stateRoot,
    mirrorPath: join(root, "outside-mirror.git"),
    worktreeRoot: join(stateRoot, "worktrees"),
    syntheticHome: join(stateRoot, "home"),
    syntheticTmp: join(stateRoot, "tmp"),
    gitPath,
    remote: join(root, "unused-remote.git"),
    upstreamRef: "refs/heads/upstream",
    downstreamRef: "refs/heads/main",
  };
  await assert.rejects(prepareCandidate(intent("outside-root", OID_A, OID_B), config), /mirrorPath must be a strict descendant/);
  config.mirrorPath = join(stateRoot, "mirror.git");
  config.syntheticTmp = stateRoot;
  await assert.rejects(prepareCandidate(intent("root-equality", OID_A, OID_B), config), /syntheticTmp must be a strict descendant/);
});

test("changed Pi heads return a durable stale_base result without creating a worktree", async (t) => {
  const fixture = await createGitFixture(t);
  const config = await engineConfig(fixture);
  const result = await prepareCandidate(intent("stale-base", OID_A, fixture.downstream), config);
  assert.equal(result.outcome, "stale_base");
  assert.equal(result.state.phase, "blocked");
  assert.equal(result.state.reason, "stale_base");
  assert.deepEqual(result.state.details, ["observed_refs_changed"]);
  assert.deepEqual(result.state.refs, { upstream: fixture.upstream, downstream: fixture.downstream });
  assert.equal(existsSync(join(config.worktreeRoot, "stale-base")), false);
  assert.deepEqual(await readState(result.statePath), result.state);
});

test("clean upstream advancement creates an exact two-parent candidate and durable terminal state", async (t) => {
  const fixture = await createGitFixture(t);
  const config = await engineConfig(fixture);
  const result = await prepareCandidate(intent("clean-advance", fixture.upstream, fixture.downstream), config);
  assert.equal(result.outcome, "completed");
  assert.equal(result.state.phase, "completed");
  assert.equal(result.state.candidateOid, result.candidateOid);
  const parents = git(fixture.root, result.worktreePath, ["show", "-s", "--format=%P", result.candidateOid]).stdout.trim().split(" ");
  assert.deepEqual(parents, [fixture.downstream, fixture.upstream]);
  const persisted = await readState(result.statePath);
  assert.deepEqual(persisted, result.state);
  assert.equal(Object.getPrototypeOf(persisted), Object.prototype);
  assert.equal(Object.getPrototypeOf(persisted.refs), Object.prototype);
  assert.equal(Object.isFrozen(persisted), true);
  assert.equal(Object.isFrozen(persisted.refs), true);
  assert.equal(Object.isFrozen(persisted.details), true);
});

test("existing mirror with alternates is rejected before ref fetch or worktree creation", async (t) => {
  const fixture = await createGitFixture(t);
  const config = await engineConfig(fixture);
  await prepareCandidate(intent("mirror-bootstrap", fixture.upstream, fixture.downstream), config);
  await writeFile(join(config.mirrorPath, "objects", "info", "alternates"), "/synthetic/forbidden\n");
  await assert.rejects(
    prepareCandidate(intent("reject-alternates", fixture.upstream, fixture.downstream), config),
    /forbidden state: objects\/info\/alternates/,
  );
  assert.equal(existsSync(join(config.worktreeRoot, "reject-alternates")), false);
  assert.equal((await readState(join(config.stateRoot, "runs", "reject-alternates", "state.json"))).phase, "failed");
});

test("already-integrated upstream returns durable no_action without creating a worktree", async (t) => {
  const fixture = await createGitFixture(t);
  const config = await engineConfig(fixture);
  config.upstreamRef = "refs/heads/main";
  const result = await prepareCandidate(intent("already-current", fixture.downstream, fixture.downstream), config);
  assert.equal(result.outcome, "no_action");
  assert.equal(result.state.reason, "pi_up_to_date");
  assert.equal(result.state.previousPhase, "refs_snapshot");
  assert.equal(result.state.sequence, 3);
  assert.equal(result.candidateOid, fixture.downstream);
  assert.equal(existsSync(join(config.worktreeRoot, "already-current")), false);
});

test("post-merge candidate policy catches a critical path produced by rename propagation", async (t) => {
  const fixture = await createGitFixture(t, {
    upstreamChange: async ({ seed }) => writeFile(join(seed, "ordinary.txt"), "upstream edit\n"),
    downstreamChange: async ({ seed }) => rename(join(seed, "ordinary.txt"), join(seed, "Package.JSON")),
  });
  const config = await engineConfig(fixture);
  const result = await prepareCandidate(intent("candidate-policy-block", fixture.upstream, fixture.downstream), config);
  assert.equal(result.outcome, "blocked");
  assert.equal(result.state.reason, "candidate_tree_policy");
  assert.ok(result.candidateOid);
  assert.equal(existsSync(result.worktreePath), true);
  assert.deepEqual(result.policy.violations.map((item) => item.path), ["Package.JSON"]);
});

test("merge conflict is preserved and classified without unattended resolution", async (t) => {
  const fixture = await createGitFixture(t, {
    upstreamChange: async ({ seed }) => writeFile(join(seed, "shared.txt"), "upstream side\n"),
    downstreamChange: async ({ seed }) => writeFile(join(seed, "shared.txt"), "downstream side\n"),
  });
  const config = await engineConfig(fixture);
  const result = await prepareCandidate(intent("merge-conflict", fixture.upstream, fixture.downstream), config);
  assert.equal(result.outcome, "blocked");
  assert.equal(result.state.reason, "merge_conflict");
  assert.deepEqual(result.conflicts, ["shared.txt"]);
  assert.equal(existsSync(result.worktreePath), true);
});

test("case-variant rename to package.json is blocked before worktree creation", async (t) => {
  const fixture = await createGitFixture(t, {
    upstreamChange: async ({ seed }) => rename(join(seed, "ordinary.txt"), join(seed, "PaCkAgE.JsOn")),
  });
  const config = await engineConfig(fixture);
  const result = await prepareCandidate(intent("rename-policy-block", fixture.upstream, fixture.downstream), config);
  assert.equal(result.outcome, "blocked");
  assert.equal(result.state.reason, "critical_path_policy");
  assert.equal(existsSync(join(config.worktreeRoot, "rename-policy-block")), false);
  assert.deepEqual(result.policy.violations.map((item) => item.path), ["PaCkAgE.JsOn"]);
});

test("critical lifecycle diff blocks before worktree creation or malicious code execution", async (t) => {
  let sentinel;
  const fixture = await createGitFixture(t, {
    upstreamChange: async ({ root, seed }) => {
      sentinel = join(root, "must-not-exist");
      await writeFile(join(seed, "package.json"), JSON.stringify({
        name: "synthetic-malicious-fixture",
        scripts: { postinstall: `node malicious.mjs ${sentinel}` },
      }));
      await writeFile(join(seed, "malicious.mjs"), "throw new Error('must never execute');\n");
    },
  });
  const config = await engineConfig(fixture);
  const result = await prepareCandidate(intent("policy-block", fixture.upstream, fixture.downstream), config);
  assert.equal(result.outcome, "blocked");
  assert.equal(result.state.reason, "critical_path_policy");
  assert.equal(existsSync(join(config.worktreeRoot, "policy-block")), false);
  assert.equal(existsSync(sentinel), false);
  assert.deepEqual(result.policy.violations.map((item) => item.path), ["package.json"]);
});
