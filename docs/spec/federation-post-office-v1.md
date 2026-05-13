# DreamGraph Federation Post Office Protocol

**Version:** 1.0 (draft)
**Status:** Draft for community review.
**Document identifier:** `dg-fpo/1.0`
**Editor:** DreamGraph project.
**Discussion:** project federation working group.

> This document is the **protocol specification** for the DreamGraph
> Federation Post Office. It defines wire formats, on-disk layout,
> actor responsibilities, and conformance requirements that any
> implementation MUST satisfy in order to interoperate with other
> conformant participants.
>
> This document is **not** the DreamGraph implementation plan. The
> implementation plan (which schedules slices, references source files,
> and contains internal CLI design) lives elsewhere in the repository
> and is not normative for outside implementers. Where the two
> documents disagree, **this specification is the source of truth for
> interoperability**, and the implementation plan is the source of
> truth for the DreamGraph reference implementation.

---

## 1. Introduction

The DreamGraph Federation Post Office Protocol (`dg-fpo/1.0`, hereafter
"the Protocol" or "FPO") describes a low-coordination, filesystem-first
federation of cooperating DreamGraph instances. Participants exchange
signed envelopes that carry payloads — most commonly anonymized
"archetype" patterns derived from a participant's own knowledge graph —
through three well-defined channels: directed instance-to-instance mail,
group-scoped multicast, and a public broadcast billboard.

The Protocol is designed for environments where a shared filesystem
(local disk, mounted network share, cloud-mounted bucket) is the only
guaranteed transport. It does not require any always-on network
service, broker, or coordinator. Participants may be intermittently
online; envelopes are durable until delivered or garbage-collected.

### 1.1 Goals

- **Single delivery surface.** Every cross-instance message is an
  envelope. Configuration, joining, leaving, archetype sharing, and
  acknowledgements all use the same envelope format.
- **Strong actor boundaries.** Four named roles, each with a single
  responsibility, so that an implementation that crosses the
  boundaries fails an interoperability test rather than producing
  silently divergent behaviour.
- **Pseudonymous broadcast.** Participants MAY publish low-correlation
  patterns to a shared billboard without revealing the originating
  instance identifier on the wire.
- **Tamper-evident audit.** Every accepted, rejected, or quarantined
  envelope leaves a deterministic, content-addressed trace on disk.
- **Filesystem-first.** No required network transport, no required
  third-party service, no required clock synchronisation beyond loose
  bounds.

### 1.2 Non-goals

- Strong anonymity. The billboard offers *pseudonymity* (see §13).
- Real-time delivery latency guarantees.
- A formal trust authority. Trust is per-participant, per-group.
- Defining the semantics of any specific payload kind beyond
  `archetype_share` (§9). New payload kinds extend the registry in §17.

### 1.3 Document conventions

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL
NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and
**OPTIONAL** in this document are to be interpreted as described in BCP
14 ([RFC 2119], [RFC 8174]) when, and only when, they appear in all
capitals.

TypeScript-style type definitions in this document are **informative**,
not normative; the normative wire format is the JSON described in §6
and §17. Where a type and a JSON description disagree, the JSON
description prevails.

---

## 2. Terminology

- **Participant** — an addressable endpoint identified by an `instance_uuid`.
- **Federation root** — a directory shared (mounted, copied, or local)
  among participants, containing the global post office state.
- **Mailbox** — a per-participant directory tree under
  `<masterDir>/<instance_uuid>/federation/` holding inbound and
  outbound state for that participant.
- **Envelope** — a JSON document with a fixed routing header and a
  kind-specific payload.
- **Group** — a named, manifest-described set of participants permitted
  to multicast to one another.
- **Billboard** — a public, append-only feed of envelopes whose `to`
  field is `{ kind: "billboard" }`.
- **FedEx role** — the actor responsible for *writing* envelopes (§5.1).
- **Postal role** — the actor responsible for *moving directed mail*
  between participants and groups (§5.2).
- **Billboard puller role** — the actor responsible for *reading the
  billboard* into a participant's local mailbox (§5.3).
- **Importer role** — the actor responsible for *accepting or
  rejecting* delivered envelopes and applying their effects (§5.4).
- **Implementation** — a software participant that claims to conform
  to this specification at one of the levels defined in §19.

The term "send" refers to the act of producing an envelope. The term
"deliver" refers to the act of placing an envelope into a recipient's
inbox. The term "import" refers to the act of acting on a delivered
envelope.

---

## 3. Reference architecture

A conformant implementation MUST realise four roles. The roles MAY be
implemented as four processes, four threads, four classes, or four
functions; what matters is that the **prohibitions** in this section
hold.

```
+--------------+      writes       +----------------------------+
|   FedEx      | ----------------> |  outbox / group outgoing / |
|              |                   |  billboard / raw export    |
+--------------+                   +----------------------------+
                                          |
                                          | reads (header only)
                                          v
+--------------+   atomic move    +----------------------------+
|   Postal     | ---------------> |  recipient inbox(es)       |
|              |                   +----------------------------+
+--------------+

+----------------+   tail + filter + copy
| Billboard      | ---------------------------> recipient inbox
| Puller         |
+----------------+

+--------------+   reads inbox      +----------------------------+
|  Importer    | -----------------> |  cognition / state apply   |
|              |   accept/reject    +----------------------------+
+--------------+
```

### 3.1 Role responsibilities

1. **FedEx role.** MUST construct envelopes (§6), MUST sign them when
   required (§7), and MUST place them into exactly one of the four
   landing zones: the local outbox, a group outgoing queue, the
   billboard archive, or a `raw_export` filesystem path (§9.5). It
   MUST NOT read other participants' inboxes, MUST NOT route mail it
   did not produce, and MUST NOT import payloads.

2. **Postal role.** MUST handle only envelopes whose `to.kind` is
   `"instance"` or `"group"` (collectively, "directed mail"). It MUST
   NOT touch the billboard, MUST NOT touch `raw_export` files, and
   MUST NOT open or interpret payload bodies; it MAY read only the
   header fields enumerated in §6.2 plus the payload byte-length cap
   recorded in `payload_bytes`.

3. **Billboard puller role.** MUST be the only role that reads the
   billboard for the purpose of copying envelopes into participant
   inboxes. Maintenance code (e.g. listing, garbage collection) MAY
   read billboard files for read-only operational purposes; such code
   is not a delivery actor. A billboard puller MUST NOT deliver to any
   participant other than the participant it serves.

