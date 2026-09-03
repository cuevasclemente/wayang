import assert from "node:assert/strict";
import test from "node:test";
import { uploadedArtifactChips, userVisibleMessageText } from "../src/components/artifacts/artifactMessage.ts";

test("durable upload annotations become artifact chips without exposing storage paths in visible chat", () => {
  const text = `Please inspect this.\n<file name="/private/storage/opaque" attachment_id="attachment-1" artifact_id="artifact-1">[Uploaded file report.md; text/markdown; 120 B. Saved at this path for tool access.]</file>`;
  assert.deepEqual(uploadedArtifactChips(text), [{ id: "artifact-1", name: "report.md" }]);
  const visible = userVisibleMessageText(text);
  assert.equal(visible, "Please inspect this.");
  assert.equal(visible.includes("/private/storage"), false);
});

test("legacy upload notes without artifact ids remain ordinary text", () => {
  const text = `<file name="/legacy/path" attachment_id="attachment-1">[Uploaded file old.txt; text/plain; 2 B.]</file>`;
  assert.deepEqual(uploadedArtifactChips(text), []);
  assert.equal(userVisibleMessageText(text), text);
});
