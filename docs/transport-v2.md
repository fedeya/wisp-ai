# Wisp transport v2

Wisp v2 combines an independently implemented uplink with a reusable downlink.
The current implementation extends the original v2 framing through the
negotiated `mailboxVersion: 1` capability and optional `compactAck: true` feature.
Capable peers carry response data in the reusable lane and can use bulk files as
optional acceleration. The entire UI stays in the addon, with no visible
transport pixels or capture requirement.
This is different from both the original readiness-only v2 and the earlier
62-byte research receiver.

The reusable response capability has automated coverage using the production
Lua and native API stubs, plus a historical real chat with the bulk cursor
deliberately set beyond the bank. That native test used the earlier JSON-ACK
implementation and delivered the response with zero additional bulk loads.
The current compact ACK, receive cache, state-copy and bulk-policy optimization
is covered by the [reproducible optimization replay](transport-optimization.md).
Its completed controlled native comparisons and natural-exhaustion stress run
are documented separately; the historical chat and readiness-only v2
measurements below do not establish the current optimization's performance.

## Data path

- **WoW to desktop:** 768 enable-state bits carry a 96-byte checked frame with
  80 payload bytes. The native save period remains 40 ms. JSON serialization and
  zlib compression stay at the message boundary; generation, 16-bit wire
  sequence, fragment flags, explicit payload length and CRC32 detect damaged or
  incomplete streams. Existing application message IDs, acknowledgements and
  bounded decoding/retries remain responsible for delivery and duplicate action
  prevention.
- **Desktop to WoW:** a reusable 384-bit lane carries 48-byte checked frames,
  with 32 useful payload bytes per frame. A response message is compressed JSON:
  either a full snapshot or a patch against the exact acknowledged snapshot.
  The host sends one fragment at a time and waits for its transport ACK before
  advancing. A peer advertising `compactAck: true` receives frame kind 4; older
  reusable peers receive kind 2. These frames do not call `LoadAddOn` or consume
  bulk slots.
- **Transport ACKs:** kind-4 responses are acknowledged by a 16-byte kind-3
  frame in the first 128 uplink helpers, `WispAI_S0257` through `WispAI_S0384`.
  It has an empty body, the host generation and downlink sequence, CRC32, and
  flag value `0x01` for resynchronization / `0x02` for bulk availability. A
  successful final ACK confirms application of the active transfer's known
  snapshot, so the host infers that revision instead of sending it back as JSON. Kind-2
  responses keep the earlier 96-byte uplink frame carrying JSON with generation,
  sequence, applied revision, bulk availability and optional resynchronization.
  ACKs do not enter application dispatch or repeat an inspection/action. They
  wait for any current multipart application uplink to finish.
- **Optional bulk acceleration:** the host compares the estimated fragmented
  delivery time with its bulk RTT and a reservation cost for the remaining
  bank. When bulk is selected, it publishes a complete snapshot file, then a
  checked revision notification. The addon loads one fresh helper and
  acknowledges the revision. File publication failure, helper load failure or
  bank exhaustion automatically switches delivery to reusable data frames.
- **Receive scheduling and cache:** active kind-4 receive checks use one exclusive
  50-ms ticker; the older 100/500-ms tickers do not also service that mode. A
  40-ms eligibility guard allows ten milliseconds of frame/timer jitter while
  retaining a nominal maximum of 20 checks/s, not 25. Kind-2 peers retain the
  100-ms schedule. An unchanged frame is
  identified by its header and CRC using 128 enable-state getters, instead of
  rereading all 384 bits. The cache only reuses a previously fully CRC-validated
  frame. A new identity reads and validates the complete frame using 384
  getters. A compact ACK touches only 128 uplink bits, instead of the previous
  768-bit ACK path.
- **While idle:** after a new downlink frame the addon keeps an eight-second ACK
  grace window, longer than the host's five-second restart watchdog. Once other
  work is idle, receive checks back off to 500 ms during that window;
  duplicate ACK retries use 250, 500, 1,000 and then at most 2,000 ms intervals,
  subject to receive scheduling. Duplicate frames do not extend the grace
  window indefinitely. Partial messages keep the receiver waiting. After the
  window, an idle client stops rereading. Opening addon settings pauses both
  transport reads and writes, preserving pending settings edits.
- **Compatibility:** only checked W2 uplink frames can establish a session.
  The earlier unversioned transport and its decoder are removed. The current
  addon requires the native state, JSON, compression and player-identity APIs;
  unavailable APIs produce one diagnostic and no transport writes or tickers.
  Compatibility within Wisp v2 remains: peers without `mailboxVersion: 1` use
  readiness-only v2 and its finite bulk bank. `compactAck` is additive: kind 4
  is selected for capable peers, while kind 2 retains JSON ACKs and its original
  cadence. The active protocol and the flat, LSB-first carrier publisher are
  Wisp implementations. The project remains GPL-3.0-only.