4. **Importer role.** MUST be the only role that touches participant
   cognition or state derived from envelope payloads. It MUST validate
   signatures (§7), apply per-participant delivery policy (§4.1.2),
   and either accept or reject each envelope to the on-disk audit
   trail described in §4.

The single most important interoperability invariant: **no role may
perform another role's writes.** A FedEx implementation that "just
imports for the local case", or a Postal implementation that "fans out
billboard drops as if they were directed mail", is non-conformant.

### 3.2 Concurrency model

The four roles are independent. An implementation MAY run multiple
FedEx, Postal, Billboard Puller, and Importer instances concurrently,
subject to the lock requirements of §10.

The Postal role uses a leader lock (§10) to prevent multiple Postal
processes from delivering the same envelope twice. A leader, once
elected, MUST scan **every** active participant outbox plus every group
outgoing queue it has read access to; it MUST NOT scan only its own
host's outboxes. Failure to do so will starve non-leader participants'
outbound mail and is non-conformant.

---

## 4. Filesystem layout (normative)

A conformant implementation MUST use exactly the directory structure
below, relative to two roots:

- the **participant root** `<masterDir>/<instance_uuid>/federation/`,
  one per participant;
- the **federation root** `<masterDir>/federation/` (or whatever path
  the implementation resolves the federation root to — see §4.2),
  shared by all participants reachable through that filesystem.

Implementations MAY add files alongside those listed below; consumers
MUST ignore unrecognised files. Implementations MUST NOT relocate or
rename the listed files.

### 4.1 Participant root (`<masterDir>/<instance_uuid>/federation/`)

```
config.json                    InstanceFederationConfig (§4.1.1)
identity.json                  active public identity (§7.1)
identity.pending.json          staged rotation key, if any (§7.4)
keys/
  ed25519.private              active key; mode 0600; never copied
  ed25519.pending.private      staged rotation key, if any
inbox/
  .flag                        mtime bump = "you got mail"
  .notifications.jsonl         one line per delivery
  <envelope_id>.json (+ .meta.json)
inbox_pending/                 manual mode hold area
  <envelope_id>/
    envelope.json
    meta.json
    verdict.json               absent until operator decision
accepted/<yyyy-mm>/<envelope_id>/envelope.json
rejected/<yyyy-mm>/<envelope_id>/envelope.json (+ reason.txt)
outbox/
  pending/<envelope_id>.json
  shipped/<yyyy-mm>/<envelope_id>.json
  failed/<envelope_id>.json (+ .error.txt)
```

#### 4.1.1 `config.json` — `InstanceFederationConfig`

The participant configuration MUST be valid against the following shape
(informative TypeScript; canonical JSON):

```ts
interface InstanceFederationConfig {
  schema_version: "1.0.0";
  instance_uuid: string;
  display_name: string;
  enabled: boolean;
  identity: {
    public_key: string;        // ed25519, base64
    private_key_path: string;  // relative to participant root
    fingerprint: string;       // sha256(public_key), hex
    created_at: string;        // ISO 8601
  };
  delivery: DeliveryPolicy;
  outbound: OutboundDefaults;
  groups: { member_of: string[]; auto_join_requests: boolean };
  billboard: BillboardConfig;
  retention: RetentionConfig;
}
```

#### 4.1.2 `DeliveryPolicy`

```ts
interface DeliveryPolicy {
  inbox_mode: "auto_accept" | "manual" | "policy"; // default "manual"
  accept_from_groups: string[];
  accept_from_instances: string[];
  blocked_instances: string[];
  reject_unknown: boolean;                  // default true
  accept_unsigned_anonymous: boolean;       // default false
  max_inbox_items: number;                  // default 1000
  notification_flag: boolean;               // default true
}
```

The delivery policy is consulted by the **importer** role only. Postal
MUST use only `blocked_instances` to suppress delivery (§9.3); all
other policy is post-delivery.

#### 4.1.3 `BillboardConfig`

```ts
interface BillboardConfig {
  publish: boolean;
  pull_enabled: boolean;
  pull_since?: { offset: number; last_created_at?: string };
  pull_filter?: { kinds?: string[]; from_groups?: string[] };
}
```

`pull_since.offset` is a byte offset into the billboard index file
(§11) and is **authoritative**. `last_created_at` is informational
recovery metadata only and MUST NOT be used as the primary watermark.

### 4.2 Federation root (`<masterDir>/federation/`)

```
fedex.config.json              FedExConfig (§4.2.1)
postal.lock                    Postal leader heartbeat (§10)
groups/
  <group_id>/
    manifest.json              GroupManifest (§4.3)
    members/<instance_uuid>.json
    invitations/<envelope_id>.json
    join_requests/<envelope_id>.json
    outgoing/<envelope_id>.json
    shipped/<yyyy-mm>/<envelope_id>.json
    failed/<envelope_id>.json (+ .error.txt)
    postal_log.jsonl
instances/
  <instance_uuid>.json         InstanceRegistryEntry (§4.4)
billboard/
  index.jsonl                  tail-friendly index
  <yyyy-mm>/<content_hash>.json
  .archive/                    GC'd entries
```

The federation root location MAY be overridden by an implementation-
specific mechanism (an environment variable in the reference
implementation). The default MUST be `<masterDir>/federation/` so that
two participants under the same masterDir interoperate without
configuration.

#### 4.2.1 `FedExConfig`

```ts
interface FedExConfig {
  schema_version: "1.0.0";
  federation_root: string;
  enabled: boolean;
  worker: {
    poll_interval_ms: number;       // default 5000
    leader_lock_ttl_ms: number;     // default 15000
    max_concurrent_deliveries: number; // default 4
    fanout_batch_size: number;      // default 32
  };
  routing: {
    transports: Array<
      | { kind: "local_fs" }
      | { kind: "mounted_fs"; root: string }
    >;
    discovery: {
      registry_path: string;        // default "instances"
      refresh_interval_ms: number;
      stale_after_ms: number;       // default 86_400_000 (24h)
    };
  };
  conflict_policy: {
    default: ConflictPolicy;
    by_group?: Record<string, ConflictPolicy>;
  };
  billboard: { enabled: boolean; retention_days: number; max_items: number };
  security: {
    require_signed_envelopes: boolean;     // default true
    trust_store_path: string;              // default "instances"
    reject_clock_skew_seconds: number;     // default 300
    max_payload_bytes: number;             // default 2_097_152 (2 MiB)
  };
  audit: { enabled: boolean; log_path: string };
}

type ConflictPolicy =
  | "last_write_wins"
  | "content_hash_dedup"
  | "queue_for_triage";
```

See §14 for the precise semantics of each conflict policy.

