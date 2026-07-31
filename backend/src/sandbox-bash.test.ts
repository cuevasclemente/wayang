import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentProfile } from "./agent-profiles.js";
import { buildManagedAppChildEnvironment } from "./apps/process-manager.js";
import { commandGuardIdentityPinPath } from "./command-guard-pin.js";
import { close, commitStoreMutation, getWorkspaceCapabilityStoreProjectionPath, init } from "./db.js";
import { createProject } from "./projects.js";
import {
  buildBashSandboxPolicy,
  createPolicySandboxedBashOperations,
  getBashSandboxAvailability,
  selectWayangBashMode,
} from "./sandbox-bash.js";
import { isLegacyWrenStandardRuntime } from "./legacy-wren.js";
import { createSession, updatePiSessionFile } from "./sessions.js";
import { getPiAgentRoot, getSessionAttachmentRoot, LEGACY_ATTACHMENT_ROOT } from "./protected-artifacts.js";
import type { SandboxNetworkMode } from "./sandbox-exec-protocol.js";
import {
  commitWorkspaceCapabilityActivation,
  revokeWorkspaceCapabilityAssociation,
} from "./workspace-capabilities.js";
import { WREN_AGENT_PROFILE_ID } from "./workspace-types.js";

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function run(
  sessionId: string,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  networkMode: SandboxNetworkMode = "allow_all_proxy",
): Promise<{ code: number | null; output: string }> {
  let output = "";
  const result = await createPolicySandboxedBashOperations(sessionId, { networkMode }).exec(command, process.cwd(), {
    env,
    onData(data) { output += data.toString("utf8"); },
    timeout: 20,
  });
  return { code: result.exitCode, output };
}

async function canCreateUnixSocket(): Promise<boolean> {
  if (process.platform === "win32") return true;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-unix-socket-check-"));
  const socketPath = path.join(root, "check.sock");
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function listeningUnixServer(root: string): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const socketPath = path.join(root, "host-control.sock");
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(socketPath, { force: true });
    },
  };
}

async function listeningServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP test port");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 1_000);
      server.close(finish);
      (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    }),
  };
}