The initial carrier layout uses already installed helper names, not new folders:
uplink `WispAI_S0257` through `WispAI_S1024`; downlink `WispAI_B001` through
`WispAI_B128`, followed by `WispAI_S0001` through `WispAI_S0256`. All 1,024
`WispAI_S` helpers remain available for bulk loading. Loading a helper preserves
its enable state, including when the helper also carries a wire bit.

## State reconstruction and recovery

[`downlink.ts`](../packages/protocol/src/downlink.ts) chooses the smaller
compressed representation: full `{r, s}` or patch `{r, b, p}`. Here `r` is the
new revision, `s` the complete snapshot, `b` the exact base revision and `p` a
bounded operation list. Paths use zero-based array indexes. Operations set a
value (`s`), delete an object field (`d`), truncate an array (`l`) or append a
string suffix (`a`). String appends carry only newly generated response text.

[`Downlink.lua`](../addon/WispAI/Transport/Downlink.lua) reconstructs a separate raw state
before the UI merges optimistic messages. Patches require the exact base
revision and copy only changed ancestor tables into a canonical candidate.
Unchanged branches remain shared with the immutable baseline; the UI receives
one separate mutable projection. A full decoded snapshot needs one defensive
canonical copy. A private projection identity prevents the `ns.Transport.RememberDownlink`
call in `Chat/Snapshot.lua` from making a redundant second copy, while external bulk
snapshots still get their own defensive copy. A candidate commits only after the
snapshot receiver returns successfully with the expected applied revision. Invalid operations or
receiver failures do not confirm a new canonical base.

This reduces redundant copying, not all history-dependent work: producing the
mutable UI projection still traverses the complete state. Per-operation
diagnostics are available in `ns.transportStats.downlinkCopy`.

The transport caps encoded messages at 64 KiB and decoded JSON at 1 MiB, with at
most 4,096 patch operations and 32 path levels.
Unsafe keys, malformed paths and unsupported operations are rejected. CRC32
checks accidental frame corruption; it is not authentication.

The host keeps the active transfer, latest pending publication and acknowledged
base. New publications coalesce without overwriting an unacknowledged fragment.
Only a matching generation/sequence ACK advances the active transfer. Repeated
frames are reacknowledged without reapplying them. A missing/invalid base requests
a complete snapshot; five seconds without progress restarts transmission with a
fresh first fragment. File writes preserve the other lane and unrelated addon
settings, and changed concurrent settings abort a stale replacement.

A host generation change invalidates the patch base and permits a lower revision
counter. The displayed UI remains until the replacement state arrives; retired
generations cannot overwrite the newer state. This is distinct from an addon UI
reload, which starts a new application session.

On UI reload, the addon baselines the physical downlink before its first uplink
and ignores that persisted frame until a fresh publication arrives. Baseline reads
respect the addon-settings pause. A previous turn can still publish while the new
hello is in flight, so a bulk read records the valid snapshot's session before
Core rejects mismatched sessions. Loading such an old snapshot requests a fresh
full state without permanently disabling bulk. A real load failure, invalid data
or an unapplied current-session snapshot still falls back to the reusable lane.
The scoped read outcome is cleared even when loading raises an error.

## Bulk selection and measurement

The earlier fixed 96-byte cutoff has been replaced by
`preferBulkDelivery()` in [`transport.ts`](../apps/bridge/src/transport.ts).
The fragmented estimate is `ceil(preparedBytes / 32) * fragmentRttMs`.
Bulk is selected when its expected time saving pays a reservation cost:

```text
fragmented estimate - bulkRttMs >= 200 + 800 * (1 - slotsRemaining / 1024)^2
```

The host uses an 80/20 EWMA of observed fragment and bulk RTTs. Before samples
exist, fragment RTT defaults to 50 ms for compact peers or 100 ms otherwise,
and bulk RTT defaults to 150 ms. The reservation penalty grows from 200 toward
1,000 ms as the bank becomes scarce. A single-fragment response stays reusable;
an unavailable bank cannot select bulk.

Those penalty constants are a tunable policy, not a proven native optimum.
Preserving slots can increase saves and getter work or slightly delay small
streams. The [optimization replay](transport-optimization.md) records that
tradeoff alongside the gains; its virtual timings cannot establish FPS or
native latency.