### 4.3 Group manifest (`groups/<group_id>/manifest.json`)

```ts
interface GroupManifest {
  schema_version: "1.0.0";
  group_id: string;                   // uuid v4
  slug?: string;                      // UI hint only; never trusted
  display_name: string;
  created_at: string;
  created_by: string;                 // founding instance uuid
  description?: string;
  conflict_policy?: ConflictPolicy;
  membership_policy: "open" | "invite_only" | "approval_required";
  trust_anchors: string[];            // public-key fingerprints
  admins: string[];                   // instance uuids
  manifest_signature: string;         // ed25519 over manifest minus this field
}
```

### 4.4 Instance registry entry (`instances/<instance_uuid>.json`)

```ts
interface InstanceRegistryEntry {
  schema_version: "1.0.0";
  instance_uuid: string;
  display_name: string;
  identity_status: "uninitialized" | "active" | "revoked";
  public_key?: string;                // present iff identity_status === "active"
  fingerprint?: string;               // present iff identity_status === "active"
  registered_at: string;
  last_seen_at: string;
  mailbox: {
    transport: "local_fs" | "mounted_fs";
    path?: string;                    // required for mounted_fs
  };
  capabilities?: { accepts_kinds?: string[] };
}
```

`identity_status` semantics:

- `uninitialized` — registered but no key; MUST NOT send signed mail;
  MAY receive directed mail subject to recipient delivery policy. A
  recipient with `delivery.reject_unknown = true` rejects such mail.
- `active` — key present; full participant.
- `revoked` — key revoked; treated as `uninitialized` for inbound, and
  any envelope claiming a signature from the prior key MUST be
  rejected by the importer.

### 4.5 Group membership record (`members/<instance_uuid>.json`)

```ts
interface GroupMemberRecord {
  schema_version: "1.0.0";
  group_id: string;
  instance_uuid: string;
  public_key: string;                 // pinned at admission
  fingerprint: string;
  role: "member" | "admin";
  admitted_at: string;
  admitted_by: string;                // admitting admin uuid
  admission_signature: string;        // ed25519 over record minus this field
  expires_at?: string;
}
```

A participant is a member of a group if and only if a valid signed
`GroupMemberRecord` exists at
`groups/<group_id>/members/<instance_uuid>.json`. The Postal role
re-checks membership **per delivery**, not per startup, so expulsion
takes effect on the next tick.

Verification of `admission_signature` is performed against the
**current** `manifest.admins` and `trust_anchors`. Implementations MAY
extend this to a recorded admission-time trust state in a future
profile; v1 uses current state.

---

## 5. Roles in detail

This section describes the algorithm each role MUST follow. Where an
algorithm uses an internal data structure not visible on the wire, the
implementation MAY substitute any equivalent realisation.

### 5.1 FedEx role

The FedEx role exposes a single operation, conceptually
`ship(payload, destination)`. For every call:

1. Construct an envelope (§6) with a fresh `envelope_id` (uuid v4).
2. Compute `content_hash` (§6.4) and `payload_bytes`.
3. Compute `idempotency_key` (§13.1).
4. If the envelope requires a signature (§7.3), sign it.
5. Validate the destination per §9.2.
6. Write the envelope to its landing zone using an atomic write
   (§4.6).
7. For `group` and `billboard` destinations, also write a
   `ShipmentReceipt` (§9.6) to the participant's local
   `outbox/shipped/<yyyy-mm>/`.

If validation fails, FedEx MUST write nothing and MUST surface a
typed error. FedEx MUST NOT silently downgrade a destination (e.g.
`group` → `billboard`).

### 5.2 Postal role

The Postal role's tick:

1. Acquire (or refresh) the leader lock (§10).
2. Enumerate sources to scan:
   - Every active participant's `outbox/pending/` (from the registry).
   - Every `groups/<group_id>/outgoing/` directory the leader has read
     access to.
3. For each source envelope, read the routing header only. Resolve
   `to`:
   - `to.kind === "instance"`: exactly one recipient. If the
     `instanceId` does not exist in `instances/`, move source to
     failure quarantine with reason `unknown_instance` (§16).
   - `to.kind === "group"`: recipients are every `instance_uuid` with
     a valid signed `GroupMemberRecord` in
     `groups/<groupId>/members/`. If the sender is not itself a
     member, move source to `groups/<group_id>/failed/` with reason
     `not_a_member`.
4. Per recipient: skip if
   `recipient.delivery.blocked_instances` contains the sender. Record
   the skip in the audit trail as `blocked_by_recipient`. Do not
   deliver.
5. Atomically write `inbox/<envelope_id>.json` for each surviving
   recipient, bump `inbox/.flag`'s mtime, append a line to
   `inbox/.notifications.jsonl`.
6. Archive the source:
   - Instance source: move local `outbox/pending/<id>.json` →
     sender's `outbox/shipped/<yyyy-mm>/<id>.json`.
   - Group source: move global `groups/<id>/outgoing/<id>.json` →
     `groups/<id>/shipped/<yyyy-mm>/<id>.json`. Sender-side
     `outbox/shipped/` receipts (§9.6) MUST NOT be touched.
7. On unrecoverable failure, move the source to the appropriate
   `failed/` directory with an `.error.txt` sidecar.

The Postal role MUST NOT open the payload body. It uses only:
`envelope_id`, `idempotency_key`, `kind`, `from_instance`, `to`,
`group_id`, `created_at`, `content_hash`, `payload_bytes`, and
`signature`.

The Postal role MUST handle envelopes whose `kind` is
`"join_request"` as a routing exception: the source may be a
non-member writing into `groups/<id>/join_requests/`; routing fans the
envelope header to admin inboxes only. The Postal role MUST NOT inspect
or validate any token or other payload-level join material; that
validation is the importer's responsibility (§10.3).

### 5.3 Billboard puller role

For each participant whose `billboard.pull_enabled` is `true`, on
every poll interval:

1. Tail `billboard/index.jsonl` from `pull_since.offset`.
2. For each new index line, read the referenced envelope header and
   apply `pull_filter` (`kinds`, `from_groups`).
3. **Skip self-authored entries**: if `envelope.from_instance` equals
   the participant's `instance_uuid`, advance the watermark and
   continue without copying. Anonymized drops (`from_instance`
   beginning with `"anon:"`) cannot be self-attributed and are not
   skipped; the importer dedupes them by `content_hash` against the
   local validated set.
4. If the envelope passes the filter, *copy* it (preserving the
   original `from_instance`, including `"anon:"` sentinels) into the
   participant's local `inbox/`.
