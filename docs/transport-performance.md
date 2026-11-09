# Transport performance: observations and hypotheses

Historical comparison of the earlier 62-byte research prototype and the prior
bridge. The current implementation is [Wisp transport v2](transport-v2.md),
with an 80-byte uplink and negotiated `mailboxVersion: 1` response data in a
reusable 32-byte fragment lane. A finite bulk bank is optional acceleration;
capable peers continue through reusable delivery when it is exhausted. One
native chat passed with the bulk cursor forced beyond the bank and zero further
bulk loads; details and scope are recorded in the v2 document. The scenarios
below remain research records, not the current v2 specification or performance
measurements.

This comparison follows [the live transport research](transport-research.md).
The product keeps its chat UI in the addon and excludes visible transport pixels
and required window-mode changes. Mechanism and code provenance are separate:
independent code can implement file loading, reusable state mailboxes, or both.

Reproduce the arithmetic without touching WoW:

```powershell
node scripts/transport-lab/estimate.ts
```

The script reads framing constants from the current source, imports research
wire constants, and optionally reads local measurement reports. It prints JSON
only. Bytes below mean prepared transport-body bytes, not typed characters.
Compression changes the byte count, not the carrier's physical byte rate.

## Facts and measurements

| Item                                           | Evidence                                                                                                              | Meaning                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Current WoW-to-app uplink                      | `Transport.lua`: 128 bits, 1-byte frame header, 15 payload bytes, 40 ms timer                                         | 375 B/s nominal ceiling before queueing, native/file time, retries and scheduling jitter                 |
| Two previous real current-transport deliveries | Local `runtime/sending-measurement.json`: 1,092 and 1,436 ms; mean 1,264 ms                                           | Whole send-to-ACK timings for those messages, not a general latency distribution                         |
| Previous payload-only optimization             | Local `runtime/sending-protocol-size.json`: 526 to 270 compressed bytes, 36 to 19 frames                              | Approximately half the volume without changing carriers; nominal serialization fell from 1,440 to 760 ms |
| Current app-to-WoW downlink                    | `DiskTransport.publish()` writes a complete Lua-wrapped JSON snapshot; `receive()` loads it through a fresh helper    | One load can deliver a large snapshot; there is no 15-byte return-path limit                             |
| Current return polling                         | Normally a 500 ms ticker while waiting, a short ACK window, and unchanged-state backoff reaching 8 s                  | Detection latency depends on phase/state; idle clients do not keep loading helpers                       |
| Publication and text projection                | Snapshot publication every 400 ms; ordinary partial text updates throttled at 600 ms, at most eight before completion | A fast carrier alone cannot bypass application scheduling                                                |
| Research mailbox app-to-WoW                    | Live 50 packets, 3,078 B in 2,629 ms; 1,171 B/s; packet RTT median 51 ms, p95 62 ms; no packet retransmissions        | Proven inbound data plus outbound ACKs, not full duplex application performance                          |
| Research receiver work                         | 165 lifetime ticks: mean 7.812 ms, maximum 22.839 ms, including idle before/after transfer                            | Material synchronous work, not CPU utilization, active-only cost, or a measured FPS loss                 |

The current 375 B/s and the research 1,171 B/s refer to **opposite directions**.
Their ratio is not a measured speedup.

## Why the practical designs are attractive

| Design                                                   | Why it can be good                                                                                                                               | Limitation or hypothesis to test                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Current asymmetric transport                             | Compact uplink header; large complete downlink snapshots; low idle receive work; latest state repairs skipped updates; established integration   | Slow small-frame uplink; finite return bank; unchanged-content reads also consume a slot                                          |
| Wider current uplink, same file downlink                 | More bytes per save while preserving the efficient bulk response path. A 512-bit frame with the same 1-byte header carries 63 B rather than 15 B | 1,575 B/s is arithmetic, not measured. More mutations and larger settings files can cost more per save. Slot exhaustion remains   |
| Reusable mailbox, as prototyped                          | Same helpers carry successive packets; generation/sequence and CRC32 support recovery; small updates need no loaded-addon slots                  | Only 62 B per 50 ms cycle; expensive per-packet ACK writes; full application uplink missing; prototype reassembly capped at 8 KiB |
| Larger/adaptive reusable mailbox                         | Larger packets amortize native operations; idle backoff and unchanged-header checks reduce work; deltas avoid repeating entire chats             | Larger banks grow reads/mutations/files; reset cost remains; idle backoff increases unsolicited receive latency                   |
| Invisible hybrid: small data/control mailbox, bulk files | Reusable progress updates plus one file load for large history/UI state; readiness control could avoid empty one-use reads                       | Not implemented or measured; multiple recovery paths; bulk loads still consume slots                                              |

