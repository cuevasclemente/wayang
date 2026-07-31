import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentProfile } from "../agent-profiles.js";
import { close, flush, getStore, init } from "../db.js";
import { createProject } from "../projects.js";
import { createSession, updatePiSessionFile } from "../sessions.js";
import {
  getDreamPolicyProjectionPath,
  startDreamPolicyProjection,
  stopDreamPolicyProjection,
  writeDreamPolicyProjection,
} from "./policy-projection.js";

function transcript(file: string, id: string, cwd: string, canary: string): void {
  fs.writeFileSync(file, [
    JSON.stringify({ type: "session", version: 3, id, cwd }),
    JSON.stringify({ type: "message", message: { role: "user", content: canary } }),
  ].join("\n") + "\n");
}

test("Dream policy projection is atomic, private, complete, and metadata-only", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-policy-projection-"));
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = root;
  close();
  try {
    init();
    const standardCwd = path.join(root, "standard");
    const privateCwd = path.join(root, "private");
    fs.mkdirSync(standardCwd);
    fs.mkdirSync(privateCwd);
    const standardProfile = createAgentProfile({ name: "Standard Dream profile" });
    const privateProfile = createAgentProfile({ name: "Private Dream profile" });
    createProject({
      cwd: standardCwd,
      default_agent_profile_id: standardProfile.id,
      access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [standardProfile.id] },
    });
    createProject({
      cwd: privateCwd,
      default_agent_profile_id: privateProfile.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [privateProfile.id] },
    });

    const standard = createSession(standardCwd, { title: "standard" });
    const privateSession = createSession(privateCwd, { title: "private" });
    const legacyPrivateStandard = createSession(standardCwd, { title: "legacy private standard" });
    const standardFile = path.join(root, "standard.jsonl");
    const privateFile = path.join(root, "private.jsonl");
    const legacyPrivateFile = path.join(root, "legacy-private-standard.jsonl");
    transcript(standardFile, standard.id, standardCwd, "STANDARD_TRANSCRIPT_CANARY");
    transcript(privateFile, privateSession.id, privateCwd, "PRIVATE_TRANSCRIPT_CANARY");
    transcript(legacyPrivateFile, legacyPrivateStandard.id, standardCwd, "LEGACY_PRIVATE_TRANSCRIPT_CANARY");
    updatePiSessionFile(standard.id, standardFile);
    updatePiSessionFile(privateSession.id, privateFile);
    updatePiSessionFile(legacyPrivateStandard.id, legacyPrivateFile);
    const legacyPrivateRow = getStore().sessions.find((session) => session.id === legacyPrivateStandard.id)!;
    legacyPrivateRow.legacy_private_session_quarantine = true;
    legacyPrivateRow.legacy_capability_ineligible = true;
    flush();

    fs.writeFileSync(getDreamPolicyProjectionPath(), "old incomplete bytes", { mode: 0o600 });
    const projection = writeDreamPolicyProjection();
    assert.equal(projection.complete, true);
    assert.equal(projection.sessions.length, 3);
    assert.equal(projection.sessions.find((entry) => entry.session_id === standard.id)?.dream, true);
    assert.equal(projection.sessions.find((entry) => entry.session_id === standard.id)?.agent_profile_id, standardProfile.id);
    assert.equal(projection.sessions.find((entry) => entry.session_id === privateSession.id)?.dream, false);
    assert.equal(projection.sessions.find((entry) => entry.session_id === privateSession.id)?.agent_profile_id, privateProfile.id);
    assert.equal(projection.sessions.find((entry) => entry.session_id === legacyPrivateStandard.id)?.dream, false);

    const serialized = fs.readFileSync(getDreamPolicyProjectionPath(), "utf8");
    const durable = JSON.parse(serialized) as typeof projection;
    assert.deepEqual(durable, projection);
    assert.doesNotMatch(serialized, /TRANSCRIPT_CANARY/);
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes("project-access-policy.json.")), []);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(getDreamPolicyProjectionPath()).mode & 0o777, 0o600);
    }

    startDreamPolicyProjection();
    const later = createSession(standardCwd, { title: "later" });
    const laterFile = path.join(root, "later.jsonl");
    transcript(laterFile, later.id, standardCwd, "LATER_TRANSCRIPT_CANARY");
    updatePiSessionFile(later.id, laterFile);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const current = JSON.parse(fs.readFileSync(getDreamPolicyProjectionPath(), "utf8")) as typeof projection;
      if (current.sessions.some((entry) => entry.session_id === later.id)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const refreshed = JSON.parse(fs.readFileSync(getDreamPolicyProjectionPath(), "utf8")) as typeof projection;
    assert.ok(refreshed.sessions.some((entry) => entry.session_id === later.id));
  } finally {
    stopDreamPolicyProjection();
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
