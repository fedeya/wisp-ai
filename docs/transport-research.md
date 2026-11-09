# Reusable transport research

The unversioned transport was retired after the controlled comparisons. The
current checkout contains the Wisp v2 codec and carrier publisher; historical
comparison code is supplied as an external reference, not shipped in the app.

Historical research for the initial 62-byte mailbox prototype. The implemented
successor is [Wisp transport v2](transport-v2.md), with an 80-byte uplink and
negotiated `mailboxVersion: 1` response data through reusable 32-byte fragments.
Bulk files are optional acceleration, with automatic reusable continuation on
exhaustion or failure. One native chat passed with simulated bank exhaustion and
zero further bulk loads; the v2 document records that test separately from its
1,025-revision stubbed test. The prototype measurements below do not describe
the current v2 data path or establish its native performance.

Research date: 2026-11-08, America/Argentina/Buenos_Aires. The live result is
timestamped 2026-11-09T00:37:04.245Z. Client: WoW Forever 1.60.1, build 70862,
interface 16001. Product constraints: the entire chat interface stays in the
addon; no visible transport pixels and no required change to the game's window
mode.

For the subsequent workload comparison and quantitative scheduling hypotheses,
see [transport performance](transport-performance.md). That analysis treats the
current bulk-file return path as a competitor, rather than assuming the reusable
mailbox wins every workload.

## Decision

Develop an independently implemented, reusable **addon enable-state mailbox** as
the replacement candidate. A running addon can call `C_AddOns.ResetAddOns()` and
observe externally changed helper enable states without loading those helpers.
The same fixed bank can carry successive packets instead of consuming one
`LoadAddOn` slot per publication.

This is a live-tested mechanism, not a completed production replacement. The
current 20 Hz diagnostic is unsuitable as an always-on default until its frame
cost is reduced. Keep the existing transport available until the new one passes
the production criteria below. No result establishes the fastest possible
transport across every client, machine, or workload.

## Live evidence

First, changing one existing helper's state on disk and calling `ResetAddOns`
changed its reported enable state from 2 to 0 in the running client. The helper
was restored. Next, the isolated receiver in
[`scripts/transport-lab/addon.lua`](../scripts/transport-lab/addon.lua) read repeated
publications from a **timer**, rendered text using a native WoW font string, and
returned sequence acknowledgements through `SaveAddOns`.

The production desktop bridge was stopped with no active turns. The production
addon was disabled and the UI reloaded before the successful run; it was enabled
and reloaded afterward. The normal desktop bridge was restarted and its UI showed
the game, provider, and service connected. There was no reload or hardware event
between packets during the transfer.

| Measurement                                 | Isolated live result                          |
| ------------------------------------------- | --------------------------------------------- |
| Application data direction                  | Desktop to WoW                                |
| Return direction tested                     | WoW to desktop acknowledgements               |
| Data bits / ACK bits                        | 640 / 128, fixed reusable helpers             |
| Maximum payload per data packet             | 62 bytes                                      |
| Timer interval                              | 50 ms                                         |
| Accepted and acknowledged packets           | 50                                            |
| Payload transferred                         | 3,078 bytes                                   |
| Transfer elapsed time                       | 2,629 ms                                      |
| Observed payload throughput                 | 1,171 bytes/s                                 |
| Round trip minimum / median / p95 / maximum | 45 / 51 / 62 / 63 ms                          |
| Packet retransmissions                      | 0                                             |
| Transient Windows file-operation retries    | 28                                            |
| Helpers restored                            | Yes, verified from the discovered state files |
| Receiver ticks over its complete lifetime   | 165                                           |
| Mean / maximum receiver tick work           | 7.812 / 22.839 ms                             |

The tick timing includes reset, state reads, validation, processing, and any ACK
write/save. It is neither a frame-time distribution nor a measurement of one
isolated API. Its mean includes waiting before the sender starts and the stop
delay. At 20 ticks/s, this amount of synchronous work is material. The native
panel originally labeled it `mean API`; the source now calls it `mean tick`.

The machine-readable successful report is local and ignored by git:
`runtime/bridge-research/reusable-results.json`. No model inference was invoked.
These numbers do **not** measure time to first AI text, production chat latency,
arbitrary application data in the return direction, combat, minimized-window
behavior, or a long soak test.

Two earlier runs shared helper states with the running production transport and
failed with file contention or corrupted packets. Isolation removed those
failures in the successful run. The mailbox must have exclusive ownership of its
helper bank; the diagnostic now rejects state files where `WispAI` is enabled.
That disk check does not prove the addon has been unloaded: a UI reload is still
required when disabling it for the experiment.

## Candidate comparison

Candidates include reusable addon APIs, asset-based inbound channels, and
optical/native alternatives. Compatibility of the mailbox is established by
the live client test; source references for other candidates are listed below.