ACK batching requires real flow control: the present sender waits for each ACK
before publishing another fragment. Simply skipping ACKs stalls it. Publishing
ahead without retained window slots or bounded sequence-based replay can
overwrite unread data. Piggybacking helps only when there is opposite traffic.

## WoW to app: same-direction scheduling scenarios

These are ideal serialization budgets including the current uplink's two-byte
body-length prefix, excluding native/file cost, retries, queueing and application
ACK delay. They are not end-to-end latency predictions. Mailbox columns assume
a **future application uplink** with the stated capacity and 50 ms service time;
the current 128-bit return lane only acknowledges.

| Prepared body | Current: 15 B / 40 ms | Wider current: 63 B / 40 ms | Future mailbox: 62 B / 50 ms | Future mailbox: 110 B / 50 ms |
| ------------- | --------------------- | --------------------------- | ---------------------------- | ----------------------------- |
| 64 B          | 200 ms                | 80 ms                       | 100 ms                       | 50 ms                         |
| 270 B         | 760 ms                | 200 ms                      | 250 ms                       | 150 ms                        |
| 1 KiB         | 2,760 ms              | 680 ms                      | 850 ms                       | 500 ms                        |
| 4 KiB         | 10,960 ms             | 2,640 ms                    | 3,350 ms                     | 1,900 ms                      |

The widened-current variant has a nominal 4.2x payload rate with its one-byte
header. This scenario retains old framing to illustrate headroom in the existing
**mechanism**. A new independent codec may use more metadata and achieve less
density. This is not a validated patch or an attribution/license change.

## App to WoW: small updates versus large snapshots

Assume the current file receiver is waiting and checks every 500 ms without
backoff. Uniform arrival phase gives a 250 ms mean residual polling wait. The
file column is **that wait only**, plus unmeasured file/native-load work, not a
measured complete transfer time. Mailbox columns model sequential fragments at
50 ms each, without compression or loss. Payload preparation and application
publication throttles are excluded from every column.

| Prepared response | Current file: assumed mean wait | Prototype mailbox scheduling | Larger mailbox scheduling |
| ----------------- | ------------------------------- | ---------------------------- | ------------------------- |
| 64 B              | 250 ms + load work              | 100 ms                       | 50 ms                     |
| 270 B             | 250 ms + load work              | 250 ms                       | 150 ms                    |
| 1 KiB             | 250 ms + load work              | 850 ms                       | 500 ms                    |
| 4 KiB             | 250 ms + load work              | 3,350 ms                     | 1,900 ms                  |
| 8 KiB             | 250 ms + load work              | 6,650 ms                     | 3,750 ms                  |

For chat-sized snapshots, the file path does not need another load when the
payload doubles; the mailbox fragment count does double. The existing mechanism
can therefore beat the prototype substantially. Under these assumptions the
small-packet advantage changes near a few hundred bytes, not a measured switching
threshold. Backoff, load cost, compression and generation overlap move it.

## Potential mailbox scale and game-thread cost

Holding the same 18-byte data overhead and 20 service cycles/s constant:

| Data helpers | Extra ACK helpers | Data payload | Nominal payload rate             |
| ------------ | ----------------- | ------------ | -------------------------------- |
| 512          | 128               | 46 B         | 920 B/s                          |
| 640          | 128               | 62 B         | 1,240 B/s; live result 1,171 B/s |
| 1,024        | 128               | 110 B        | 2,200 B/s, hypothesis            |
| 2,048        | 128               | 238 B        | 4,760 B/s, hypothesis            |

Those counts provision one data direction plus ACKs, not two independent full
application lanes. New helpers need installation/resource discovery. Maintaining
the service rate with a larger bank is unverified; actual round-trip service
time constrains stop-and-wait throughput as well as the configured timer.

If the observed **lifetime** mean 7.812 ms/tick persisted, frequency changes would
have this arithmetic cost:

| Ticks/s | 62-byte nominal payload rate | Main-thread occupied/blocked time per second | Share of one second |
| ------- | ---------------------------- | -------------------------------------------- | ------------------- |
| 2       | 124 B/s                      | 15.6 ms                                      | 1.6%                |
| 10      | 620 B/s                      | 78.1 ms                                      | 7.8%                |
| 20      | 1,240 B/s                    | 156.2 ms                                     | 15.6%               |
| 40      | 2,480 B/s                    | 312.5 ms                                     | 31.2%               |

