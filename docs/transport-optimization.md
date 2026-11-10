# Reproducible transport optimization replay

The comparison has three explicitly named references:

- **Legacy reference:** the pre-v2 bridge captured locally before the v2 work.
  It is an external historical input, not a transport included in this checkout.
- **Pre-opt:** Wisp v2 with reusable response data, JSON ACKs and the original
  96-byte bulk cutoff, captured before the current optimization.
- **Optimized:** the current production sources with negotiated 16-byte ACKs,
  a header cache, a faster bounded receive schedule, copy-on-write patch state,
  and the measured-RTT/bank-cost bulk policy.

Negotiated compact mode now uses one exclusive 50-ms receive ticker; the older
100/500-ms tickers do not also service that mode. A 40-ms eligibility guard
provides ten milliseconds of timer/frame-jitter tolerance, avoiding missed
50-ms opportunities. This does **not** make it a 40-ms or 25-Hz receiver: the
single 50-ms ticker still bounds polling at 20 Hz, and its 32-byte payload has
a 640-B/s nominal service ceiling before ACK, filesystem and native costs.

The response fixtures are deterministic synthetic data. No model calls, game
actions, external messages or provider data are used. Sending the same generated
text on the same release schedule separates transport behavior from inference.

The unversioned codec has since been removed from the application and its
shared carrier publisher replaced with a Wisp-specific implementation. Historical
comparisons load the old codec only from an external reference snapshot. The
recorded native timings below precede that source cleanup; they establish the
measured wire design, not a new timing sample of the replacement publisher.

## Offline replay

```powershell
node scripts/transport-lab/optimize-replay.ts
```

The script executes the production Lua Core, state reconstruction and transport
modules in Fengari. JSON/zlib bytes, CRCs, native helper bit mapping and Node
decoding are real; game APIs, timers and file publications are modeled. The
clock has **zero native, filesystem and model cost**. First/final text timings
refer to applying a state, not displaying a row or measuring real latency/FPS.
The stop-and-wait/publication coordinator is emulated; the optimized path calls
the production bulk-selection function and uses its 80/20 RTT EWMA.

An identical history is seeded through one bulk load before counters start.
Then the same prepared publications are released relative to each decoded user
request. A slower transport can coalesce more intermediate revisions, just as
the host does. Complete final state must still arrive. The legacy no-bulk case
is a blocked outcome, not a timing sample.

The local report is `runtime/bridge-research/optimization-replay.json`. It records
SHA-256 hashes of the Lua source files and fixtures. Reference inputs live in
the ignored local research backups; they must be provided when reproducing on
another checkout. `--reference-dir=...` selects the pre-optimization snapshots.
The legacy Lua reference is
`runtime/bridge-research/Transport-before-v2.lua`.

Historical modes also require the original protocol module, supplied separately
with `--reference-protocol=FILE`. The default reference location is
`runtime/bridge-research/deploy-before-v2-20261108_224025/protocol.js`.
The report records its path and SHA-256. Dependency resolution creates a derived
module only in ignored `runtime/bridge-research/reference-modules`; the current
application and protocol package contain no historical decoder implementation.

### Reusable path with no bulk slots

These are **virtual service times and modeled native-call counts** from the
recorded replay, not native performance measurements:

| Fixture                         | Pre-opt final applied | Optimized final applied | Getter calls, pre-opt / optimized | Save calls, pre-opt / optimized |
| ------------------------------- | --------------------: | ----------------------: | --------------------------------: | ------------------------------: |
| Short reply                     |              1,180 ms |                  730 ms |                    11,904 / 6,016 |                         13 / 13 |
| Eight-part streamed reply       |              4,480 ms |                2,830 ms |                   49,920 / 27,520 |                         46 / 55 |
| One 2-KiB reply                 |              5,780 ms |                3,030 ms |                   64,896 / 29,568 |                         59 / 59 |
| Stream with 48 history messages |              3,780 ms |                2,480 ms |                   41,856 / 23,936 |                         39 / 48 |