[`TransportMetrics.lua`](../addon/WispAI/Transport/TransportMetrics.lua) provides an
opt-in developer profile with frame-time histograms, instrumented transport
operation durations, native API call counts and tagged snapshot-application
checkpoints. Collection starts only when requested. Frame samples describe the
whole game scene during that run; application checkpoints are not visible-row
render times or an isolated bridge CPU measurement. Native comparisons must
hold the scene, game window state and fixture release schedule consistent.

## What improves and what remains finite

The uplink moves 80 rather than 15 payload bytes per native save: a **5.33x
nominal payload capacity** at the same configured timer interval. The practical
gain depends on message boundaries, native-call cost, filesystem contention and
application latency.

The compact peer's 50-ms receive schedule represents 640 payload bytes/s from
`32 / 0.05`, versus 320 bytes/s at the older 100-ms schedule. That is a nominal
read-service budget; the stop-and-wait ACK round trip, native work and file
contention can reduce delivered throughput. It is not a measured native ratio.

Readiness checks, reusable response fragments and ACKs do not consume a bulk
slot. The bulk accelerator still has 1,024 one-use helpers per UI session, but
**a negotiated reusable session continues when that bank is exhausted**. The
addon reports bulk unavailable, suppresses the exhausted-channel UI state, and
receives the same pending response through reusable frames. A `/reload` is no
longer required to replenish channels for those capable peers. Older peers
without the new capability remain finite.

This does not make the bulk mechanism itself unlimited. Large responses that
fall back to a small fragmented lane can be slower than one native file load.
Compression, acknowledged deltas and string suffixes reduce the transferred
volume; they do not remove the carrier's byte-rate or native-call costs.

## Automated coverage for reusable delivery

The focused coverage executes the production Lua with native API stubs, tests
the Node codec and host against real temporary state files, and checks full and
patched state reconstruction, exact acknowledged bases, retransmissions,
resynchronization, generation/sequence changes, optional bulk failures, settings
pauses and coexistence with multipart uplinks. One Lua test applies **1,025
revisions with an already exhausted bank**, using the same helper names and no
`LoadAddOn` calls. These tests establish protocol behavior under the modeled
APIs; they do not establish native frame cost or a long-session live result.

```powershell
pnpm exec vitest run --project protocol --project bridge packages/protocol/tests/downlink.test.ts apps/bridge/tests/transport-v2.test.ts
pnpm exec vitest run --project integration tests/addon/downlink.test.ts
```

Before the current optimization, the addon and core Vitest projects passed:
**68 files, 402 tests** in aggregate
(core: 51 files / 304 tests; addon: 17 files / 98 tests). The historical 375-test
count below belongs to the preceding readiness-only implementation.

The measured optimization passed **69 files / 420 tests** before source cleanup.
The v2-only publication was then checked against the latest main branch:
**332 addon/core tests passed**; 71 packaged-executable tests were skipped because
that optional artifact was not supplied. Workspace typechecks, formatting and lint
passed, as did all 30 offline replay cases with external historical references.
Controlled native trials compare the captured legacy host/addon, pre-optimization
v2 and the final build, with the same immutable payload and synthetic response
fixtures. The reusable-only series takes 42,470 ms versus 54,956 ms before the
optimization, 22.7% less in those runs; this is a host receipt/ACK measurement,
not model inference or rendered-text latency. Native frame observations include
tradeoffs and do not establish a general FPS guarantee. The natural-exhaustion
run confirms 1,025 publications and 1,024 real helper loads before the final
scheduling-only correction. See [the complete evidence and limits](transport-optimization.md).

At closeout, tested source hashes matched the installed host/addon, the service,
game and provider were connected, no turn was active, compact ACKs were enabled,
and transport errors and the opt-in profiler were inactive. The normal original
conversation was restored after the benchmark.

## Historical native validation: reusable response data with JSON ACKs

The deployed host and addon completed a real chat in WoW with optional bulk
loading disabled by **simulating exhaustion**. After recording the actual cursor
of 2, the addon cursor was deliberately set to `ns.slot = 1025`. The UI prompt
`Prueba de transporte: respondé únicamente «Sin reload».` returned `Sin reload`
inside the addon without a UI reload or further `LoadAddOn` calls.

The native diagnostic printed:

```text
WISP PASS 1025 0 13 237 nil nil false
```

This records forced cursor 1025, **zero bulk-load delta**, 13 reusable downlink
messages, 237 downlink frames, unset resynchronization/error counters and an
exhausted UI state of false. The message/frame counts cover the fresh addon
session, including startup and new-conversation revisions; they are not counts
for only the single prompt. The original cursor was restored after the test.

