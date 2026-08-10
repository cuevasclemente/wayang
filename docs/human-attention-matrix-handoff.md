# Human-attention handoff for connector-neutral messaging

**Date:** 2026-08-10  
**Owner:** existing connector-neutral messaging/Matrix implementation session  
**Status:** contract handoff only; Matrix remains disabled and undeployed

## Goal

Deliver a minimal notification to the exact configured Project–Agent Matrix endpoint when an authoritative Wayang human-input gate opens. The actual answer, approval, credential entry, browser action, sudo action, or other sensitive step remains in Wayang.

Initial source authority is an `InterviewRecord` with `status === "open"`. The existing session REST projection exposes only content-free attention metadata:

```ts
interface HumanAttentionSummary {
  sessionId: string;
  kind: "question";
  sourceId: string;
  createdAt: number;
  status: "pending";
  requiresWayang: true;
}
```

This REST shape is display metadata, not sufficient delivery provenance by itself.

## Current integration blocker

The current messaging delivery graph is ingress-coupled:

- every `MessagingDeliveryRow` references a `MessagingEventRow`;
- ordering comes from the inbound event acceptance sequence;
- delivery retention and collision authority are pruned with the inbound event graph; and
- current `continue_in_wayang` delivery identity is event-derived.

A human-attention notification is source-originated. Do **not** represent it as a synthetic Matrix event, fake sender, fake prompt, or ordinary `continue_in_wayang` response.

The current `InterviewRecord` also does not persist the immutable Project ID–Agent Profile ID pair that opened the gate. Looking up the session's current profile later is insufficient because the profile can change. Before Matrix notification can be authoritative, either:

1. capture immutable `project_id` and `agent_profile_id` when the gate opens (recommended), or
2. prohibit session identity changes while a gate is open.

The source also needs a durable all-session open-gate projection for startup recovery; `PiInterviewBridge.onRequest()` alone is only an in-memory accelerator.

## Recommended source projection

```ts
type HumanAttentionGateKind = "question";

interface HumanAttentionGateProjection {
  gateId: string;
  kind: HumanAttentionGateKind;
  state: "open" | "resolved";
  sessionId: string;
  projectId: string;
  agentProfileId: string;
  revision: number;
  createdAt: number;
}

interface HumanAttentionGateProjectionPort {
  get(gateId: string): HumanAttentionGateProjection | null;
  listOpen(): readonly HumanAttentionGateProjection[];
  subscribe(listener: (gate: HumanAttentionGateProjection) => void): () => void;
}
```

The projection must contain no question text, labels, options, answers, approval summary, tool arguments/results, local paths, browser content, session title, or transcript content.

## Messaging store changes

Decouple delivery provenance with a discriminated source:

```ts
type MessagingDeliverySource =
  | {
      kind: "inbound_event";
      connectorEventId: string;
      acceptanceSequence: number;
    }
  | {
      kind: "human_attention_gate";
      gateId: string;
      gateKind: HumanAttentionGateKind;
      sessionId: string;
      sourceRevision: number;
    };
```

Add one endpoint outbox sequence shared by inbound responses and source notifications. Add compact attention projection/collision rows uniquely keyed by `(gate_id, endpoint_id)`. Existing delivery rows require a versioned migration to the `inbound_event` source variant.

Suggested store operations:

```ts
enqueueMessagingHumanAttention(input): {
  outcome: "enqueued" | "duplicate" | "skipped_no_endpoint";
  delivery?: MessagingDeliveryRow;
};

resolveMessagingHumanAttention(gateId: string, sourceRevision: number): void;
```

Enqueue must:

- accept only a current authoritative open projection;
- match the exact immutable Project/Profile pair against the **current reviewed declaration map**, not historical durable endpoint rows;
- require the reconciled declaration hash and exact bound conversation;
- atomically enforce `(gateId, endpointId)` uniqueness;
- create no delivery when no current matching endpoint exists; and
- never alter the source gate.

Keep a compact delivered projection while a gate remains open; otherwise normal seven-day delivery compaction followed by startup reconciliation could resend it. After resolution, retain collision authority for the existing horizon and prune atomically.

## Gateway and worker behavior

Add a connector-neutral source-facing gateway method such as:

```ts
projectHumanAttentionGate(
  gate: HumanAttentionGateProjection,
): Promise<"enqueued" | "duplicate" | "skipped_no_endpoint">;
```

On startup, reconcile `listOpen()` after store recovery, then subscribe for low-latency updates. Disabled messaging must not scan, subscribe, enqueue, provision, or contact Matrix.

Before every remotely visible send, retry, or subchunk:

1. re-read the source gate and require the same identity, immutable pair, compatible revision, and `state === "open"`;
2. reauthorize the exact current Project/Profile pair through central interactive policy;
3. run the existing fresh membership/confidentiality attestation;
4. persist these checks under the delivery claim; and
5. send with the existing deterministic transaction-ID mechanism.

If the gate resolved, declaration changed, endpoint vanished, pair changed, session became ineligible, or attestation drifted, withhold safely. Never submit, cancel, or weaken the source gate.

Use the existing canonical session URL helper. Visible Matrix content must remain generic:

```text
Human input needed in Wayang.
Open Wayang: <canonical session URL>
```

Do not display the gate ID, question, tool name, session title, project path, or any other source content. Replies, reactions, edits, redactions, read receipts, room membership, and delivery receipts never resolve the gate. A Matrix text reply may remain an independent ordinary prompt under existing rules, but has no gate-answer authority.

## Required tests

1. Duplicate `(gateId, endpointId)` creates one delivery and one deterministic Matrix transaction.
2. Missing current declaration/binding stores nothing and leaves the source gate open.
3. Historical omitted endpoint rows are never selected.
4. Wrong/unresolved Project/Profile identity, changed profile, archived/quarantined/deleted session, and stale source revision fail safely.
5. Source resolution before send produces no output.
6. Source resolution between subchunks preserves any acknowledged prefix and withholds the remainder.
7. Every retry/subchunk repeats source, central policy, membership, and confidentiality checks.
8. Visible body is exactly generic text plus canonical URL; assert absence of source content and gate ID.
9. Restart after remote acknowledgement uses the same transaction ID and does not resend.
10. Delivered-but-still-open collision authority survives normal delivery compaction.
11. Resolved authority prunes only after the retention horizon.
12. Matrix interactions never mutate/submit/cancel the source gate.
13. Disabled bootstrap performs no gate reads, subscriptions, or Matrix effects.

## Ownership boundary

The human-attention integration branch does not modify `backend/src/messaging/**`. The existing Matrix session owns schema, migration, gateway, worker, and connector changes. Coordinate an explicit integration commit before another worktree consumes its in-progress implementation; never transplant its dirty checkout implicitly.