5. Update `pull_since.offset` (and, optionally, `last_created_at`).

The billboard puller MUST NOT delete from the billboard archive.
Archive garbage collection is a separate maintenance task driven by
`FedExConfig.billboard.retention_days`.

### 5.4 Importer role

For each envelope in `inbox/`:

1. **Verify signature** (§7.3). On failure: route to
   `rejected/<yyyy-mm>/` with reason `bad_signature`.
2. **Detect legacy bundle** (§9.4). If matched, synthesize an envelope
   wrapper and continue.
3. **Apply delivery policy** (§4.1.2):
   - `inbox_mode === "auto_accept"`: continue.
   - `inbox_mode === "manual"`: move to `inbox_pending/<envelope_id>/`
     as a directory (not a flat file) containing `envelope.json` and
     `meta.json`. Wait for `verdict.json` to appear (operator
     decision). The importer MUST NOT mutate `envelope.json`. On
     `verdict.json` arrival, re-enter the same accept/reject branch as
     `auto_accept`. There is no second code path.
   - `inbox_mode === "policy"`: apply rule-based policy (allowed
     kinds, allowed senders); fall through to accept or reject.
4. **Conflict check** (§14).
5. **Dispatch by `kind`** (§17). On accept, invoke the kind-specific
   handler and move the envelope to `accepted/<yyyy-mm>/<envelope_id>/`.
   On reject, move to `rejected/<yyyy-mm>/<envelope_id>/` with a
   `reason.txt` sidecar.

The importer is the **only** role that may touch participant
cognition. The importer is the **only** role that may write or modify
`GroupMemberRecord` files (admission, expulsion, leave).

---

## 6. Envelope format

### 6.1 Schema

```ts
type RoutableDestination =
  | { kind: "billboard" }
  | { kind: "group"; groupId: string }
  | { kind: "instance"; instanceId: string };

type FederationDestination =
  | RoutableDestination
  | { kind: "raw_export"; exportPath: string };

type FederationEnvelopeKind =
  | "archetype_share"
  | "join_request"
  | "join_response"
  | "announcement"
  | "ack"
  | "membership_revoke";

interface FederationEnvelope<TPayload = unknown> {
  envelope_id: string;
  idempotency_key: string;
  schema_version: "1.0.0";
  kind: FederationEnvelopeKind;
  from_instance: string;            // uuid OR "anon:<hex>" sentinel
  to: RoutableDestination;          // raw_export envelopes do not exist on the wire
  group_id?: string;
  created_at: string;               // ISO 8601 UTC
  content_hash: string;             // sha256 of canonical(payload), hex
  payload_bytes: number;
  payload: TPayload;
  signature?: string;               // ed25519, base64; required except as in §7.3
}
```

The `to` field of an envelope on the wire is **always** a
`RoutableDestination`. The `raw_export` variant exists only as a
caller-side argument to FedEx for the purpose of writing a one-way file
**outside** the protocol; such files are not envelopes addressed to a
recipient and MUST NOT carry a signature, content hash, or idempotency
key as a routing concern.

### 6.2 Postal-visible header

The Postal role MUST read only the following fields:
`envelope_id`, `idempotency_key`, `kind`, `from_instance`, `to`,
`group_id`, `created_at`, `content_hash`, `payload_bytes`,
`signature`. An implementation that parses additional fields in the
Postal role is non-conformant.

### 6.3 Canonical JSON

Hashing and signing operate on a **canonical JSON** form:

- Object keys sorted lexicographically by Unicode code point.
- No insignificant whitespace.
- Numbers serialised in shortest unambiguous form (no trailing zeros).
- Strings serialised with escape rules per [RFC 8259].
- Arrays preserve input order.

### 6.4 `content_hash`

`content_hash = lowercase_hex(sha256(canonical_json(payload)))`.

### 6.5 `created_at`

ISO 8601 UTC, second precision or finer, with a trailing `Z`.
Implementations MUST reject envelopes whose `created_at` is more than
`security.reject_clock_skew_seconds` in the future relative to local
clock at receive time. They MUST NOT reject envelopes purely for being
"too old"; retention is a recipient-side garbage-collection concern,
not a delivery filter.

---

## 7. Identity and cryptography

### 7.1 Keys

- Algorithm: Ed25519 ([RFC 8032]).
- Public keys: base64-encoded raw 32-byte form.
- Private keys: stored at `keys/ed25519.private`, mode `0600`,
  contents implementation-defined; MUST NOT be transferred between
  hosts by the protocol.
- Fingerprint: `lowercase_hex(sha256(raw_public_key))`.

### 7.2 First-use bootstrap

On a participant's first FedEx send (or on explicit operator action),
an implementation MUST:

1. Generate an Ed25519 keypair.
2. Write the private key with mode `0600`.
3. Populate `identity.json` and `config.json` with the public key and
   fingerprint.
4. Atomically promote the participant's `InstanceRegistryEntry` from
   `identity_status: "uninitialized"` to `"active"`.
5. Surface a durable warning to the operator that loss of the private
   key permanently invalidates the participant's group memberships.

### 7.3 Signing

Every envelope on the wire MUST carry a valid `signature` over
`canonical_json(envelope-without-signature)`, **except**:

- Anonymized billboard drops (§13) MAY omit `signature`. A receiver
  accepting such an envelope requires the receiver's
  `delivery.accept_unsigned_anonymous` to be `true`.
- `raw_export` files are not envelopes (§6.1).

A signature MUST verify against a public key obtained from one of:

- the sender's `InstanceRegistryEntry` (`identity_status === "active"`);
- a `GroupMemberRecord.public_key` for the relevant group, when
  present and itself signed by an authorised admin.

Receivers MUST reject envelopes claiming a signature when the sender's
key is unknown unless `delivery.accept_unsigned_anonymous` and
`payload.anonymized === true` apply.

### 7.4 Key rotation

Key rotation has two phases:

1. **Stage.** A participant generates a new keypair, writing it to
   `identity.pending.json` and `keys/ed25519.pending.private`. The
   previous active key remains the only key used to sign envelopes.
   The participant's `InstanceRegistryEntry` MAY carry a
   `pending_public_key` field at this stage.

2. **Promote.** The participant emits a `key_rotation_announce`
   envelope (registered for a future Protocol minor version; see §17)
   to every group it is a member of, awaits acknowledgement under
   group policy, atomically swaps `identity.pending.*` to active, and
   marks the previous registry entry `identity_status: "revoked"`.