For the large reply, the modeled schedule is 47.6% shorter and getter calls
fall 54.4%, with the same number of saves. This supports the scheduling and
operation-count improvement; it cannot establish the native time/FPS change.

The streamed cases apply more intermediate states after optimization: five
instead of three. That explains why total saves can **increase**, even while
completion is sooner and getter calls fall. Native saves remain material work;
these results must not be described as a universal reduction in CPU or I/O.

With 48 history messages, copied tables per applied state fall from 112 to an
average 62.4. The canonical patch clones only changed branches, while the UI
still receives one isolated mutable projection. The history stays protected
from optimistic UI mutations. Small patches that replace nearly every branch
of a tiny state may not save copies: the short-reply fixture copies 16 tables
in both versions because it inserts messages/benchmark metadata and changes
all five ancestors of the small base. It is a patch, not a full-state fixture.

### Bulk-preservation tradeoff

The twelve-publication `tiny-stream` fixture illustrates the current policy's
cost as well as its benefit:

| Metric                       |  Pre-opt | Optimized |
| ---------------------------- | -------: | --------: |
| Bulk loads                   |       12 |         1 |
| Saves                        |       15 |        49 |
| Getters                      |   20,748 |    26,241 |
| Final state applied, virtual | 3,080 ms |  3,230 ms |

The policy preserves eleven one-use slots but adds 150 ms to the modeled final
receipt, increases saves and increases getters. This is a deliberate bank versus
latency/work tradeoff, **not a win on every metric**. Its native profile should
decide whether to reduce the reservation penalty while slots are plentiful.

For the other bulk-available fixtures, the replay preserves the short/large
reply's 280-ms modeled application time and retains one-file delivery. The
legacy reference uses its original receive/poll scheduler and takes 500 ms in
those fixtures. These are still virtual scheduler results, not live ratios.

## Controlled native replay

The native runner is opt-in. It uses the configured WoW path and starts a
temporary DiskTransport host. Stop the production desktop service first and
install the matching reference Lua transport before each mode. Root operates
the game UI and starts its profiler; the CLI never invokes a model.

```powershell
node scripts/transport-lab/native-replay.ts --live --mode=legacy --scenario=all --base=runtime/bridge-research/deploy-before-opt-20261108-235606/Payload-original.lua --out=runtime/bridge-research/native-legacy.json
node scripts/transport-lab/native-replay.ts --live --mode=pre-opt --scenario=all --base=runtime/bridge-research/deploy-before-opt-20261108-235606/Payload-original.lua --out=runtime/bridge-research/native-pre-opt.json
node scripts/transport-lab/native-replay.ts --live --mode=optimized --scenario=all --base=runtime/bridge-research/deploy-before-opt-20261108-235606/Payload-original.lua --out=runtime/bridge-research/native-optimized.json
```

Use the **same immutable `--base=FILE` JSON-wrapped payload** in every A/B trial.
Without that override, the default base is the currently installed Payload.lua,
which may contain a previous trial's synthetic conversation and would make a
subsequent comparison unfair. The runner reads the override without modifying
it; reports record its path/hash and the separately observed installed payload
hash. The dated path above is the local snapshot captured for this run; provide
the corresponding immutable input when reproducing elsewhere.

The CLI prints `REPLAY_READY`, waits for a fresh addon hello, then waits for
`transport_profile_start` before publishing the fixed fixtures. It preserves
existing conversations and model catalog, adds only a synthetic `Bridge
benchmark` conversation, and clears executable requests and panel/routine
commands. Fixture publication times are identical; the host may coalesce
intermediate states. Each fixture finishes at an acknowledged final revision.
The report bounds application ACK history to 128 sequences.

`--mode=legacy` loads the captured original Node host from
`runtime/bridge-research/deploy-before-v2-20261108_224025/host-transport.ts`;
`--mode=pre-opt` loads `runtime/bridge-research/host-transport-before-opt.ts`.
Their backups stay unchanged. A derived local module rewrites only protocol
module specifiers to source file URLs, then imports the original host logic.
The reports include the original host SHA-256. Optimized mode uses the current
Node host. This avoids accidentally comparing an old addon with a new host's
transport-selection policy.

