import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseIntent } from "./schema.mjs";
import { boundDetail, ensureEmptyRegularFile, ensurePrivateDirectory, fsyncDirectory, readState, StateJournal } from "./fs-state.mjs";
import { acquireRunLock } from "./lock.mjs";
import { createMinimalEnvironment } from "./process.mjs";
import { GitClient } from "./git.mjs";
import { evaluateDiffPolicy, evaluatePathSafety } from "./policy.mjs";

async function ensureSafeDescendantDirectory(stateRoot, target) {
  const child = relative(stateRoot, target);
  if (child === "") return;
  await ensurePrivateDirectory(target);
}

function trustedConfig(config) {
  if (!config || typeof config !== "object") throw new TypeError("trusted configuration is required");
  for (const name of ["stateRoot", "mirrorPath", "worktreeRoot", "syntheticHome", "syntheticTmp", "gitPath"]) {
    if (!isAbsolute(config[name])) throw new TypeError(`trusted ${name} must be absolute`);
  }
  const stateRoot = resolve(config.stateRoot);
  const normalized = { ...config, stateRoot };
  for (const name of ["mirrorPath", "worktreeRoot", "syntheticHome", "syntheticTmp"]) {
    normalized[name] = resolve(config[name]);
    const child = relative(stateRoot, normalized[name]);
    if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new TypeError(`trusted ${name} must be a strict descendant of stateRoot`);
    }
  }
  for (const name of ["remote", "upstreamRef", "downstreamRef"]) {
    if (typeof config[name] !== "string" || config[name].length === 0) throw new TypeError(`trusted ${name} is required`);
  }
  return Object.freeze(normalized);
}