This is sensitivity arithmetic, **not measured CPU usage or predicted FPS**.
The lifetime mean mixes idle/transfer; sustained active cost may differ. The
22.839 ms maximum tick is material against a 16.7 ms frame budget at 60 FPS,
but does not establish a particular FPS regression. The current transport also
uses native saves and needs comparable profiling; its cost was not measured.

Reduce work per delivered byte before raising frequency: profile reset/read/
mutation/save separately, inspect an unchanged header before rereading the full
lane, adapt idle/active scheduling, and remove repeated payload. Settings-file
writes can rewrite far more data than the few useful bytes carried by helper
bits; raw SSD bandwidth is not the entire cost.

## Deltas, compression, recovery and model time

A 4 KiB reply emitted in eight 512-byte increments transports 18,432 text bytes
if every cumulative snapshot is sent, versus 4,096 bytes of new text before event
headers: **77.8% fewer bytes**. Transporting every revision through the 62 B/50 ms
mailbox consumes 15.1 s of serial service slots; separate deltas consume 3.6 s.
These are budgets without compression, coalescing or overlap with generation,
not observed reply times.

Complete snapshots have a reliability benefit: the next state repairs skipped
intermediate updates. Deltas require ordering, bounded replay and a complete-state
resynchronization path. Removing snapshots without that recovery trades bandwidth
for broken state. Compression ratios must also be measured by workload; the
current uplink already uses zlib, and tiny packets may grow when compressed.

Inference stays independent. In an illustrative first-text case with model time
held at 5 s, improving uplink from 1.2 to 0.3 s and return delivery from 0.5 to
0.15 s reduces 6.7 to 5.45 s, or 18.7%, despite a 4x uplink change. Conversely,
returning an entire uncompressed 4 KiB snapshot through the prototype can add
seconds. Replay an identical recorded model stream for carrier comparisons,
then validate real chat.

## Other mechanisms

- **Font metrics:** the reference design carries 476 payload bytes and normally
  uses five-second slot windows: approximately 95.2 B/s if one useful fragment
  arrives per window. It limits measurement work to 32 glyphs/frame. These are
  the author's settings, not an inherent font limit or Wisp benchmark. The
  recovered data becomes native text and is not evaluated as Lua. Its tested
  same-process cache still consumes a finite bank; its complete design uses
  outbound pixels. See the author's [architecture](https://github.com/0xinuarashi/wow-forever-codex/blob/main/docs/architecture.md)
  and [cache experiment](https://github.com/0xinuarashi/wow-forever-codex/blob/main/docs/font-recycling.md).
- **Pixels, reference only; excluded from Wisp:** they carry more bytes/update
  without native settings saves. An illustrative 256 useful RGB pixels at
  3 B/pixel and 20 updates/s represents 15,360 B/s gross before framing, capture
  loss, redundancy and calibration. This is an invented configuration showing
  capacity, not a benchmark. Capture/scaling and GPU/CPU cost still matter.
  [LibSerpix's specification](https://github.com/alex-berliner/LibSerpix) describes
  outbound-only RGB encoding. Visible transport marks exclude it and any
  pixel/mailbox hybrid from product candidates.
- **Logs:** a callable append API with a timely external disk sink could reduce
  bit mutations and write amplification. Live probes did not establish that
  sink. There is no defensible practical rate or latency projection yet.
- **Local HTTP/socket:** would be another class of carrier if the client exposed
  it to this addon. Research found no accessible general channel; the tested URL
  texture route was blocked. An unavailable path has no useful Wisp rate estimate.

## Selection hypothesis

A wider uplink plus the existing bulk-file return deserves a benchmark alongside
the reusable mailbox. For sessions without consumed return slots, an adaptive
mailbox carrying compressed deltas is the strongest demonstrated starting
mechanism, but needs full application duplex semantics and acceptable frame cost.

An **invisible adaptive hybrid** is a credible third candidate: reusable small
updates/control, owned bulk files for infrequent large state. It may preserve
both small-update latency and the existing bulk advantage, with more complexity
and a finite bulk budget. At 4/10/20 bulk loads per turn, 1,024 slots cover
256/102/51 complete turns respectively. These are scenarios, not exhaustion
measurements.

Compare warmed small prompts, first deltas, long replies, large UI/history,
repeated inspections, startup/reconnect and idle on the same machine. Record
queue/send/first text/final text, bytes and saves/resets per turn, and frame-time
distributions. The current carrier is a real competitor, not an inferior design
assumed before measurement.