Native profile records distinguish frame-time histograms, instrumented native
operation durations and snapshot-applied times from host-side receipt/cursor
ACK checkpoints. None should be called visible-text latency without separate
render verification. Profiles should use the same game window state, scene,
foreground/background status and duration. A busy-world A/B run is evidence on
that machine and workload, not a general hardware guarantee.

For the current native A/B runs, the game remains in the same scene and the
**Wisp addon panel is minimized in every mode**. These trials therefore measure
transport/state application and whole-game frame times, not chat-row rendering
or visible-text arrival. The temporary trusted benchmark startup waits for the
initial snapshot to apply, then uses the same ten-second warmup and 60-second
profile in each mode. The initial synthetic chat stays idle during warmup;
fixture playback explicitly changes it to working. Common Core instrumentation
records application work in all three modes; the legacy transport itself is the
captured unmodified reference.

Host publication/ACK timestamps share a Node clock, while addon applied-state
records share the native profile clock. The start-profile packet takes time to
travel between them, so these origins are not synchronized. Do not subtract a
host publication offset from a native applied offset to invent one-way latency.
Compare host checkpoint round trips, frame distributions and call counts; native
first-to-final spans within a fixture are valid same-clock differences. Absolute
applied offsets across the whole fixture series also include time spent in all
previous fixtures and their checkpoints.

## Native comparison with bulk available

The completed local reports are `runtime/bridge-research/native-legacy.json`,
`native-pre-opt.json` and `native-optimized.json`. All three use baseline payload
SHA-256 `a72da1b6733f29fcd5538628aa63810c768900ffe45cabb072f2d99000919cdc`, the
same five fixture definitions and 60-second profiles. Each report ended without
a runner failure or error. Individual publication release times vary by ordinary
timer jitter, generally around the intended 250-ms spacing. The synthetic chat
ID is fixed to `transport-benchmark` in all native modes. Addon sessions are
fresh protocol identities, so native packets are equivalent workload data rather
than byte-identical copies; the offline fixture hash comparison is stricter.

The following **host-clock checkpoint round trips** start when the fixture's
final snapshot is queued for publication and end when the host learns a receipt
cursor/ACK at least as new as that revision. For streams, they measure the tail
after the last source update, not the duration of the whole response and not
the time of a rendered row:

| Fixture             |   Legacy | Pre-opt v2 | Optimized v2 |
| ------------------- | -------: | ---------: | -----------: |
| Short reply         |   699 ms |     111 ms |        92 ms |
| Tiny stream         |   680 ms |     138 ms |        76 ms |
| Eight-part stream   |   692 ms |     155 ms |       108 ms |
| Large reply         |   895 ms |     124 ms |        70 ms |
| Stream with history | 1,723 ms |      63 ms |        77 ms |

The optimized run improves four of these five samples relative to pre-opt;
the history tail is 14 ms slower. There is only one final-build run per mode
here, not a latency distribution. Tagged records count 12 tiny-stream updates
in pre-opt and 11 in optimized, plus all eight updates of each larger stream
in both v2 runs. Legacy has 4, 5 and 5 tagged records respectively. A control
publication can carry equivalent state without the benchmark tag, so tagged
counts alone do not prove missing content or measure additional generated text.

| Whole 60-second native profile | Legacy | Pre-opt v2 | Optimized v2 |
| ------------------------------ | -----: | ---------: | -----------: |
| `SaveAddOns` calls             |    436 |        102 |           99 |
| `LoadAddOn` calls              |     39 |         36 |           37 |
| `ResetAddOns` calls            |      0 |        157 |          225 |
| Whole-game frame p50           |   7 ms |       7 ms |         7 ms |
| Whole-game frame p95           |  23 ms |       9 ms |         9 ms |
| Whole-game frame p99           |  26 ms |      17 ms |        16 ms |
| Maximum observed frame         |  30 ms |      23 ms |        27 ms |