| Mechanism                                     | Finding                                                                                                                                                                          | Disposition                                                                                                                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing `LoadAddOn` reply files              | One publication consumes a previously unloaded helper. The current bank is finite between UI reloads. Large payloads fit in one file.                                            | Retain during migration; replace as the normal inbound channel.                                                                                                                                                                  |
| `ResetAddOns` plus helper enable states       | The same bank carried all 50 packets in the running client, with zero helper loads.                                                                                              | Preferred candidate; reduce synchronous work and complete duplex semantics.                                                                                                                                                      |
| Font metrics as inbound bytes                 | The author's live records show stale bytes when reusing a font path within one process, with successful reuse only after a full client restart.                                  | Does not solve same-session recycling. See [font experiment](https://github.com/0xinuarashi/wow-forever-codex/blob/main/docs/font-recycling.md).                                                                                 |
| Pixels plus Windows capture as outbound bytes | An implemented outbound carrier, not an inbound channel. Requires capture and visible transport marks. Microsoft's HWND sample explicitly excludes capture of minimized windows. | Excluded by the requirement for invisible transport, including a mailbox/pixel hybrid. See [Microsoft sample](https://github.com/microsoft/Windows.UI.Composition-Win32-Samples/blob/master/cpp/ScreenCaptureforHWND/README.md). |
| `C_Texture.SetURLTexture` to localhost        | A live probe produced `ADDON_ACTION_FORBIDDEN`; the local HTTP probe received no request. A successful `pcall` alone was misleading.                                             | Unavailable to this addon in the tested client.                                                                                                                                                                                  |
| `C_UIFileAsset.IsKnownFile`                   | Describes whether the client knows a file, not a fresh readable content channel or reliable filesystem existence probe.                                                          | No demonstrated reusable payload channel. See [exported API](https://github.com/Atraeau/WoW-Addons/blob/main/docs/api/UI-Systems-Input/C_UIFileAsset.md).                                                                        |
| External chat overlay                         | The chat interface must remain inside the addon.                                                                                                                                 | Excluded.                                                                                                                                                                                                                        |

The exported Blizzard addon-list UI uses `SaveAddOns` when saving and
`ResetAddOns` when cancelling. That source supports the existence and normal UI
usage of the APIs; it does **not** document external file rereading as an IPC
contract. Rereading from a timer is our empirical observation on the build above.
See [pinned addon-list source](https://github.com/Gethe/wow-ui-source/blob/70ef1b2fd78061a73f886c4a1e79dc5b5cff6d5e/Interface/AddOns/Blizzard_AddOnList/AddonList.lua).

## Other mechanisms and protocol limits

The **carrier** and the **packet protocol** are separate decisions. Reset/read
of helper states is the candidate carrier. The diagnostic's 80-byte data frame,
18-byte overhead, per-packet ACK, 640/128 lane split, and fixed 50 ms ticker are
experimental protocol/scheduling choices, not proven optima. Compression,
session-scoped metadata, ACK batching/piggybacking, lane sizes, and idle backoff
need controlled comparisons. Reducing header bytes cannot eliminate the native
reset/save cost, so optimize against frame time and application latency rather
than payload density alone.

The known optical alternative serializes addon data into a visible pixel strip;
the author's [LibSerpix implementation](https://github.com/alex-berliner/LibSerpix)
explicitly describes it as outbound only. A mailbox inbound plus pixels outbound
combination also violates the requirement for invisible transport. The research did not
establish that every optical implementation requires borderless window mode;
visible transport marks are sufficient to exclude it.

`C_Log` was also investigated as a potentially cheaper outbound carrier. The
exported [Log API](https://github.com/Gethe/wow-ui-source/blob/297d7aaaa736f346b3e036f38ee088eaf7f8c07f/Interface/AddOns/Blizzard_APIDocumentationGenerated/LogDocumentation.lua)
exposes message, warning, and error functions. The
[Blizzard compatibility wrapper](https://github.com/Gethe/wow-ui-source/blob/11.1.5/Interface/AddOns/Blizzard_Deprecated/Deprecated_11_1_5.lua)
routes the former console-print function through it. Neither source establishes
a usable disk sink with timely flushing for an external reader.

Live probes on the same running client observed:

- `C_Log.LogMessage` exists and accepts a synthetic marker without a Lua error.
- The `consoleLog` CVar lookup returned nil. `developerLog` was 0 and
  `developerLogWriteToFile` was 1.
- A normal-priority marker was emitted from a timer during a five-second
  temporary enable of `developerLog`. A second probe used an error-priority
  marker during a twenty-second enable; the setter returned true and an
  immediate read returned 1.
- Searches of the game's `Logs` tree found no marker in the observations so
  far; `DeveloperLog.log` remained zero bytes. Native API availability and an
  accepted CVar are therefore insufficient evidence for a real-time log carrier.
  Buffering or other sinks remain unestablished. No chat/server messages were
  used as the transport.

Both probes scheduled restoration of the prior `developerLog` setting. A final
in-game read verified `developerLog = 0` and `developerLogWriteToFile = 1`, matching
their original values; a final log-tree search still found no probe marker.
Treat logging as unvalidated rather than a demonstrated replacement for `SaveAddOns`.
The next production candidate remains an owned, invisible mailbox with an
improved protocol and scheduler, subject to the frame-cost criteria above.

## Independent diagnostic implementation

The new Lua receiver and TypeScript wire codec do not import the legacy codec
or use its framing. They were written for this experiment. The existing helper
**names and installation** are reused only to make a live test possible without
installing a new bank and restarting the game. The experiment still depends on
those installed helpers; it is not the final independent installer.

Each data frame is 80 bytes: `WR`, version 1, kind/flags, unsigned 32-bit
generation, unsigned 32-bit sequence, unsigned 16-bit payload length, payload,
zero padding, and CRC32. Acknowledgements are 16 bytes with the same magic,
version, generation, sequence, and their own CRC32. All multibyte integers are
big endian; each helper stores one bit, least significant bit first within a
byte. CRC32 detects accidental corruption; it is not authentication.

The receiver rejects corrupt frames and sequence gaps, deduplicates a repeated
sequence, republishes a lost acknowledgement, and joins bounded fragments before
displaying them. Incoming bytes are data and are never evaluated as Lua. The
desktop sender atomically replaces its lane while preserving the other lane and
unrelated lines. Both sides still write the same physical file, so CRCs, bounded
retries, and explicit ownership remain necessary; atomic replacement alone does
not prevent lost updates.

The diagnostic sends synthetic text only. It auto-restores the original helper
states after its stop packet or a 90-second watchdog. Reading and restoration
pause while the addon settings panel is open, so pending user edits are not
discarded. An open settings panel can therefore delay the watchdog cleanup.

Four automated tests check the state-file codec and execute the actual Lua source using Fengari for
interoperability with Node CRC32, repeated packets, gap/corruption rejection,
lost ACK recovery, fragmentation, restoration, and preservation of unrelated
state-file lines. These stubs complement the live test; they cannot establish
the client's native file behavior.

## Production implementation criteria

1. Install an owned helper namespace and have one transport own it. Remove the
   one-use bank from the normal data path. Select the active character explicitly
   instead of publishing test data to every discovered historical character file.
2. Carry application messages in both directions with independent sequence
   spaces, acknowledgements, restart generations, bounded queues, and bounded
   reassembly. Preserve existing `C.Send` and packet-dispatch contracts. The
   current 128-bit return lane only acknowledges and must be redesigned to carry
   application payloads. Do not describe the prototype as full duplex chat.
3. Profile reset, reads, mutations, and save separately. Back off while idle,
   wake promptly on local sends, batch data and acknowledgements, and test lane
   sizes against frame cost. Measure receive latency during idle backoff as well
   as throughput under load. The measured 20 Hz loop is an experiment setting.
4. Stream bounded reply deltas and prioritize user messages over telemetry.
   Benchmark compressed application payloads in each direction. The current
   legacy uplink's nominal 15 bytes/40 ms (375 bytes/s) is a different direction
   from this live data test and cannot establish a direct speedup ratio.
5. Test restart/lost-write recovery, character switches, UI reloads, settings
   changes, background/minimized windows, combat, and sustained transfers. Measure
   frame-time percentiles and end-to-end user send/first text/final text timings
   against production on the same machine. Fall back on failed capability checks.
6. Retire the legacy implementation only after that comparison. Keep the current
   `NOTICE` and license attribution while derived code remains. Replacing a
   transport file does not establish that the entire repository is independent
   of upstream code or change its license automatically.

## Reproduce the isolated experiment

This is a developer diagnostic, not an addon installation or a production mode.
It writes the mailbox lanes in the existing `AddOns.txt` files discovered under
the configured WoW account directory. It requires the existing 768 helper names.

1. Stop the desktop bridge when no turn is active. Disable `WispAI`, save addon
   settings, and reload the UI. Close the addon settings panel.
2. Execute the trusted local `scripts/transport-lab/addon.lua` source in that
   isolated UI. It creates its own temporary native panel and starts a 90-second
   watchdog. Do not add this file to the production TOC.
3. From the repository root, while the receiver is running:

   ```powershell
   node scripts/transport-lab/run.ts --live
   ```

4. Check all packets acknowledged, `restored: true`, and the native panel's
   stopped/restored status. On failure, stop `WispTransportLab` in game or let its
   watchdog finish before restarting production. Each run retains a uniquely
   named original-lane snapshot under `runtime/bridge-research`; failures retain
   a separate diagnostic report. Do not restore the entire settings file from an
   old snapshot over unrelated user changes.
5. Enable `WispAI`, save, reload, and restart the normal desktop bridge. Verify
   the game connection in Wisp.

Offline checks:

```powershell
pnpm exec vitest run --project addon addon/tests/reusable-mailbox.test.ts
pnpm exec tsc --noEmit --project scripts/tsconfig.json
pnpm exec oxlint --deny-warnings scripts/transport-lab addon/tests/reusable-mailbox.test.ts
```