test("per-exec bash sandbox denies protected files and capabilities while allowing proxy-mediated network", { timeout: 60_000 }, async (t) => {
  const availability = getBashSandboxAvailability();
  if (!availability.available) {
    t.skip(availability.reason ?? "sandbox unavailable");
    return;
  }
  if (!(await canCreateUnixSocket())) {
    t.skip("outer Wayang sandbox blocks the nested SRT proxy Unix socket");
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-bash-policy-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  const memory = path.join(root, "memory");
  fs.mkdirSync(projectA);
  fs.mkdirSync(projectB);
  fs.mkdirSync(memory);
  fs.writeFileSync(path.join(projectA, "allowed.txt"), "a");
  fs.writeFileSync(path.join(projectB, "protected.txt"), "b");
  fs.writeFileSync(path.join(memory, "note.txt"), "memory");

  const previousData = process.env.WAYANG_DATA_DIR;
  const previousMemory = process.env.WAYANG_MEMORY_ROOTS;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const realConfig = path.join(root, "real-config");
  const configAlias = path.join(root, "config-alias");
  fs.mkdirSync(path.join(realConfig, "pi"), { recursive: true });
  fs.symlinkSync(realConfig, configAlias, "dir");
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  process.env.WAYANG_MEMORY_ROOTS = memory;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(root, "pi-agent", "sessions");
  process.env.XDG_CONFIG_HOME = configAlias;
  init();
  const sourceProfile = createAgentProfile({
    name: "Synthetic Sandbox Source",
    resource_mode: "standard",
    memory_access: "read",
  });
  const isolatedProfile = createAgentProfile({ name: "Synthetic Isolated Profile" });
  createProject({
    cwd: projectA,
    default_agent_profile_id: sourceProfile.id,
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [sourceProfile.id] },
  });
  createProject({
    cwd: projectB,
    default_agent_profile_id: isolatedProfile.id,
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [isolatedProfile.id] },
  });
  const source = createSession(projectA, { agentProfileId: sourceProfile.id });
  const otherSession = createSession(projectA, { agentProfileId: sourceProfile.id });
  let legacyAttachmentRootStat: fs.Stats | undefined;
  try { legacyAttachmentRootStat = fs.lstatSync(LEGACY_ATTACHMENT_ROOT); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const createdLegacyAttachmentRoot = legacyAttachmentRootStat === undefined;
  if (createdLegacyAttachmentRoot) fs.mkdirSync(LEGACY_ATTACHMENT_ROOT, { mode: 0o700 });
  const legacyAttachmentScratch = createdLegacyAttachmentRoot || legacyAttachmentRootStat?.isDirectory()
    ? path.join(LEGACY_ATTACHMENT_ROOT, `sandbox-write-${source.id}.txt`)
    : null;
  const authFile = path.join(process.env.PI_CODING_AGENT_DIR, "auth.json");
  fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  fs.writeFileSync(authFile, "SYNTHETIC_AUTH_CANARY\n", { mode: 0o600 });
  const identityPinFile = commandGuardIdentityPinPath();
  fs.writeFileSync(identityPinFile, "12345678\n", { mode: 0o600 });
  const browserProfile = path.join(projectA, ".pi", "browser-workbench", "profiles", "synthetic", "Cookies");
  fs.mkdirSync(path.dirname(browserProfile), { recursive: true });
  fs.writeFileSync(browserProfile, "SYNTHETIC_BROWSER_PROFILE_CANARY\n", { mode: 0o600 });
  const transcriptDir = path.join(process.env.PI_CODING_AGENT_SESSION_DIR, "synthetic-project");
  fs.mkdirSync(transcriptDir, { recursive: true });
  const transcriptFile = path.join(transcriptDir, "protected.jsonl");
  fs.writeFileSync(transcriptFile, "TRANSCRIPT_CANARY\n");
  updatePiSessionFile(source.id, transcriptFile);
  const ownAttachmentRoot = getSessionAttachmentRoot(source.id);
  const crossAttachmentRoot = getSessionAttachmentRoot(otherSession.id);
  fs.mkdirSync(ownAttachmentRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(crossAttachmentRoot, { recursive: true, mode: 0o700 });
  const ownAttachment = path.join(ownAttachmentRoot, "own.txt");
  const crossAttachment = path.join(crossAttachmentRoot, "cross.txt");
  fs.writeFileSync(ownAttachment, "OWN_ATTACHMENT_CANARY\n", { mode: 0o600 });
  fs.writeFileSync(crossAttachment, "CROSS_ATTACHMENT_CANARY\n", { mode: 0o600 });
  const searchFile = path.join(process.env.WAYANG_DATA_DIR, "search.db");
  const projectionFile = path.join(process.env.WAYANG_DATA_DIR, "project-access-policy.json");
  const scratchFile = path.join(os.tmpdir(), `wayang-sandbox-scratch-${source.id}`);
  const sandboxSocket = path.join(os.tmpdir(), `wayang-sandbox-socket-${source.id}.sock`);
  const unixServer = await listeningUnixServer(root);
  fs.writeFileSync(searchFile, "SEARCH_CANARY\n");
  fs.writeFileSync(projectionFile, "PROJECTION_CANARY\n", { mode: 0o600 });

  t.after(async () => {
    await unixServer.close();
    close();
    if (previousData === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousData;
    if (previousMemory === undefined) delete process.env.WAYANG_MEMORY_ROOTS;
    else process.env.WAYANG_MEMORY_ROOTS = previousMemory;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    fs.rmSync(scratchFile, { force: true });
    fs.rmSync(sandboxSocket, { force: true });
    if (legacyAttachmentScratch) fs.rmSync(legacyAttachmentScratch, { force: true });
    if (createdLegacyAttachmentRoot) {
      try { fs.rmdirSync(LEGACY_ATTACHMENT_ROOT); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const policy = buildBashSandboxPolicy(source.id);
  assert.equal(policy.networkMode, "allow_all_proxy");
  assert.deepEqual(policy.config.network.allowedDomains, []);
  assert.deepEqual(policy.config.network.deniedDomains, []);
  assert.equal(policy.config.network.strictAllowlist, false);
  assert.ok(policy.config.filesystem.allowWrite.includes(fs.realpathSync(os.tmpdir())));
  assert.ok(policy.deniedReadRoots.includes(fs.realpathSync(projectB)));
  assert.ok(policy.deniedWriteRoots.includes(fs.realpathSync(memory)));
  assert.ok(policy.deniedReadRoots.includes(fs.realpathSync(process.env.WAYANG_DATA_DIR)));
  // A standard resource_mode is only intent. Without an exact active tuple,
  // the outer Pi root masks sessions, credentials, and global resources alike.
  assert.ok(policy.deniedReadRoots.includes(fs.realpathSync(process.env.PI_CODING_AGENT_DIR)));
  assert.ok(policy.deniedReadRoots.includes(fs.realpathSync(identityPinFile)));
  assert.ok(policy.deniedWriteRoots.includes(fs.realpathSync(identityPinFile)));
  assert.ok(policy.deniedReadRoots.includes(fs.realpathSync(path.join(projectA, ".pi", "browser-workbench"))));
  assert.ok(policy.deniedReadRoots.includes(fs.realpathSync("/proc")));
  assert.ok(policy.deniedReadRoots.includes(path.resolve(LEGACY_ATTACHMENT_ROOT)));
  assert.ok(policy.deniedWriteRoots.includes(path.resolve(LEGACY_ATTACHMENT_ROOT)));
  assert.deepEqual(new Set(policy.config.filesystem.allowRead), new Set([fs.realpathSync(ownAttachmentRoot)]));

  const protectedFile = path.join(projectB, "protected.txt");
  const memoryFile = path.join(memory, "note.txt");
  const dataFile = path.join(process.env.WAYANG_DATA_DIR, "store.json");
  const socketCreateScript = `const net=require("node:net");const s=net.createServer();s.once("error",()=>process.exit(0));s.listen(${JSON.stringify(sandboxSocket)},()=>s.close(()=>process.exit(32)));setTimeout(()=>process.exit(33),2000);`;
  const socketConnectScript = `const net=require("node:net");const s=net.createConnection(${JSON.stringify(unixServer.socketPath)});s.once("error",()=>process.exit(0));s.once("connect",()=>{s.destroy();process.exit(34)});setTimeout(()=>process.exit(35),2000);`;
  const command = [
    `(test ! -e ${quote(protectedFile)}) || { echo protected-read-visible; exit 11; }`,
    `(printf bypass > ${quote(path.join(projectB, "new.txt"))}) || true`,
    `(cat ${quote(memoryFile)} >/dev/null) || { echo memory-read-failed; exit 13; }`,
    `(! (printf bypass > ${quote(memoryFile)})) || { echo memory-write-succeeded; exit 14; }`,
    `(test ! -e ${quote(dataFile)}) || { echo store-visible; exit 15; }`,
    `(test ! -e ${quote(searchFile)}) || { echo search-visible; exit 18; }`,
    `(test ! -e ${quote(projectionFile)}) || { echo projection-visible; exit 19; }`,
    `(! cat ${quote(transcriptFile)} >/dev/null 2>&1) || { echo transcript-readable; exit 20; }`,
    `(test ! -e ${quote(crossAttachment)}) || { echo cross-attachment-visible; exit 21; }`,
    `(! cat ${quote(authFile)} >/dev/null 2>&1) || { echo pi-auth-readable; exit 24; }`,
    `(! cat ${quote(identityPinFile)} >/dev/null 2>&1) || { echo identity-pin-readable; exit 26; }`,
    `(test ! -e ${quote(browserProfile)}) || { echo browser-profile-visible; exit 25; }`,
    `(grep -R TRANSCRIPT_CANARY ${quote(transcriptDir)} 2>/dev/null && { echo transcript-grep-visible; exit 22; }) || true`,
    `(cat ${quote(ownAttachment)} | grep -q OWN_ATTACHMENT_CANARY) || { echo own-attachment-hidden; exit 23; }`,
    // A read-denied directory beneath writable /tmp is an empty tmpfs inside
    // sandbox-runtime. Writes may succeed only in that disposable overlay;
    // host-side assertions below prove that protected backing data is unchanged.
    `(printf bypass > ${quote(path.join(process.env.WAYANG_DATA_DIR, "sandbox-write.txt"))}) || true`,
    `(printf bypass > ${quote(path.join(ownAttachmentRoot, "sandbox-write.txt"))}) || true`,
    ...(legacyAttachmentScratch ? [`(printf bypass > ${quote(legacyAttachmentScratch)}) || true`] : []),
    `(printf scratch > ${quote(scratchFile)} && grep -q '^scratch$' ${quote(scratchFile)} && rm -f ${quote(scratchFile)}) || { echo shared-tmp-write-failed; exit 34; }`,
    `(node -e ${quote(socketCreateScript)}) || { echo unix-socket-create-succeeded-or-uncertain; exit 35; }`,
    `(node -e ${quote(socketConnectScript)}) || { echo unix-socket-connect-succeeded-or-uncertain; exit 36; }`,
    `(test -z \"\${WAYANG_BROWSER_AGENT_TOKEN-}\") || { echo capability-env-visible; exit 16; }`,
    `(test -z \"\${PI_COMMAND_GUARD_IDENTITY_PIN-}\") || { echo legacy-pin-env-visible; exit 27; }`,
    `(test -z \"\${WAYANG_COMMAND_GUARD_RECOVERY_PIN-}\") || { echo related-pin-env-visible; exit 28; }`,
    `(test -z \"\${COMMAND_GUARD_IDENTITY_PIN-}\") || { echo unprefixed-pin-env-visible; exit 29; }`,
  ].join("; ");
  const result = await run(source.id, command, {
    ...process.env,
    WAYANG_BROWSER_AGENT_TOKEN: "synthetic-capability",
    PI_COMMAND_GUARD_IDENTITY_PIN: "synthetic-legacy-pin",
    WAYANG_COMMAND_GUARD_RECOVERY_PIN: "synthetic-related-pin",
    COMMAND_GUARD_IDENTITY_PIN: "synthetic-unprefixed-pin",
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(fs.readFileSync(protectedFile, "utf8"), "b");
  assert.equal(fs.existsSync(path.join(projectB, "new.txt")), false);
  assert.equal(fs.readFileSync(memoryFile, "utf8"), "memory");
  assert.equal(fs.existsSync(path.join(process.env.WAYANG_DATA_DIR, "sandbox-write.txt")), false);
  assert.equal(fs.existsSync(path.join(ownAttachmentRoot, "sandbox-write.txt")), false);
  if (legacyAttachmentScratch) assert.equal(fs.existsSync(legacyAttachmentScratch), false);
  assert.equal(fs.existsSync(scratchFile), false);
  assert.equal(fs.existsSync(sandboxSocket), false);
});

test("actual concurrent sandboxes isolate an allowed Standard project from an unrelated Protected project", { timeout: 60_000 }, async (t) => {
  const availability = getBashSandboxAvailability();
  if (!availability.available) {
    t.skip(availability.reason ?? "sandbox unavailable");
    return;
  }
  if (!(await canCreateUnixSocket())) {
    t.skip("outer Wayang sandbox blocks the nested SRT proxy Unix socket");
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-bash-concurrent-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  fs.mkdirSync(projectA);
  fs.mkdirSync(projectB);
  fs.writeFileSync(path.join(projectA, "only-a.txt"), "a");
  fs.writeFileSync(path.join(projectB, "only-b.txt"), "b");
  const previousData = process.env.WAYANG_DATA_DIR;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(root, "pi-agent", "sessions");
  fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  init();
  const standardProfile = createAgentProfile({
    name: "Arbitrary Standard Profile",
    resource_mode: "standard",
  });
  const protectedProfile = createAgentProfile({ name: "Arbitrary Protected Profile", memory_access: "read" });
  createProject({
    cwd: projectA,
    default_agent_profile_id: standardProfile.id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [standardProfile.id] },
  });
  createProject({
    cwd: projectB,
    default_agent_profile_id: protectedProfile.id,
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [protectedProfile.id] },
  });
  const sourceA = createSession(projectA, { agentProfileId: standardProfile.id });
  const sourceB = createSession(projectB, { agentProfileId: protectedProfile.id });
  const loopback = await listeningServer();

  t.after(async () => {
    await loopback.close();
    close();
    if (previousData === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousData;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const standardPolicy = buildBashSandboxPolicy(sourceA.id);
  const protectedPolicy = buildBashSandboxPolicy(sourceB.id);
  assert.ok(standardPolicy.deniedReadRoots.includes(fs.realpathSync(projectB)));
  assert.ok(standardPolicy.deniedWriteRoots.includes(fs.realpathSync(projectB)));
  assert.equal(protectedPolicy.deniedReadRoots.includes(fs.realpathSync(projectB)), false);
  assert.equal(protectedPolicy.deniedWriteRoots.includes(fs.realpathSync(projectB)), false);
  assert.deepEqual(protectedPolicy.config.filesystem.allowWrite, [fs.realpathSync(projectB)]);

  const aOwn = path.join(projectA, "only-a.txt");
  const bOwn = path.join(projectB, "only-b.txt");
  const [a, b] = await Promise.all([
    run(sourceA.id, `cat ${quote(aOwn)} && test ! -e ${quote(bOwn)} && printf ok > ${quote(path.join(projectA, "a-write.txt"))}`),
    run(sourceB.id, `cat ${quote(bOwn)} && test ! -e ${quote(aOwn)} && (/usr/bin/curl --silent --show-error --max-time 5 http://127.0.0.1:${loopback.port}/ | grep -q '^ok$') && printf ok > ${quote(path.join(projectB, "b-write.txt"))}`),
  ]);
  assert.equal(a.code, 0, a.output);
  assert.equal(b.code, 0, b.output);
  assert.equal(fs.readFileSync(path.join(projectA, "a-write.txt"), "utf8"), "ok");
  assert.equal(fs.readFileSync(path.join(projectB, "b-write.txt"), "utf8"), "ok");
});

test("sandbox global Pi visibility requires the live standard-resources pair association", (t) => {
  close();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-sandbox-projection-"));
  const projectRoot = path.join(root, "project");
  const piAgentRoot = path.join(root, "pi-agent");
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(piAgentRoot);
  const previousData = process.env.WAYANG_DATA_DIR;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  process.env.PI_CODING_AGENT_DIR = piAgentRoot;
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(piAgentRoot, "sessions");
  init();
  t.after(() => {
    close();
    if (previousData === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousData;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const profile = createAgentProfile({ name: "Pair-projected profile", resource_mode: "project_only" });
  const project = createProject({
    cwd: projectRoot,
    default_agent_profile_id: profile.id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id] },
  });
  const session = createSession(projectRoot, {
    agentProfileId: profile.id,
    provider: "synthetic-provider",
    model: "synthetic-model",
  });
  const otherModelSession = createSession(projectRoot, {
    agentProfileId: profile.id,
    provider: "other-provider",
    model: "other-model",
  });
  const binding = {
    capability_id: "wayang.standard-resources.v1" as const,
    project_id: project.id,
    agent_profile_id: profile.id,
  };
  const canonicalPiRoot = fs.realpathSync(getPiAgentRoot());

  const unactivated = buildBashSandboxPolicy(session.id);
  assert.ok(unactivated.deniedReadRoots.includes(canonicalPiRoot));
  assert.deepEqual(unactivated.config.filesystem.allowRead, []);

  const association = commitWorkspaceCapabilityActivation({ ...binding, operation_digest: "a".repeat(64) });
  const exactProjection = getWorkspaceCapabilityStoreProjectionPath(binding);
  const exact = buildBashSandboxPolicy(session.id);
  assert.equal(exact.deniedReadRoots.includes(canonicalPiRoot), false);
  assert.ok(exact.config.filesystem.allowRead?.includes(exactProjection));

  const otherModel = buildBashSandboxPolicy(otherModelSession.id);
  assert.equal(otherModel.deniedReadRoots.includes(canonicalPiRoot), false);
  assert.ok(otherModel.config.filesystem.allowRead?.includes(exactProjection));

  revokeWorkspaceCapabilityAssociation({ ...binding, expected_revision: association.revision });
  const revoked = buildBashSandboxPolicy(session.id);
  assert.ok(revoked.deniedReadRoots.includes(canonicalPiRoot));
  assert.equal(revoked.config.filesystem.allowRead?.includes(exactProjection), false);
});

test("only exact seeded Wren receives broad Standard compatibility, including scheduled runs", () => {
  const session = {
    agent_profile_id: WREN_AGENT_PROFILE_ID,
    pending_agent_switch: null,
    legacy_private_session_quarantine: false,
    legacy_capability_ineligible: false,
    scheduled_job_id: null,
    scheduled_run_id: null,
  };
  const profile = { id: WREN_AGENT_PROFILE_ID, builtin_kind: "wren" as const, enabled: true };
  const project = { access_policy: { privacy_mode: "standard" as const, allowed_agent_profile_ids: null } };
  const allowed = () => isLegacyWrenStandardRuntime({ session, profile, project });

  assert.equal(allowed(), true);
  assert.equal(isLegacyWrenStandardRuntime({
    session: { ...session, scheduled_job_id: "scheduled-job", scheduled_run_id: "scheduled-run" },
    profile,
    project,
  }), true);
  assert.equal(isLegacyWrenStandardRuntime({ session, profile: { ...profile, id: "lookalike" }, project }), false);
  assert.equal(isLegacyWrenStandardRuntime({ session, profile: { ...profile, builtin_kind: null }, project }), false);
  assert.equal(isLegacyWrenStandardRuntime({ session: { ...session, pending_agent_switch: {} as never }, profile, project }), false);
  assert.equal(isLegacyWrenStandardRuntime({
    session,
    profile,
    project: { access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] } },
  }), false);
});

test("exact Wren sandbox spans ordinary host paths while masking every Protected project", (t) => {
  close();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-wren-host-workspace-"));
  const standardRoot = path.join(root, "standard");
  const protectedRoot = path.join(root, "protected");
  fs.mkdirSync(standardRoot);
  fs.mkdirSync(protectedRoot);
  const previousData = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  init();
  const now = Date.now();
  commitStoreMutation((draft) => {
    draft.agentProfiles.push({
      id: WREN_AGENT_PROFILE_ID,
      name: "Renamed legacy profile",
      description: null,
      builtin_kind: "wren",
      deletable: false,
      enabled: true,
      resource_mode: "standard",
      instructions: null,
      memory_access: "read_write",
      default_provider: null,
      default_model: null,
      allowed_tools: null,
      allowed_extensions: null,
      created_at: now,
      updated_at: now,
    });
  });
  createProject({
    cwd: standardRoot,
    default_agent_profile_id: WREN_AGENT_PROFILE_ID,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [WREN_AGENT_PROFILE_ID] },
  });
  createProject({
    cwd: protectedRoot,
    default_agent_profile_id: WREN_AGENT_PROFILE_ID,
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [WREN_AGENT_PROFILE_ID] },
  });
  const session = createSession(standardRoot, { agentProfileId: WREN_AGENT_PROFILE_ID });
  t.after(() => {
    close();
    if (previousData === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousData;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const policy = buildBashSandboxPolicy(session.id);
  assert.equal(policy.config.network.allowAllUnixSockets, true);
  assert.equal(policy.config.filesystem.allowGitConfig, true);
  assert.deepEqual(policy.config.filesystem.allowWrite, [path.parse(fs.realpathSync(standardRoot)).root]);
  assert.ok(policy.deniedReadRoots.includes(fs.realpathSync(protectedRoot)));
  assert.ok(policy.deniedWriteRoots.includes(fs.realpathSync(protectedRoot)));
  assert.equal(policy.deniedWriteRoots.includes(path.join(fs.realpathSync(standardRoot), ".pi")), false);
});

test("bash selector requires the complete host decision and never launders a legacy boolean into host mode", () => {
  assert.equal(selectWayangBashMode(false, { available: true }), "sandboxed");
  assert.equal(selectWayangBashMode(false, { available: false, reason: "synthetic unavailable" }), "unavailable");
  assert.equal(selectWayangBashMode(true, { available: true }), "sandboxed");
  assert.equal(selectWayangBashMode(true, { available: false, reason: "synthetic unavailable" }), "unavailable");
  assert.equal(selectWayangBashMode({
    allowed: true,
    witness: {
      capabilityId: "wayang.host-execution.v1",
      projectId: "project",
      agentProfileId: "profile",
      associationRevision: 1,
    },
  }, { available: false, reason: "sandbox is irrelevant to exact host mode" }), "host");
});

test("managed app child environments omit capabilities and PIN names without reading protected values", () => {
  let protectedValueReads = 0;
  const source: NodeJS.ProcessEnv = {
    PATH: "/synthetic/bin",
    WAYANG_BROWSER_AGENT_TOKEN: "synthetic-browser-token",
    WAYANG_APPS_AGENT_TOKEN: "synthetic-apps-token",
    WAYANG_APPS_INTERNAL_CAPABILITY: "synthetic-apps-capability",
    WAYANG_AUTH_SESSION_SECRET: "synthetic-session-secret",
    BW_SESSION: "synthetic-bw-session",
    PUBLIC_SETTING: "kept",
  };
  for (const name of [
    "PI_COMMAND_GUARD_IDENTITY_PIN",
    "WAYANG_COMMAND_GUARD_RECOVERY_PIN",
    "COMMAND_GUARD_IDENTITY_PIN",
  ]) {
    Object.defineProperty(source, name, {
      enumerable: true,
      get() {
        protectedValueReads++;
        return "synthetic-pin";
      },
    });
  }

  const child = buildManagedAppChildEnvironment(source, {
    PI_APP_ID: "synthetic-app",
    PI_COMMAND_GUARD_IDENTITY_PIN: "synthetic-override-pin",
  });
  assert.equal(protectedValueReads, 0);
  assert.deepEqual(child, {
    PATH: "/synthetic/bin",
    PUBLIC_SETTING: "kept",
    PI_APP_ID: "synthetic-app",
  });
});