These profiles include ordinary game/background work. A bounded inspection of
the corresponding host profile windows finds the same four routine ticks and
one hello in all modes, while the legacy run also decodes 33 cursor polls.
The entire CLI process lasts longer than the native profile and must not be
used as the call-count denominator. The game world is not a deterministic
render benchmark, so the frame percentiles are **observations, not a guaranteed
FPS speedup or causal estimate**. Earlier optimized results before the final
timer correction, including an unattributed 71-ms maximum, remain archived as
`native-optimized-before-cadence.json`; they are not silently discarded or
treated as repeated samples of the final build.

The native policy used 36 bulk loads in pre-opt and 37 in optimized, unlike the
offline tiny-stream case that traded eleven slots for more mailbox saves. The
measured native RTTs led it to retain bulk acceleration. Optimized mode made
more reset calls in this profile, so the result cannot be summarized as fewer
calls of every kind. The final optimized profile reports a lifetime resync
counter of one and the host process records nine transfer restarts. These lack
event timestamps relative to the profile: the host began publishing about
61 seconds before that window, so this report cannot attribute those counters
to startup or to timed fixtures.

The `apply` duration alone is not an end-to-end CPU comparison: moving canonical
copy work outside Core changes which work falls inside that instrumented region.
`decode_apply` covers the reusable decode/reconstruction transaction where
available, but the captured older transport lacks that instrumentation. Native
fallback comparisons and natural exhaustion are separate trials below.

## Native reusable-path comparison without bulk

The paired no-bulk trials use the same immutable payload and five fixtures as
the bulk-available A/B, with a 120-second native profile in each mode. After the
initial snapshot has applied and the ten-second warmup has elapsed, the trusted
temporary benchmark startup sets `ns.slot = 1025` and `ns.bulkUnavailable = true`
immediately before starting the profile. The start-profile packet advertises
bulk unavailable to the selected host. No data publication in the timed window
may use `LoadAddOn`.

This is a **simulated exhausted-cursor comparison**, used to isolate performance
of the old JSON-ACK reusable path versus the optimized compact-ACK path. It is
separate from the natural 1,024-helper exhaustion test below. Native snapshots
still include the identical preserved conversation/catalog base, so history
seed checkpoints exercise an actual large state change as well as tiny patches.
The addon panel remains minimized, and applied-state timing is not a claim about
visible chat rows. Reports use `native-pre-opt-no-bulk.json` and
`native-optimized-no-bulk.json` under the ignored local research directory.

Both completed reports use the same baseline payload hash and have no runner
failure or errors. Neither profile makes any `LoadAddOn` call; the reported one
total bulk load occurred during initial setup, before the forced cursor and
profile window.

| Final-publication checkpoint  | Pre-opt reusable | Optimized reusable | Observed change |
| ----------------------------- | ---------------: | -----------------: | --------------: |
| Short reply                   |           917 ms |             744 ms |   18.9% shorter |
| Tiny stream                   |           634 ms |             533 ms |   15.9% shorter |
| Eight-part stream             |         2,619 ms |           1,896 ms |   27.6% shorter |
| Large reply                   |         5,893 ms |           4,385 ms |   25.6% shorter |
| Stream with history           |         1,982 ms |           1,720 ms |   13.2% shorter |
| Large history seed checkpoint |        32,480 ms |          23,400 ms |   28.0% shorter |

The history seed is the actual transition to the fixture's 48-message history,
not a text-stream tail. Across the entire series, the single Node-clock interval
from receiving the start-profile packet to acknowledging `replay-finished`
falls from 54,956 to 42,470 ms, **22.7% shorter** in these trials. The native
result therefore supports a meaningful reduction in reusable-path delivery
time, **not the roughly twofold gain of the ideal virtual scheduler**. One
optimized run before the final cadence correction took 44,133 ms; its archived
report is `native-optimized-no-bulk-before-cadence.json`. The final correction
reduces that observed series interval a further 3.8%. All five final-build
fixture checkpoints are shorter than pre-opt. More tagged intermediate states
arrive: tiny-stream counts ten rather than seven, the eight-part stream counts
four rather than three, and the history stream counts three rather than two.