export async function prepareCandidate(intentInput, configuration) {
  if (typeof intentInput !== "string" && !Buffer.isBuffer(intentInput)) throw new TypeError("intent must be bounded JSON bytes or text");
  const intent = parseIntent(intentInput);
  const config = trustedConfig(configuration);
  await ensurePrivateDirectory(config.stateRoot);
  await ensureSafeDescendantDirectory(config.stateRoot, config.syntheticHome);
  await ensureSafeDescendantDirectory(config.stateRoot, config.syntheticTmp);
  await ensureSafeDescendantDirectory(config.stateRoot, config.worktreeRoot);
  await ensureSafeDescendantDirectory(config.stateRoot, dirname(config.mirrorPath));
  const lock = await acquireRunLock(join(config.stateRoot, "locks", "run.lock"));
  let journal;
  try {
    const runsRoot = join(config.stateRoot, "runs");
    await ensurePrivateDirectory(runsRoot);
    const runRoot = join(runsRoot, intent.runId);
    await fs.mkdir(runRoot, { recursive: false, mode: 0o700 });
    await fsyncDirectory(runsRoot);
    const statePath = join(runRoot, "state.json");
    journal = new StateJournal(statePath, intent.runId);
    await journal.initialize();
    await journal.transition("initialized", "locked");

    const environment = createMinimalEnvironment({ home: config.syntheticHome, tmpDir: config.syntheticTmp });
    const hooksPath = join(config.syntheticHome, "empty-hooks");
    const attributesFile = join(config.syntheticHome, "empty-attributes");
    await ensurePrivateDirectory(hooksPath);
    await ensureEmptyRegularFile(attributesFile);
    await ensureEmptyRegularFile(environment.GIT_CONFIG_GLOBAL);
    const git = new GitClient({ gitPath: config.gitPath, environment, cwd: config.stateRoot, hooksPath, attributesFile });
    await git.ensureMirror(config.remote, config.mirrorPath);
    const upstreamTracking = "refs/maintenance/upstream";
    const downstreamTracking = "refs/maintenance/downstream";
    await git.fetchExact(config.mirrorPath, "origin", [
      { source: config.upstreamRef, destination: upstreamTracking },
      { source: config.downstreamRef, destination: downstreamTracking },
    ]);
    const upstream = await git.resolveCommit([`--git-dir=${config.mirrorPath}`], upstreamTracking);
    const downstream = await git.resolveCommit([`--git-dir=${config.mirrorPath}`], downstreamTracking);
    const refs = { upstream, downstream };
    await journal.transition("locked", "refs_snapshot", { refs });
    if (upstream !== intent.expected.upstream || downstream !== intent.expected.downstream) {
      const state = await journal.transition("refs_snapshot", "failed", { reason: "ref_mismatch", refs });
      return Object.freeze({ outcome: "failed", state, statePath });
    }
    if (await git.isAncestor([`--git-dir=${config.mirrorPath}`], upstream, downstream)) {
      const state = await journal.transition("refs_snapshot", "completed", { refs, candidateOid: downstream, reason: "pi_up_to_date" });
      return Object.freeze({ outcome: "no_action", state, statePath, candidateOid: downstream });
    }

    const changedPaths = await git.changedPaths(config.mirrorPath, downstream, upstream);
    const policy = evaluateDiffPolicy(changedPaths);
    if (!policy.allowed) {
      const details = policy.violations.slice(0, 64).map(({ path, reason }) => boundDetail(`${reason}:${path}`));
      const state = await journal.transition("refs_snapshot", "blocked", { reason: "critical_path_policy", refs, details });
      return Object.freeze({ outcome: "blocked", state, statePath, policy });
    }
    await journal.transition("refs_snapshot", "policy_passed", { refs });
    await journal.transition("policy_passed", "merging", { refs });
    const worktreePath = join(config.worktreeRoot, intent.runId);
    await git.createWorktree(config.mirrorPath, worktreePath, downstream);
    const merge = await git.mergeExact(worktreePath, upstream);
    if (!merge.ok) {
      const details = merge.conflicts.map((path) => boundDetail(path));
      const state = await journal.transition("merging", "blocked", { reason: "merge_conflict", refs, details });
      return Object.freeze({ outcome: "blocked", state, statePath, worktreePath, conflicts: merge.conflicts });
    }
    const candidatePaths = await git.changedPaths(config.mirrorPath, downstream, merge.candidateOid, { mergeBase: false });
    const candidateDiffPolicy = evaluateDiffPolicy(candidatePaths);
    const candidateTreeSafety = evaluatePathSafety(await git.listTreePaths(config.mirrorPath, merge.candidateOid));
    const uniqueViolations = new Map();
    for (const violation of [...candidateDiffPolicy.violations, ...candidateTreeSafety.violations]) uniqueViolations.set(`${violation.reason}\0${violation.path}`, violation);
    const candidateViolations = [...uniqueViolations.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.reason < right.reason ? -1 : 1);
    const candidatePolicy = Object.freeze({
      allowed: candidateViolations.length === 0,
      checkedDiffPaths: candidateDiffPolicy.checkedPaths,
      checkedTreePaths: candidateTreeSafety.checkedPaths,
      violations: Object.freeze(candidateViolations),
    });
    if (!candidatePolicy.allowed) {
      const details = candidatePolicy.violations.slice(0, 64).map(({ path, reason }) => boundDetail(`${reason}:${path}`));
      const state = await journal.transition("merging", "blocked", { reason: "candidate_tree_policy", refs, candidateOid: merge.candidateOid, details });
      return Object.freeze({ outcome: "blocked", state, statePath, worktreePath, candidateOid: merge.candidateOid, policy: candidatePolicy });
    }
    await journal.transition("merging", "candidate_ready", { refs, candidateOid: merge.candidateOid });
    const state = await journal.transition("candidate_ready", "completed", { refs, candidateOid: merge.candidateOid });
    return Object.freeze({ outcome: "completed", state, statePath, worktreePath, candidateOid: merge.candidateOid });
  } catch (error) {
    if (journal) {
      try {
        const current = await readState(journal.path);
        if (!["completed", "blocked", "failed"].includes(current.phase)) {
          await journal.transition(current.phase, "failed", { reason: "internal_error", candidateOid: null, details: [boundDetail(error.name || "Error")] });
        }
      } catch {}
    }
    throw error;
  } finally {
    await lock.release();
  }
}