The first-text log at `2026-11-09T02:21:30.749Z` reported 4,611 ms total and
3,714 ms after the Sending phase, implying approximately 897 ms from sending to
acknowledgement. The corresponding host turn record reported 3,774 ms to first
text and 4,287 ms total. These are single-run timings including model work, not
a matched comparison against the previous transport or a general latency
distribution.

The test demonstrates actual reusable response delivery with the bulk path
unavailable on this client. It did **not** consume 1,024 native addon helpers or
run a prolonged native session. The separate 1,025-successive-revision test uses
Fengari and native API stubs; that count must not be attributed to the native
chat experiment.

After recording the result, the original bulk cursor was restored and only the
desktop service was restarted. The existing addon session reconnected without
another UI reload; closeout status reported ready, game connected and zero active
turns. The installed host, codec and addon files matched the tested sources.

## Reproducible offline encoder comparison

From the repository root:

```powershell
node scripts/transport-lab/benchmark-v2.ts
```

The script executes the actual Lua production encoders in Fengari, captures their
native enable/disable state changes at every `SaveAddOns`, and feeds those bytes
to the actual Node decoders. Both versions receive **identical precomputed JSON
and zlib bytes**. Every fixture must reconstruct the exact schema-validated
packet. The baseline is the pre-edit source saved locally at
`runtime/bridge-research/Transport-before-v2.lua`; without that local backup the
script uses `git HEAD:addon/WispAI/Transport/Transport.lua` and labels the fallback in its
output. The JSON includes SHA-256 hashes of both Lua sources.

| Fixture                     | Compressed bytes | Prior frames/saves | v2 frames/saves | Nominal prior/v2 serialization |
| --------------------------- | ---------------- | ------------------ | --------------- | ------------------------------ |
| Short multilingual prompt   | 126              | 9                  | 2               | 360 / 80 ms                    |
| Prompt with bounded context | 405              | 28                 | 6               | 1,120 / 240 ms                 |
| Inspection response         | 3,224            | 216                | 41              | 8,640 / 1,640 ms               |
| Large inspection response   | 12,469           | 832                | 156             | 33,280 / 6,240 ms              |

These fixtures reduce native save calls by **77.8–81.3%**. The script records
enable, disable, state-read, reset and save counts separately. It initializes a
fresh VM/helper bank per fixture; these counts are not a steady-state native
performance profile. In particular, wider frames can increase per-frame work,
and state reads are needed after a reset invalidates the cached helper bits.

The local full result is
`runtime/bridge-research/production-v2-benchmark.json` (ignored by git).
**The milliseconds above are frame count multiplied by the configured 40 ms
period**, not measured wall time in WoW. The client APIs are stubbed, and native
JSON/zlib operations are supplied with matching fixture bytes. This verifies Lua
framing, physical bit mapping, Node decoding, payload equality and save counts;
it does not measure CPU usage, frame time, filesystem behavior, model inference,
first AI text, complete reply latency, or live stability.

## Historical live validation: readiness-only v2

Before reusable response data was integrated, the deployed native host and addon
completed a real readiness-only v2 chat exchange in WoW.
The prompt `Prueba del bridge: respondé únicamente «Bridge propio listo».`
returned `Bridge propio listo` in the addon. Native telemetry reported protocol
2, connected state true, seven bulk loads and zero unchanged loads. At closeout
the host reported ready, the game connected, and zero active turns.

Individual native samples were `sendMs = 13.4081 ms`, `resetMs = 3.1421 ms`, and
reported maximum encoding time `1.2465 ms`. These are individual/latest counters
and an observed maximum, not CPU usage or frame-time distributions.

The host's first-text record at `2026-11-09T01:45:38Z` reported 4,434 ms total
and 3,708 ms after the Sending phase. Their difference implies approximately
726 ms from sending to acknowledgement. This is **one real run including model
inference**, not a matched live comparison against v1. The addon and core Vitest
projects passed at closeout: 66 files, 375 tests, using
`pnpm test:core` and `pnpm test:addon`.

## Outstanding empirical validation

Extend the controlled native replay and four-minute natural-exhaustion stress
test to several-hour real chat sessions and more game conditions. The completed
profiles cover large state changes, accelerated replies, reusable-only replies,
native operation counts and frame-time observations on one machine, with the
addon panel minimized. They do not establish visible-row latency, a general FPS
advantage, behavior under every combat/background workload or prolonged live
stability. Repeat and randomize comparisons before treating single-run latency
differences as a distribution.

Also validate startup before the player GUID becomes available, character/UI
reloads, host restarts, persisted stale frames, addon rollback, dropped fragments,
notification writes lost to a game settings save, and interrupted publications.
Atomic file replacement alone cannot eliminate a race between two writers;
ownership, message sequencing and retry behavior must remain explicit.