| Whole 120-second native profile | Pre-opt reusable | Optimized reusable |
| ------------------------------- | ---------------: | -----------------: |
| `SaveAddOns` calls              |              690 |                635 |
| `ResetAddOns` calls             |              552 |                848 |
| `LoadAddOn` calls               |                0 |                  0 |
| Whole-game frame p95            |            10 ms |              11 ms |
| Whole-game frame p99            |            18 ms |              17 ms |
| Maximum observed frame          |            27 ms |              27 ms |

The faster receiver makes 53.6% more resets while saves fall 8.0%, even though
more tagged intermediate states arrive. The optimized run's observed p95 frame
time is one millisecond worse and its p99 one millisecond better, with the same
maximum. Background-world noise prevents attributing a causal FPS ratio, but
these values equally prevent a claim that the optimization proved better frame
time or lower CPU in every case. The final optimized host reports no transfer
restarts and the addon reports no resyncs; pre-opt ends with a lifetime resync
counter of one, without a timestamp for the timed window. Both complete without
a runner failure.

## Natural exhaustion stress

Start with a freshly reloaded optimized addon so previous trials have not
already consumed much of the bank. Run a 240-second profile and:

```powershell
node scripts/transport-lab/native-replay.ts --live --mode=optimized --scenario=bulk-stress --count=1025 --timeout-ms=300000 --out=runtime/bridge-research/native-bulk-stress.json
```

Each publication changes a deterministic 2-KiB entropy field ignored by the UI,
large enough to exercise actual bulk selection without rendering huge changing
transcripts. The runner waits for each revision before issuing the next. It does
not change the addon cursor: actual helper loads must exhaust the bank and the
remaining publications must continue through reusable data frames. Setup and
profile-control publications also consume slots if bulk is selected; reports
must record those separately instead of claiming every one of 1,025 fixture
publications was a bulk load.

When the native profile arrives, the runner acknowledges its report, saves a
local JSON result and stops. Restart the production desktop service to republish
authoritative state. The runner never restores an old entire AddOns.txt over
current settings. Natural exhaustion, short controlled replay and several-hour
stability tests are different scopes and must be reported separately.

The completed run is `runtime/bridge-research/native-stress.json`, captured before
the final receive-timer correction and using the same wire/ACK/state protocol
and immutable baseline as the final build. The timer correction did not change
helper allocation or slot handling; this natural-exhaustion run was not repeated
after that scheduling-only change. All **1,025 stress publications were
acknowledged**, with no runner failure or errors. The actual native addon ended
at slot 1,025, reported bulk unavailable and recorded **1,024 total bulk loads**.
The profile itself counts 1,023 loads because one setup load occurred before its
window. This is natural helper-bank exhaustion, not a forced cursor simulation.

The last three accelerated stress checkpoints took 125, 92 and 69 ms; stress
steps 1,024 and 1,025 then completed through the reusable path in 5,045 and
4,927 ms. The test therefore establishes continuation after the real bank is
spent **and also exposes the remaining latency cliff for changed 2-KiB entropy
blocks**. It does not make the mailbox as fast as a bulk file. The host's 1,025
`bulkStarts` count includes a transition attempt; it must not be presented as
1,025 successful one-use loads.

The 240-second profile observed whole-game frame p95 16 ms, p99 20 ms and a
37-ms maximum. The tagged stress states finished applying around 114 seconds
into the profile, leaving a substantial idle portion. These values are not a
like-for-like FPS comparison with the shorter bulk-available profiles. The
recorded lifetime resync counter is one, without an event timestamp. A
four-minute stress profile establishes this bounded workload, not several-hour
stability, every game state, or absence of future errors.