Implementations conformant to v1.0 MAY implement only the stage phase
and surface promote as out-of-scope. Until promote is implemented,
rotation is a documented warning, not a complete operation.

---

## 8. Addressing

### 8.1 Identifier shapes

| Entity     | Canonical id          | Wire form on `to`                           |
|------------|-----------------------|---------------------------------------------|
| Instance   | uuid v4               | `{ kind: "instance", instanceId: "<uuid>" }`|
| Group      | uuid v4               | `{ kind: "group", groupId: "<uuid>" }`      |
| Billboard  | (singleton)           | `{ kind: "billboard" }`                     |

There is **no implicit name resolution**. Slugs are UI hints only; the
wire format is always the uuid. Two manifests with the same slug are
distinguished by `group_id`.

### 8.2 Group directories

Group directories on disk are named by `group_id`, not by slug. Two
groups whose slugs collide MUST coexist without conflict.

---

## 9. Sending mail (FedEx)

### 9.1 Operation

A FedEx call is conceptually `ship(payload, destination, options?)`.
Implementations MAY expose other surfaces. The behaviour below is
normative regardless of API shape.

### 9.2 Destination validation

| `destination.kind` | Path written                                                  | Pre-write validation                                                                 |
|--------------------|---------------------------------------------------------------|--------------------------------------------------------------------------------------|
| `raw_export`       | `destination.exportPath`                                      | Path is writable. No protocol invariants apply.                                      |
| `billboard`        | `billboard/<yyyy-mm>/<content_hash>.json` + index append      | `instanceConfig.billboard.publish === true`.                                         |
| `group`            | `groups/<groupId>/outgoing/<envelope_id>.json`                | `groupId ∈ instanceConfig.groups.member_of`, **except** `kind: "join_request"` (§10).|
| `instance`         | `outbox/pending/<envelope_id>.json` (sender-side)             | `instanceId` exists in `instances/` with `identity_status === "active"`.            |

If validation fails, FedEx MUST write nothing.

### 9.3 Atomic writes

Every protocol-defined file write MUST be atomic from the perspective
of a concurrent reader. The standard technique — write to a sibling
`.tmp` file in the same directory, fsync, then rename into place — is
sufficient on POSIX and on conformant network filesystems. Readers MUST
ignore files whose names begin with `.`; implementations MUST NOT use
leading-dot names for delivered envelopes.

### 9.4 Legacy bundle migration (inbound only)

For backwards compatibility, the importer MAY accept a top-level
JSON object of shape `{ metadata, archetypes }` as if it were an
envelope of `kind: "archetype_share"`, `payload_schema_version:
"1.0.0"`, with:

- `from_instance = metadata.source_instance` (recorded as-is, even if
  it is a legacy `dreamgraph_<timestamp>` identifier);
- `created_at = metadata.exported_at`;
- `payload.anonymized = false`;
- per-archetype `source_instance` stripped during normalization.

Such bundles are treated as unsigned, untrusted senders unless the
recipient has pinned the legacy identifier via
`delivery.accept_from_instances`.

FedEx MUST NOT produce legacy bundles. Outbound is always v2.

### 9.5 `raw_export`

A `raw_export` send writes a single file to a caller-supplied path
**outside** the federation network. The file is not addressed to a
recipient, is not delivered by Postal, is not pulled by Billboard
Pullers, and is never imported by any other participant. Its on-disk
shape is implementation-defined; this Protocol does not specify it,
and a future version MAY define one without breaking earlier exports.

A `raw_export` send MUST NOT generate a `ShipmentReceipt`, MUST NOT
enter the idempotency layer, and MUST NOT be signed merely because the
underlying participant has a key.

### 9.6 Local outbox audit trail

For `group` and `billboard` sends, the envelope is written to a global
landing zone that the sender's outbox does not naturally observe. To
keep the sender-side "what did I send?" view honest, FedEx MUST mirror
a header-only `ShipmentReceipt` into
`outbox/shipped/<yyyy-mm>/<envelope_id>.json` immediately after a
successful write:

```ts
interface ShipmentReceipt {
  envelope_id: string;
  idempotency_key: string;
  kind: FederationEnvelopeKind;
  to: RoutableDestination;
  content_hash: string;
  payload_bytes: number;
  shipped_at: string;
  output_path: string;
}
```

`instance` sends do not require a separate receipt: the source file
itself transits `outbox/pending/` → `outbox/shipped/` and serves as
its own receipt.

### 9.7 Size budget

`FedExConfig.security.max_payload_bytes` is the hard maximum payload
size. The default is **2 MiB**. FedEx MUST reject oversize payloads at
write-time with reason `payload_too_large`. The Postal role MUST
re-validate the recorded `payload_bytes` against the cap on read; any
mismatch MUST be quarantined with reason `size_mismatch`. This Protocol
v1 does NOT define chunked or multi-envelope payloads.

---

## 10. Group membership protocol

Joining a group is itself federation traffic. Every entry path emits
the same `kind: "join_request"` envelope primitive. The `membership_policy`
field in the manifest determines who admits and how.

### 10.1 Open groups (`membership_policy: "open"`)

1. Joining instance `A` reads the group manifest (discovery is
   out-of-band: shared `group_id`, dashboard QR, etc.).
2. `A` sends a `kind: "join_request"` envelope to the group, written
   into `groups/<id>/join_requests/`, carrying `A`'s public key,
   display name, and the manifest fingerprint it observed.
3. Postal delivers a header-only notification copy to every admin's
   inbox.
4. The first admin importer to process the request, **provided that
   admin's local `groups.auto_join_requests` is true**, auto-admits:
   it writes a signed `members/<A.uuid>.json` record and emits a
   `kind: "join_response"` envelope of `subkind: "accepted"` back to
   `A`.
5. If no admin has auto-admit enabled, the request falls through to
   manual handling. Open membership policy is therefore a *guideline
   to admins*, not an unconditional admission rule.

### 10.2 Invite-only groups (`membership_policy: "invite_only"`)

1. An admin `X` (uuid in `manifest.admins`) sends a
   `kind: "join_response"` envelope of `subkind: "invitation"` to
   `{ kind: "instance", instanceId: A.uuid }`. The payload carries
   `group_id`, manifest fingerprint, and a one-time `invitation_token`
   (random uuid) signed by `X`. The invitation is also written by `X`
   to `groups/<id>/invitations/<envelope_id>.json` for the admission
   audit.
2. `A` accepts and sends a `kind: "join_request"` envelope into
   `groups/<id>/join_requests/`, carrying the same `invitation_token`
   and `A`'s public key, signed by `A`.
