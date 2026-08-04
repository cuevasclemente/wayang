import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  listAuthorizedSessions,
  loadCompleteProjection,
  readAuthorizedSession,
} from "../dream-authorized-sessions.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-dream-runner-"));
  const sessionsRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionsRoot);
  const standard = path.join(sessionsRoot, "standard.jsonl");
  const protectedFile = path.join(sessionsRoot, "protected.jsonl");
  const unknown = path.join(sessionsRoot, "unknown.jsonl");
  fs.writeFileSync(standard, "STANDARD_JSONL_CANARY\n");
  fs.writeFileSync(protectedFile, "PROTECTED_JSONL_CANARY\n");
  fs.writeFileSync(unknown, "UNKNOWN_JSONL_CANARY\n");
  const projectionPath = path.join(root, "project-access-policy.json");
  const storePath = path.join(root, "store.json");
  fs.writeFileSync(storePath, "{}\n", { mode: 0o600 });
  const writeProjection = (generation, protectedDream = false) => {
    const storeStat = fs.statSync(storePath);
    const projection = {
      schema_version: 1,
      generation,
      complete: true,
      source_store: {
        size: storeStat.size,
        mtime_ms: storeStat.mtimeMs,
        ctime_ms: storeStat.ctimeMs,
        ino: Number(storeStat.ino) || 0,
      },
      projects: [],
      sessions: [
        { session_id: "standard", path: fs.realpathSync.native(standard), cwd: "/synthetic/standard", dream: true },
        { session_id: "protected", path: fs.realpathSync.native(protectedFile), cwd: "/synthetic/protected", dream: protectedDream },
      ],
    };
    const temporary = `${projectionPath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(projection)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, projectionPath);
    fs.chmodSync(projectionPath, 0o600);
  };
  writeProjection(1);
  return { root, sessionsRoot, standard, protectedFile, unknown, projectionPath, storePath, writeProjection };
}

test("Dream runner lists and reads only explicit complete-projection allows", () => {
  const f = fixture();
  try {
    const listed = listAuthorizedSessions({ projectionPath: f.projectionPath, sessionsRoot: f.sessionsRoot });
    assert.deepEqual(listed.sessions, [fs.realpathSync.native(f.standard)]);
    assert.equal(
      readAuthorizedSession({ projectionPath: f.projectionPath, sessionsRoot: f.sessionsRoot, sessionPath: f.standard }).toString(),
      "STANDARD_JSONL_CANARY\n",
    );
    assert.throws(
      () => readAuthorizedSession({ projectionPath: f.projectionPath, sessionsRoot: f.sessionsRoot, sessionPath: f.protectedFile }),
      /denied or unknown/,
    );
    assert.throws(
      () => readAuthorizedSession({ projectionPath: f.projectionPath, sessionsRoot: f.sessionsRoot, sessionPath: f.unknown }),
      /denied or unknown/,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("Dream runner fails closed on missing, public, malformed, or incomplete projections", () => {
  const f = fixture();
  try {
    fs.chmodSync(f.projectionPath, 0o644);
    if (process.platform !== "win32") assert.throws(() => loadCompleteProjection(f.projectionPath), /not private/);
    fs.chmodSync(f.projectionPath, 0o600);
    fs.appendFileSync(f.storePath, " ");
    assert.throws(() => loadCompleteProjection(f.projectionPath), /stale/);
    f.writeProjection(2);
    fs.writeFileSync(f.projectionPath, JSON.stringify({ schema_version: 1, generation: 1, complete: false }), { mode: 0o600 });
    assert.throws(() => loadCompleteProjection(f.projectionPath), /incomplete or unsupported/);
    fs.writeFileSync(f.projectionPath, "not json", { mode: 0o600 });
    assert.throws(() => loadCompleteProjection(f.projectionPath), /malformed/);
    fs.rmSync(f.projectionPath);
    assert.throws(() => loadCompleteProjection(f.projectionPath), /unavailable/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("Dream runner rechecks before and after bytes and discards racing decisions", () => {
  const before = fixture();
  try {
    assert.throws(() => readAuthorizedSession(
      { projectionPath: before.projectionPath, sessionsRoot: before.sessionsRoot, sessionPath: before.standard },
      { beforeRead: () => {
        const projection = JSON.parse(fs.readFileSync(before.projectionPath, "utf8"));
        projection.generation = 2;
        projection.sessions[0].dream = false;
        fs.writeFileSync(before.projectionPath, JSON.stringify(projection), { mode: 0o600 });
      } },
    ), /changed before transcript read/);
  } finally {
    fs.rmSync(before.root, { recursive: true, force: true });
  }

  const after = fixture();
  try {
    assert.throws(() => readAuthorizedSession(
      { projectionPath: after.projectionPath, sessionsRoot: after.sessionsRoot, sessionPath: after.standard },
      { afterRead: () => after.writeProjection(2) },
    ), /policy changed during transcript read/);
  } finally {
    fs.rmSync(after.root, { recursive: true, force: true });
  }
});
