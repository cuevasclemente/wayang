import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  close,
  failNextCommitStoreMutationPersistenceForTests,
  getStore,
  init,
} from "./db.js";
import {
  createSession,
  deleteSession,
  getSessionById,
  updatePiSessionFile,
  stopSessionCatalog,
} from "./sessions.js";
import {
  createEventReconcileMarker,
  failNextRecoveryUnlinkForTests,
} from "./transcript-recovery-journal.js";
import { recoverTranscriptRecoveryJournal } from "./transcript-recovery.js";
import { closeSearchDb, getSearchDb } from "./search/db.js";
import { removeSession as removeSearchSession } from "./search/indexer.js";
import { authorizeExactStandardTranscript } from "./standard-transcript-authorization.js";

function environment(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const project = path.join(root, "project");
  const sessions = path.join(root, "pi-sessions");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  const previous = {
    data: process.env.WAYANG_DATA_DIR,
    pi: process.env.PI_CODING_AGENT_SESSION_DIR,
    legacy: process.env.WAYANG_LEGACY_SESSION_SCAN,
  };
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  process.env.PI_CODING_AGENT_SESSION_DIR = sessions;
  // Incremental catalog discovery honors the explicit canonical session root.
  // Legacy SessionManager.listAll uses a different root and would make this
  // custom synthetic transcript invisible, incorrectly leaving model null.
  delete process.env.WAYANG_LEGACY_SESSION_SCAN;
  return {
    root,
    project,
    sessions,
    cleanup() {
      closeSearchDb();
      close();
      if (previous.data === undefined) delete process.env.WAYANG_DATA_DIR;
      else process.env.WAYANG_DATA_DIR = previous.data;
      if (previous.pi === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previous.pi;
      if (previous.legacy === undefined) delete process.env.WAYANG_LEGACY_SESSION_SCAN;
      else process.env.WAYANG_LEGACY_SESSION_SCAN = previous.legacy;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function materializedSession(project: string, sessionDir: string, id: string) {
  const manager = SessionManager.create(project, sessionDir, { id });
  manager.appendMessage({ role: "user", content: "synthetic recovery fixture", timestamp: Date.now() } as any);
  manager.appendModelChange("offline", "before-recovery");
  manager.materialize();
  return manager;
}

test("schema 6 migrates to strict content-free schema 7 recovery journal", () => {
  const f = environment("wayang-recovery-schema-");
  try {
    init({ browserProfilesEnabled: true });
    close();
    const storePath = path.join(process.env.WAYANG_DATA_DIR!, "store.json");
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
    raw.schema_version = 6;
    delete raw.transcriptRecoveryJournal;
    fs.writeFileSync(storePath, JSON.stringify(raw), { mode: 0o600 });
    init({ browserProfilesEnabled: true });
    assert.equal(getStore().schema_version, 7);
    assert.deepEqual(getStore().transcriptRecoveryJournal, []);
    close();

    const malformed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    malformed.transcriptRecoveryJournal = [{
      id: "marker",
      kind: "session_delete",
      session_id: "missing-session",
      pi_session_file: "/synthetic/session.jsonl",
      created_at: 1,
      payload: "forbidden old content",
    }];
    fs.writeFileSync(storePath, JSON.stringify(malformed), { mode: 0o600 });
    assert.throws(() => init({ browserProfilesEnabled: true }), /malformed transcript recovery journal row/);
  } finally {
    f.cleanup();
  }
});

test("event marker persistence failure mutates nothing; durable marker recovers metadata then search on restart", async () => {
  const f = environment("wayang-event-recovery-");
  try {
    init();
    const session = createSession(f.project, "Synthetic event recovery");
    const manager = materializedSession(f.project, f.sessions, session.id);
    const file = manager.getSessionFile()!;
    updatePiSessionFile(session.id, file);
    assert.ok(authorizeExactStandardTranscript(file, { expectedSessionId: session.id }),
      "synthetic recovery fixture must have exact durable Standard identity before journaling");

    failNextCommitStoreMutationPersistenceForTests();
    assert.throws(() => createEventReconcileMarker(session.id, file), /Synthetic store persistence failure/);
    assert.deepEqual(getStore().transcriptRecoveryJournal, []);
    assert.equal(fs.existsSync(file), true);

    const marker = createEventReconcileMarker(session.id, file);
    manager.appendModelChange("offline", "after-recovery");
    close();
    init();
    assert.equal(getStore().transcriptRecoveryJournal[0]?.id, marker.id);
    assert.ok(authorizeExactStandardTranscript(file, { expectedSessionId: session.id }),
      "synthetic recovery fixture must retain exact durable Standard identity after restart");

    const result = await recoverTranscriptRecoveryJournal();
    assert.deepEqual(result, { recovered: 1, pending: 0 });
    assert.deepEqual(getStore().transcriptRecoveryJournal, []);
    assert.equal(getSessionById(session.id)?.model, "after-recovery");
    const indexed = getSearchDb().prepare(
      "SELECT COUNT(*) AS n FROM session_index_state WHERE session_id = ?",
    ).get(session.id) as { n: number };
    assert.equal(indexed.n, 1, "fresh search commits before durable marker removal");
  } finally {
    await stopSessionCatalog();
    f.cleanup();
  }
});

test("session-delete unlink failure retains durable authority and synthetic restart recovery finishes deletion", async () => {
  const f = environment("wayang-delete-recovery-");
  try {
    init();
    const session = createSession(f.project, "Synthetic delete recovery");
    const manager = materializedSession(f.project, f.sessions, session.id);
    const file = manager.getSessionFile()!;
    updatePiSessionFile(session.id, file);
    await removeSearchSession(session.id);
    failNextRecoveryUnlinkForTests();

    assert.throws(
      () => deleteSession(session.id, { searchPurged: true }),
      /Synthetic transcript recovery unlink failure/,
    );
    assert.equal(getSessionById(session.id), undefined, "row removal and marker commit are one durable transaction");
    assert.equal(fs.existsSync(file), true);
    assert.equal(getStore().transcriptRecoveryJournal[0]?.kind, "session_delete");
    assert.equal(JSON.stringify(getStore().transcriptRecoveryJournal).includes("Synthetic delete recovery"), false);

    close();
    init();
    const result = await recoverTranscriptRecoveryJournal();
    assert.deepEqual(result, { recovered: 1, pending: 0 });
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(getStore().transcriptRecoveryJournal, []);
    assert.equal(getSessionById(session.id), undefined);
  } finally {
    f.cleanup();
  }
});
