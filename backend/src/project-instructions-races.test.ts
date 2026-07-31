import test from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { close, init } from "./db.js";
import {
  setProjectInstructionsCommitHookForTests,
  writeProjectInstructions,
} from "./project-instructions.js";
import { createProject } from "./projects.js";

function digest(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function fixture(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const previousData = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(dir, "data");
  init();
  const project = createProject({ cwd });
  return {
    dir,
    cwd,
    project,
    cleanup() {
      setProjectInstructionsCommitHookForTests();
      close();
      if (previousData === undefined) delete process.env.WAYANG_DATA_DIR;
      else process.env.WAYANG_DATA_DIR = previousData;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("same-inode AGENTS.md modification immediately before replace is rejected by final content hash", () => {
  const f = fixture("wayang-instructions-same-inode-");
  try {
    const file = path.join(f.cwd, "AGENTS.md");
    const original = "original synthetic instructions\n";
    const raced = "same inode external update\n";
    fs.writeFileSync(file, original);
    const inode = fs.statSync(file).ino;
    setProjectInstructionsCommitHookForTests(({ file: target, replacingExisting }) => {
      assert.equal(replacingExisting, true);
      fs.writeFileSync(target, raced);
      assert.equal(fs.statSync(target).ino, inode, "race preserves inode so hash check is required");
    });

    assert.throws(() => writeProjectInstructions(f.project.id, {
      text: "approved replacement\n",
      expected_sha256: digest(original),
    }), /changed externally/);
    assert.equal(fs.readFileSync(file, "utf8"), raced);
  } finally { f.cleanup(); }
});

test("external AGENTS.md create race is never overwritten", () => {
  const f = fixture("wayang-instructions-create-race-");
  try {
    const file = path.join(f.cwd, "AGENTS.md");
    const raced = "external creator wins\n";
    setProjectInstructionsCommitHookForTests(({ file: target, replacingExisting }) => {
      assert.equal(replacingExisting, false);
      fs.writeFileSync(target, raced);
    });

    assert.throws(() => writeProjectInstructions(f.project.id, {
      text: "approved create content\n",
      expected_sha256: null,
      create_if_missing: true,
    }), /created while it was being saved/);
    assert.equal(fs.readFileSync(file, "utf8"), raced);
  } finally { f.cleanup(); }
});

test("successful instruction commit returns known committed content without a post-commit reread", () => {
  const f = fixture("wayang-instructions-known-result-");
  try {
    const text = "known committed synthetic content\n";
    const result = writeProjectInstructions(f.project.id, {
      text,
      expected_sha256: null,
      create_if_missing: true,
    });
    assert.equal(result.text, text);
    assert.equal(result.sha256, digest(text));
    assert.equal(fs.readFileSync(path.join(f.cwd, "AGENTS.md"), "utf8"), text);
  } finally { f.cleanup(); }
});