3. Postal delivers the header to admin inboxes. Postal MUST NOT
   inspect the `invitation_token`.
4. The admin importer matches the token against
   `groups/<id>/invitations/<envelope_id>.json`. On match, it writes
   `members/<A.uuid>.json` and replies with `subkind: "accepted"`. On
   mismatch, it writes `subkind: "denied"` with `reason`.

### 10.3 Approval-required groups (`membership_policy: "approval_required"`)

1. `A` sends an unsolicited `kind: "join_request"` envelope (with a
   free-text `motivation`) into `groups/<id>/join_requests/`.
2. Admins receive notification copies in their inboxes.
3. An operator decides; the importer writes `subkind: "accepted"` or
   `subkind: "denied"` accordingly.

Across all three policies, the **importer** writes the
`GroupMemberRecord`. FedEx never does. The importer is the only role
permitted to admit, expel, or revoke membership.

### 10.4 Leaving and being expelled

Both leave and expel emit `kind: "membership_revoke"` envelopes,
distinguished by `payload.subkind`:

- `subkind: "leave"` — member-initiated; the member sends the envelope
  addressed to the group; the importer of each admin removes the
  member record on receipt.
- `subkind: "expel"` — admin-initiated; the admin sends the envelope
  addressed to the group; importers remove the record. The expelled
  participant SHOULD also receive a directed copy.

Sharing one envelope kind keeps the audit log uniform; the `subkind`
discriminant drives the importer code path.

### 10.5 Postal lock and group fan-out

The Postal role uses a single leader lock at
`<federation_root>/postal.lock`. The lock file has the following
shape:

```ts
interface PostalLockFile {
  pid: number;
  hostname: string;
  instance_uuid: string;
  started_at: string;
  heartbeat_at: string;            // refreshed every leader_lock_ttl_ms / 3
  token: string;                   // random per-acquisition nonce
}
```

Stale-lock takeover MUST follow a two-phase compare-and-swap with
random jitter:

1. Detect stale: `heartbeat_at` older than `leader_lock_ttl_ms`.
2. Sleep a random `[0, leader_lock_ttl_ms / 4]`.
3. Re-read; if the heartbeat advanced, the incumbent is alive — abort.
4. Atomically rename a new lock file containing your token into place.
5. Re-read; if the persisted token is not yours, another worker won —
   abort.

This eliminates the double-takeover window on shared filesystems with
last-writer-wins semantics.

The leader, once acquired, MUST scan **every** active participant's
`outbox/pending/` plus every `groups/<id>/outgoing/` it has read
access to. A leader that scans only its own host's outbox starves
other participants and is non-conformant.

---

## 11. Billboard

The billboard is an append-only public feed. Anyone with read access
to the federation root MAY publish to it; anyone MAY pull from it.

### 11.1 Layout

```
billboard/
  index.jsonl                  one line per envelope, in publish order
  <yyyy-mm>/<content_hash>.json
  .archive/                    GC'd entries
```

Each line of `index.jsonl` is a JSON object with at minimum:

```ts
interface BillboardIndexLine {
  envelope_id: string;
  content_hash: string;
  created_at: string;
  kind: FederationEnvelopeKind;
  from_groups?: string[];      // for filter convenience
  byte_offset: number;         // self-referential; equals the file offset of this line
  archive_path: string;        // "<yyyy-mm>/<content_hash>.json"
}
```

The `byte_offset` of each line MUST equal that line's start offset in
the file. This makes byte-offset watermarks self-validating across
truncation/rebuild.

### 11.2 Watermark

A puller's authoritative watermark is `pull_since.offset`. The puller
tails from that offset. `last_created_at` is informational and MAY be
used for human display or recovery.

### 11.3 Garbage collection

Billboard GC is implementation-defined under the constraint of
`FedExConfig.billboard.retention_days` and `max_items`. GC MUST move
expired entries to `billboard/.archive/` rather than deleting them
in place, and MUST NOT remove an entry that any active puller's
watermark has not yet passed.

GC SHOULD be performed by a scheduled maintenance task, not solely by
operator command. An implementation that requires manual GC for
correct long-term operation is non-conformant.

---

## 12. Anonymization

The `anonymize` flag on outbound configuration produces
**low-correlation pseudonymous** envelopes, **not strong anonymity**.
An attacker observing many drops can correlate them through
`content_hash` collisions, payload fingerprints, archetype patterns,
and timing.

When a participant produces an envelope with anonymize on, FedEx MUST:

1. Set `payload.anonymized = true`.
2. Replace `envelope.from_instance` with the sentinel
   `"anon:" + lowercase_hex(sha256(instance_uuid + envelope_id)).slice(0, 16)`.
3. Strip `payload.notes` if present.
4. Omit `signature` (signing with the real key would defeat the
   purpose).

Anonymize MUST be rejected for `to.kind === "instance"` and
`to.kind === "group"`. Anonymous direct mail bypasses trust and is
unsupported. Anonymize is valid only for `billboard` (and, as an
out-of-network artefact, for `raw_export`).

A receiving participant accepts an unsigned anonymized envelope only
when its `delivery.accept_unsigned_anonymous` is `true`.

---

## 13. Idempotency and dedup

### 13.1 `idempotency_key`

```
idempotency_key =
  lowercase_hex(sha256(canonical_json({
    kind:          envelope.kind,
    from_instance: envelope.from_instance,    // uuid OR "anon:<hex>"
    to:            normalize(envelope.to),
    content_hash:  envelope.content_hash,
  }))).slice(0, 32)
```

`normalize(to)` strips optional/derived fields:

- `{ kind: "billboard" }` → `{ kind: "billboard" }`
- `{ kind: "group", groupId }` → `{ kind, groupId }`
- `{ kind: "instance", instanceId }` → `{ kind, instanceId }`

`raw_export` does not appear on the wire and has no idempotency key.

`created_at` is **deliberately excluded** from the key so retries
collapse onto the original delivery. Callers needing to send the same
`(kind, to, payload)` twice as distinct events MUST vary the payload
(e.g. include a sequence number) so `content_hash` changes.

Anonymized billboard retries do not collapse, because each retry's
`from_instance` sentinel re-rolls. This is intentional: an anonymized
sender has explicitly asked the system not to be linkable across
drops.

### 13.2 Two dedup layers

Implementations MUST implement two independent dedup layers and MUST
NOT collapse them:

- **Routing dedup** (Postal and Billboard Puller): a small bounded LRU
  of seen `idempotency_key` values per recipient (Postal) or per
  puller (Billboard). A re-shipped envelope is a no-op duplicate.
