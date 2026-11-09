# Usage and download metrics

Wisp uses the existing Rybbit site `61b021a9d037` at
https://rybbit.fedeminaya.com. No additional analytics service or secret is bundled.

## Downloads

Every landing, header and setup download link sends `download_clicked` using
Rybbit's existing declarative event handler, with `source` identifying placement.
The tracker is only loaded on production pages. Referrers and campaigns follow
the existing website tracker. These are clicks, not completed downloads.
Direct visits to `/download` and GitHub bypass these click events.

Run `node scripts/download-stats.ts` to read public GitHub installer asset counters
for all releases, including direct GitHub downloads. Downloads include repeats and
updates and are not unique people, completed installs or guaranteed successful transfers.
The script prints a timestamped JSON snapshot; save snapshots if daily deltas are needed.

## Desktop

In a packaged build, statistics are on by default. Disable them at any time in
**Settings → Usage statistics → Share usage statistics**. The opt-out persists across
restarts. Tracking is disabled in development and browser previews. The app sends
explicit HTTP events, without loading Rybbit scripts, autocapture or session replay.
The desktop CSP permits only the ingestion endpoint in addition to existing IPC.

| Event                      | Meaning                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `desktop_first_open`       | First observed opening after enabling statistics                  |
| `desktop_opened`           | Once per desktop webview lifetime while enabled                   |
| `desktop_addon_configured` | First observation of an installed/configured addon                |
| `desktop_ai_connected`     | First observation of a connected selected AI model                |
| `desktop_first_response`   | First successful user reply observed while statistics are enabled |
| `desktop_active`           | Once per UTC day with an observed successful user reply           |

Completed, non-proactive turns containing text update a local status timestamp.
Failed, cancelled, interrupted and empty turns do not qualify. No conversation
content or identifiers are passed to telemetry. Existing setup can produce setup
milestones immediately while statistics are enabled; those events do not imply a fresh install.
Activity uses desktop polling, including while the webview stays alive in the tray;
it does not backfill historical chats or guarantee delivery when offline or exiting.

Payload properties are limited to `source=desktop`, app `version` and `platform`.
Rybbit `user_id` is a randomly generated installation UUID, stored with the usage preference and
deduplication markers in webview local storage. It is not a name, account or device
fingerprint. Two installations count separately. Resetting webview data or disabling
and re-enabling statistics creates a new ID. Turning off aborts pending requests and
removes the local installation ID and saves the opt-out preference; it does not delete events already received by Rybbit.
Like any direct HTTP service, Rybbit receives the client IP and browser user agent.
No emails, tokens, prompts, replies, character names, model IDs or local paths are sent.

Requests time out after three seconds and failures never block app operations.
There is no persistent queue or retry; milestones are best-effort and may be lost.

## Dashboard setup and verification

Use the existing Wisp site and filter custom events by the names above. Compare
unique identified installation IDs for desktop activity, rather than summing opens.
Build a desktop funnel from first open → addon configured → AI connected → first
response. Steps may occur in a different order for existing users. Compare daily
`desktop_active` IDs to measure return usage; available retention reports depend
on the deployed Rybbit version. Web visitors and desktop IDs are not linked, so
download-to-activation conversion is an aggregate comparison, not person attribution.

The existing instance was checked for the tracking script and CORS preflight from
`http://tauri.localhost`. No synthetic events were sent to production analytics.
After deploying the web and installing a build from this PR, verify a real usage
flow in Rybbit: click download, launch Wisp, connect a model and finish a chat.
Confirm the custom events appear in regular traffic (not the bots tab), repeat a
chat without another daily event, then turn sharing off and verify no more sends.
Dashboard configuration is separate from this code change and requires access to
the Rybbit instance; this PR does not claim that live ingestion has been verified.

Protocol references: [Rybbit custom events](https://rybbit.com/docs/sdks/web),
[HTTP ingestion](https://rybbit.com/docs/api/sending-events).
