import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeWorkspaceMutation,
  stableWorkspaceJson,
  workspaceApprovalQuestion,
  workspaceOperationDigest,
  type WorkspaceMutationEnvelope,
} from "./workspace-control.js";

test("canonical workspace hashing is key-order stable and binds every envelope field", () => {
  const base: WorkspaceMutationEnvelope = {
    schema_version: 1,
    source_session_id: "source-a",
    mutation_type: "agent_profile_create",
    mutation: canonicalizeWorkspaceMutation({
      mutation: { instructions: "byte-exact\n", name: "Synthetic" },
      mutation_type: "agent_profile_create",
    }).mutation,
    precondition: { kind: "profile_name_absent", sha256: "a".repeat(64) },
    expires_at: "2030-01-01T00:00:00.000Z",
  };
  assert.equal(stableWorkspaceJson(base), stableWorkspaceJson({
    expires_at: base.expires_at,
    precondition: base.precondition,
    mutation: base.mutation,
    mutation_type: base.mutation_type,
    source_session_id: base.source_session_id,
    schema_version: base.schema_version,
  }));
  assert.equal(workspaceOperationDigest(base), workspaceOperationDigest({ ...base }));
  assert.notEqual(workspaceOperationDigest(base), workspaceOperationDigest({ ...base, source_session_id: "source-b" }));
  assert.notEqual(workspaceOperationDigest(base), workspaceOperationDigest({ ...base, expires_at: "2030-01-01T00:00:01.000Z" }));
  assert.notEqual(workspaceOperationDigest(base), workspaceOperationDigest({ ...base, precondition: { ...base.precondition, sha256: "b".repeat(64) } }));
  assert.notEqual(workspaceOperationDigest(base), workspaceOperationDigest({
    ...base,
    mutation: { ...(base.mutation as any), instructions: "byte-exact\r\n" },
  }));
});

test("canonicalization sorts set-valued allowlists and rejects unknown nested keys", () => {
  const canonical = canonicalizeWorkspaceMutation({
    mutation_type: "project_create",
    mutation: {
      cwd: "/synthetic/nonexistent-project",
      access_policy: {
        privacy_mode: "protected",
        allowed_agent_profile_ids: ["z", "a", "z"],
      },
    },
  });
  assert.deepEqual((canonical.mutation as any).access_policy.allowed_agent_profile_ids, ["a", "z"]);
  assert.throws(() => canonicalizeWorkspaceMutation({
    mutation_type: "project_create",
    mutation: { cwd: "/synthetic", access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null, forged: true } },
  }), /Unknown access_policy field/);
  assert.throws(() => canonicalizeWorkspaceMutation({
    mutation_type: "agent_profile_update",
    mutation: { id: "p", updates: { enabled: true, forged: "value" } },
  }), /Unknown agent profile update field/);
});

test("canonicalization accepts explicit null default pairs and rejects invalid non-null values", () => {
  for (const proposal of [
    {
      mutation_type: "project_create",
      mutation: { cwd: "/synthetic/nullable-project", default_provider: null, default_model: null },
    },
    {
      mutation_type: "agent_profile_create",
      mutation: { name: "Synthetic nullable profile", default_provider: null, default_model: null },
    },
  ]) {
    const canonical = canonicalizeWorkspaceMutation(proposal) as any;
    assert.equal(canonical.mutation.default_provider, null);
    assert.equal(canonical.mutation.default_model, null);
  }

  assert.throws(() => canonicalizeWorkspaceMutation({
    mutation_type: "project_create",
    mutation: { cwd: "/synthetic/blank-provider", default_provider: " ", default_model: "model" },
  }), /default_provider must be a nonempty string or null/);
  assert.throws(() => canonicalizeWorkspaceMutation({
    mutation_type: "agent_profile_create",
    mutation: { name: "Mixed defaults", default_provider: "provider", default_model: null },
  }), /default_provider and default_model must both be set or both be null/);
});

test("ordinary workspace mutations reject capability authority and legacy built-in metadata fields", () => {
  for (const proposal of [
    { mutation_type: "project_create", mutation: { cwd: "/synthetic/project", capability_grants: [] } },
    { mutation_type: "project_update", mutation: { id: "project", updates: { authorization_revision: 99 } } },
    { mutation_type: "agent_profile_create", mutation: { name: "Synthetic", builtin_kind: "wren" } },
    { mutation_type: "agent_profile_update", mutation: { id: "profile", updates: { capability_grants: [] } } },
    { mutation_type: "agent_profile_delete", mutation: { id: "profile", deletable: true } },
  ]) {
    assert.throws(() => canonicalizeWorkspaceMutation(proposal), /Unknown/);
  }
});

test("approval question is one fixed binary question and never contains private text", () => {
  const privateText = "SYNTHETIC_PRIVATE_AGENTS_TEXT";
  const question = workspaceApprovalQuestion({
    digest: "c".repeat(64),
    summary: "write AGENTS.md (bytes 29, sha256 deadbeef)",
    sourceSessionId: "source-session",
    expiresAt: "2030-01-01T00:00:00.000Z",
    warning: "Project instructions affect future agent behavior.",
  });
  assert.equal(question.length, 1);
  assert.deepEqual(question[0]!.options, [
    { value: "APPROVE", label: "APPROVE" },
    { value: "REJECT", label: "REJECT" },
  ]);
  assert.equal(JSON.stringify(question).includes(privateText), false);
  assert.match(question[0]!.prompt, /cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc/);
});