- **Ingestion dedup** (Importer): per `content_hash` against the
  participant's local validated set. Prevents duplicate cognition
  imports even when routing layer dedup is bypassed (e.g. anonymized
  billboard retries).

---

## 14. Conflict policies

`ConflictPolicy` values:

- `content_hash_dedup` — if the recipient already has the envelope's
  `idempotency_key` or `content_hash`, skip delivery and audit as
  duplicate; otherwise deliver.
- `queue_for_triage` — deliver into `inbox_pending/<envelope_id>/`
  even if `inbox_mode === "auto_accept"`. The verdict file is absent
  until operator review.
- `last_write_wins` — normal delivery when there is no duplicate;
  never overwrite previously accepted state in place. Import-side
  merge semantics decide final cognition state.

The policy in effect for a delivery is, in order:
1. The group manifest's `conflict_policy`, if the envelope's `to.kind ===
   "group"` and the manifest provides one.
2. `FedExConfig.conflict_policy.by_group[groupId]`, if present.
3. `FedExConfig.conflict_policy.default`.

---

## 15. Audit and notifications

Every delivered envelope MUST leave at least one durable audit entry
on disk:

- The envelope file itself, written into `inbox/`, then moved to
  `inbox_pending/`, `accepted/`, or `rejected/` depending on outcome.
- A line appended to `inbox/.notifications.jsonl` for each delivery.
  Implementations MUST treat `.notifications.jsonl` as append-only;
  rotation is permitted and MUST preserve historical lines in a
  retrievable archive.
- For group sources, a line appended to
  `groups/<group_id>/postal_log.jsonl`.

Notification line shape (informative):

```ts
interface NotificationLine {
  delivered_at: string;
  envelope_id: string;
  idempotency_key: string;
  kind: FederationEnvelopeKind;
  from_instance: string;
  source: { kind: "instance" | "group" | "billboard"; id?: string };
}
```

---

## 16. Error reasons

The following error reasons appear in `*.error.txt` sidecars and
audit lines. Implementations MUST use these spellings exactly when
the listed condition applies, and MAY add implementation-specific
reasons not in this list provided they are namespaced
(`<vendor>:<reason>`):

| Reason                    | Raised by         | Meaning                                                         |
|---------------------------|-------------------|-----------------------------------------------------------------|
| `unknown_instance`        | Postal            | `to.instanceId` has no registry entry.                          |
| `not_a_member`            | Postal            | Group source whose sender lacks a valid `GroupMemberRecord`.    |
| `unauthorized_member`     | Postal            | Member record signature does not verify.                        |
| `blocked_by_recipient`    | Postal            | Sender is in recipient's `delivery.blocked_instances`. Not delivered. |
| `bad_signature`           | Importer          | Envelope `signature` failed verification.                       |
| `unknown_sender`          | Importer          | Sender identifier not in registry and not pinned.               |
| `payload_too_large`       | FedEx             | Outbound payload exceeds `max_payload_bytes`.                   |
| `size_mismatch`           | Postal / Importer | Header `payload_bytes` differs from observed payload size.      |
| `clock_skew`              | Importer          | `created_at` is more than `reject_clock_skew_seconds` in future.|
| `policy_rejected`         | Importer          | Delivery policy rejected (sender/kind/group).                   |
| `content_hash_duplicate`  | Postal / Importer | Dedup hit at the corresponding layer.                           |

---

## 17. Registries

Implementations MUST treat the following enumerations as **closed** in
v1.0. A new value requires a Protocol minor version bump and a
registry entry in this section.

### 17.1 `FederationEnvelopeKind`

| Kind                  | Direction        | Notes                                                                |
|-----------------------|------------------|----------------------------------------------------------------------|
| `archetype_share`     | any              | Carries `ArchetypeSharePayload` (§17.4).                             |
| `join_request`        | non-member → group | Routed via `groups/<id>/join_requests/`. Membership not required.  |
| `join_response`       | admin → instance | `subkind` distinguishes invitation / accepted / denied.              |
| `announcement`        | any              | Free-form; importer-defined effects.                                 |
| `ack`                 | any              | Acknowledges another envelope by id.                                 |
| `membership_revoke`   | member or admin → group | `subkind: "leave" | "expel"`.                                  |

### 17.2 `payload_schema_version` namespace

`payload.payload_schema_version` is independent of
`envelope.schema_version`. The envelope schema is v1.0.0 of this
specification. Payload schemas evolve per `kind`:

- `archetype_share` payload: starts at `2.0.0` (v1.x of the inline
  bundle format remains importer-readable for back-compat per §9.4).

### 17.3 `ArchetypeSharePayload`

```ts
interface ArchetypeSharePayload {
  payload_schema_version: "2.0.0";
  anonymized: boolean;
  archetypes: SharedArchetype[];
  notes?: string;
}

interface SharedArchetype {
  id: string;
  pattern_type: PatternType;             // §17.4
  description: string;
  entity_roles: EntityRole[];            // §17.4
  relation_pattern: string;
  confidence: number;
  times_validated: number;
  created_at: string;
}
```

`SharedArchetype` MUST NOT include a `source_instance` field; the
envelope's `from_instance` is the single source of truth.

### 17.4 Archetype role and pattern enumerations

Both lists are **closed** in v1.0. Adding a value is a
`payload_schema_version` bump.

`EntityRole`:

```
auth_component       api_endpoint        data_entity
workflow_entity      financial_component notification_component
admin_component      discovery_component system_component
```

`PatternType`:

```
security_pattern        structural_gap          cross_domain_bridge
tension_resolution      symmetry_pattern        reinforcement_pattern
causal_pattern          generic_connection
```

The mapping from raw entity ids and relation strings to these
enumerations is the **anonymization contract**, which is normative for
implementations that emit `archetype_share` payloads:

**Relation → pattern\_type** (first match wins, lowercase substring of
the relation string):

| Substring                    | Result                  |
|------------------------------|-------------------------|
| `security`, `rls`, `auth`    | `security_pattern`      |
| `missing`, `gap`             | `structural_gap`        |
| `cross_domain`, `bridge`     | `cross_domain_bridge`   |
| `tension`, `resolution`      | `tension_resolution`    |
| `symmetry`, `reverse`        | `symmetry_pattern`      |
| `strengthen`, `reinforce`    | `reinforcement_pattern` |
| `causal`                     | `causal_pattern`        |
| (else)                       | `generic_connection`    |

**Entity id → role** (first match wins, lowercase substring of the
entity id):

