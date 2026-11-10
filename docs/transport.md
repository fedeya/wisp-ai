# Game transport

[Development](development.md) · [Lua guidelines](lua-guidelines.md)

Wisp exchanges checked W2 frames through WoW addon enable states and desktop
state files. The game UI stays inside the addon. Reusable frames carry both
directions; a finite bank of load-on-demand helpers can accelerate large replies.

## Ownership and framing

| Owner                                                  | Source                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| Host scheduling, helper publication and bulk selection | [bridge transport](../apps/bridge/src/transport.ts)          |
| Frame format, CRC32 and bounded message assembly       | [mailbox codec](../packages/protocol/src/mailbox.ts)         |
| Full snapshots, patches and transport acknowledgements | [downlink contract](../packages/protocol/src/downlink.ts)    |
| Native addon reads, writes, queues and retries         | [Lua transport](../addon/WispAI/Transport/Transport.lua)     |
| Canonical state reconstruction                         | [Lua downlink](../addon/WispAI/Transport/Downlink.lua)       |
| Applying received state to conversations and UI        | [snapshot reconciliation](../addon/WispAI/Chat/Snapshot.lua) |

| Direction                          | Frame kind                           | Frame bytes | Payload bytes |
| ---------------------------------- | ------------------------------------ | ----------- | ------------- |
| Addon → host application message   | 1                                    | 96          | 80            |
| Host → addon reusable message      | 2, or 4 with compact ACK negotiation | 48          | 32            |
| Addon → host compact transport ACK | 3                                    | 16          | 0             |

Frames include a generation, 16-bit sequence, fragment flags, explicit payload
length and CRC32. Messages use JSON and zlib compression. Encoded messages are
bounded to 64 KiB and decoded JSON to 1 MiB. CRC32 detects accidental corruption;
it does not authenticate the sender.

The uplink uses `WispAI_S0257` through `WispAI_S1024` (768 bits). The downlink uses
`WispAI_B001` through `WispAI_B128` and `WispAI_S0001` through `WispAI_S0256`
(384 bits). Compact ACKs use the first 128 uplink bits. Carriers are LSB-first;
writes preserve the other lane and unrelated addon settings.

## Delivery and optional bulk

The application uplink ticks every 40 ms. Interactive packets take priority over
unsent background work, polls coalesce, and multipart messages are never
interleaved. Application message IDs and acknowledgements support retries without
repeating actions. Compact transport ACKs wait for an active multipart uplink to
finish and do not enter application dispatch.

Reusable downlink delivery sends one fragment at a time and advances only after
a matching generation/sequence ACK. Negotiation of `mailboxVersion: 1` enables
reusable responses; `compactAck: true` selects kind 4 and an empty kind-3 ACK.
Kind-2 reusable peers use JSON ACKs carrying the applied revision. Compact peers
infer the confirmed revision from the acknowledged transfer.

All 1,024 `WispAI_S` helpers also form the optional bulk bank. A helper can be
loaded once per UI session, preserving its enable state even when it carries a
wire bit. Bulk publication writes a full snapshot and a checked revision
notification. Failed publication, failed loading or bank exhaustion falls back
to reusable frames. Peers without reusable-response negotiation remain limited
by the bulk bank; unsupported native APIs fail with a diagnostic.

`preferBulkDelivery()` compares the fragmented estimate
`ceil(preparedBytes / 32) * fragmentRttMs` with bulk RTT plus a reservation cost:

```text
fragmented estimate - bulkRttMs >= 200 + 800 * (1 - slotsRemaining / 1024)^2
```

RTTs use an 80/20 EWMA. Initial estimates are 50 ms per compact fragment, 100 ms
per kind-2 fragment and 150 ms for bulk. Single-fragment replies stay reusable;
an unavailable bank never selects bulk. These constants are delivery policy,
not a native throughput or latency guarantee.

## State and recovery

The host chooses a compressed full snapshot `{r, s}` or a smaller patch
`{r, b, p}` against the exact acknowledged base revision. Patch paths use
zero-based array indexes; operations set (`s`), delete (`d`), truncate (`l`) or
append a string suffix (`a`). There are at most 4,096 operations and 32 path
levels; unsafe keys and malformed operations are rejected.

The addon keeps canonical state separate from the mutable UI projection. A
patch detaches changed ancestors and commits only after the receiver applies
the expected revision. Invalid patches or receiver failures preserve the old
base and request a complete snapshot. New host publications coalesce without
overwriting an unacknowledged fragment. Duplicate frames are reacknowledged
without being applied twice; five seconds without progress restarts a transfer.

A host generation change invalidates the base and permits a lower revision
counter; retired generations cannot replace newer state. An addon UI reload
starts a new application session and ignores the persisted downlink baseline
until a fresh publication arrives. A stale bulk snapshot from another session
requests fresh state without permanently disabling bulk.

Compact receive checks use one 50-ms ticker with a 40-ms eligibility guard for
timer jitter. An unchanged, previously validated frame needs only its header
and CRC reread; a new identity requires full-frame validation. Idle reads back
off during an eight-second ACK grace window, then stop when no work remains.
Duplicate frames do not extend that window indefinitely. Opening addon settings
pauses transport reads and writes so pending settings edits are preserved.

## Diagnostics and verification

`/wisp diag` reports loaded versions, helper cursor, revision and connection
state. `ns.transportStats` holds operation counters and downlink copy statistics;
the internal transport profiler is opt-in. Receipt/application checkpoints are
distinct from the visible-text timing recorded when an assistant row appears.

The maintained regression suites execute production Lua with explicit native
API mocks and exercise the host against temporary state files:

```sh
pnpm exec vitest run --config packages/protocol/vitest.config.ts packages/protocol/tests/mailbox.test.ts packages/protocol/tests/downlink.test.ts
pnpm exec vitest run --config apps/bridge/vitest.config.ts apps/bridge/tests/transport.test.ts apps/bridge/tests/transport-v2.test.ts
pnpm exec vitest run --config tests/vitest.config.ts tests/addon/
pnpm test:addon
```

Coverage includes full/patch delivery, CRC failures, duplicate ACKs, missing bases,
generation changes, addon reload, bulk failures and exhaustion, settings pauses,
and coexistence with multipart uplinks. These tests validate protocol behavior;
native frame cost and end-to-end latency require measurements in the game.