| Substring                              | Result                    |
|----------------------------------------|---------------------------|
| `auth`, `login`, `jwt`                 | `auth_component`          |
| `api`, `route`, `endpoint`             | `api_endpoint`            |
| `table`, `schema`, `model`             | `data_entity`             |
| `workflow`, `process`, `flow`          | `workflow_entity`         |
| `payment`, `billing`, `invoice`        | `financial_component`     |
| `email`, `notification`, `alert`       | `notification_component`  |
| `admin`, `dashboard`                   | `admin_component`         |
| `search`, `catalog`, `browse`          | `discovery_component`     |
| (else)                                 | `system_component`        |

**Relation pattern abstraction.** Apply the regex
`/[a-z]+_[a-z0-9]+(?:_[a-z0-9]+)*/g` to the relation string. If a
matched token splits on `_` into more than three parts, replace it
with the first two parts joined by `_` followed by `_*`
(`user_auth_login_attempt` → `user_auth_*`). Otherwise the token is
kept verbatim.

**Per-archetype dedup.** After mapping all edges, dedupe by the
composite key `${pattern_type}:${relation_pattern}`. First occurrence
wins.

**Description scrubbing is NOT performed** in v1. `description`
forwards verbatim. This is an intentional pseudonymity caveat.

---

## 18. Security and privacy considerations

### 18.1 Threat model

The protocol assumes a shared filesystem under cooperative-but-not-
trusted ownership. An adversarial filesystem can:

- Read every envelope ever written.
- Withhold or reorder file appearances.
- Forge files, including signatures from keys it has stolen.

The protocol does not protect against:

- A compromised host's private key. Loss or theft requires key
  rotation (§7.4).
- Traffic analysis. An adversary observing the federation root sees
  who sent how many envelopes, when, and to which group.
- Strong anonymity. See §12.

The protocol does protect against:

- Unauthorised group sends (signature + member record check).
- Unauthorised group admission (admin signature on member records).
- Replay (idempotency + dedup).
- Silent payload tampering (`content_hash`, signature).

### 18.2 Key management

- Private keys MUST NOT be transferred between hosts by the protocol.
- Operators are responsible for backing up `keys/`. Loss of the
  private key permanently invalidates the participant's group
  memberships.

### 18.3 Anonymization caveats

`payload.anonymized = true` is pseudonymity, not anonymity. See §12.
Implementations SHOULD warn operators when enabling
`outbound.anonymize` that:

- `description` fields are forwarded verbatim;
- `content_hash` permits cross-drop correlation;
- the sentinel format is publicly known and does not provide
  unlinkability across content-equivalent drops.

### 18.4 Postal payload opacity

The Postal role's prohibition on payload inspection (§5.2) is a
defense-in-depth property, not merely a code-organisation rule. A
Postal implementation that opens payloads can be tricked into
applying delivery policy on attacker-controlled fields. Conformance
test suites SHOULD verify this prohibition by feeding the Postal role
malformed payloads and confirming that delivery decisions do not
change.

---

## 19. Conformance levels

A claim of conformance to `dg-fpo/1.0` MUST identify a level:

- **Level 1 — Receive-only.** Implements Importer and Billboard Puller
  roles. Does not produce envelopes. Useful for read-only observers.
- **Level 2 — Send-and-receive (no groups).** Adds FedEx for
  `instance` and `billboard` destinations. Does not implement group
  membership.
- **Level 3 — Full participant.** Adds Postal, group membership,
  invitation/admission, and `membership_revoke`. Implements §10 in
  full.

Conformance at any level requires:

- Exact compliance with §3 actor boundaries.
- Exact compliance with §4 filesystem layout for the parts the level
  exercises.
- Exact compliance with §6 envelope format.
- Exact compliance with §7 cryptography.
- Exact compliance with §13 idempotency.
- Exact compliance with §17 registries (no silent extension of closed
  enums; only the registered values are interoperable).

---

## 20. Open issues / future work

The following are recognised gaps that a future minor or major
revision SHOULD address:

- **Standalone post-office mode.** A future revision MAY define a
  per-host shared post-office process so that N participants on one
  host do not each run their own Postal/Billboard Puller. The
  threshold and trigger are out of scope for v1.
- **HTTP transport.** A future profile MAY define a network transport.
  v1 is filesystem-only.
- **Description scrubbing.** A v2 anonymization profile MAY define a
  registered scrubber for the `description` field.
- **Chunked payloads.** A future profile MAY define multi-envelope
  payloads above the 2 MiB cap.
- **Trust-state-at-admission.** A future profile MAY define an
  alternative member-record verification mode that pins admin/trust
  state at admission time.
- **Key rotation promote.** v1 conformance permits stage-only
  rotation. A future minor revision SHOULD make promote mandatory.
- **Member-record at-admission verification.** See §4.5.

---

## 21. References

- [RFC 2119] Key words for use in RFCs to Indicate Requirement Levels.
- [RFC 8174] Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words.
- [RFC 8032] Edwards-Curve Digital Signature Algorithm (EdDSA).
- [RFC 8259] The JavaScript Object Notation (JSON) Data Interchange Format.

---

## Appendix A — Worked example: archetype share to billboard

A participant `A` (uuid `7f2c…`) wishes to publish a single anonymized
archetype to the billboard.

1. `A`'s FedEx role constructs `ArchetypeSharePayload` with
   `anonymized = true`, `archetypes = [<one>]`, no `notes`.
2. FedEx canonicalises the payload, computes `content_hash`,
   `payload_bytes`.
3. FedEx replaces `from_instance` with
   `"anon:" + sha256(uuid + envelope_id).slice(0,16)`.
4. FedEx computes `idempotency_key` from `(kind, from_instance, to,
   content_hash)`. Note: the anon sentinel is part of the key.
5. FedEx writes
   `<federation_root>/billboard/2026-05/<content_hash>.json` and
   appends a `BillboardIndexLine` to `index.jsonl`.
6. FedEx writes a `ShipmentReceipt` to
   `<participant_root>/outbox/shipped/2026-05/<envelope_id>.json`.
7. Other participants' Billboard Pullers, on their next tick, read
   the new index line, apply their `pull_filter`, and (for those that
   accept) copy the envelope into their local `inbox/`.
8. Recipients with `delivery.accept_unsigned_anonymous = true` allow
   the importer to dispatch by `kind: "archetype_share"` and dedup by
   `content_hash` against the local validated set.

The envelope is unsigned. No Postal participation occurs at any step.

---

## Appendix B — Change log

- **1.0 (draft).** Initial specification, derived from the DreamGraph
  Federation Post Office implementation plan after consistency review.
