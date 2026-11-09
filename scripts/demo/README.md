# Offline Wisp addon demo

This runs Wisp's **original Lua UI modules** in a browser simulator, then exports
three silent H.264 MP4 clips and two PNG posters. No WoW process, Battle.net login,
live character, bridge, ChatGPT credentials or AI calls are used.

```sh
pnpm demo:dev     # local interactive simulator, http://127.0.0.1:3011/wisp.html?controls
pnpm demo:render  # regenerate public media and validate all recorded scenes
```

The interactive toolbar switches between empty chat, gear comparison, quests and
three bag-count states. The addon window itself supports the simulator's mouse
and text-input interactions. Arbitrary questions do not call an AI backend;
use the prepared scenes for the presentation.

## How it works

- `render.mjs` obtains the external [WoW Addon Sandbox](https://github.com/srrmke/wow-addons-sandbox)
  at commit `55431c10e99148fe5f9c00e2de358550bcf1c449` under ignored
  `node_modules/.cache/wisp-demo/`. Third-party runtime source is not bundled into
  the landing or copied into this repository's tracked source.
- The script loads the current `Core.lua`, `RichUI.lua`, `Widgets.lua`,
  `MessageFormat.lua`, `ModelControls.lua`, `MessageRows.lua`, `UI.lua` and
  `Panels.lua` directly from `addon/WispAI/`. `fixture.lua` replaces the external
  transport and supplies sample character data and scripted responses.
- `browser-entry.ts.txt` is a TypeScript template copied into the external tool's
  checkout, where its runtime imports resolve. `browser.html` frames the capture
  with a title and an explicit offline-demo disclosure.
- Playwright opens a separate headless Chrome instance and captures the rendered
  states. The equipment scene invokes the original `C.Submit()` path. The tracker
  uses the original `C.ReceivePanels()` / `C.BoundPanel()` logic with simulated bag
  counts of 12, 16 and 20.
- The export fails on recorded Lua/browser errors or if the tracker does not
  render both `20 / 20` and `100%`. `public/demo/provenance.json` records hashes
  of the Lua sources, the renderer revision and the checks.

## Requirements

The first setup needs Git, pnpm, tar and network access to GitHub and the npm
registry. The default recording browser is installed Google Chrome; set
`WISP_DEMO_BROWSER` to another Playwright browser channel if needed. Dependencies
are installed only in the ignored tool checkout, with lifecycle scripts disabled.

On Windows, the script obtains FFmpeg from the npm registry package
`@ffmpeg-installer/win32-x64@4.1.0`, verifies the archive's registry-provided
SHA-512 integrity on download, and unpacks it locally. Set `WISP_DEMO_FFMPEG` to
use an existing executable instead; this variable is required on other platforms.
See that package's bundled FFmpeg license information in the local tool cache.
`WISP_DEMO_PORT` overrides the default local port 3011.

## Outputs

Files under `apps/web/public/demo/` are deployed as ordinary static assets:

| File                  | Use                                                               |
| --------------------- | ----------------------------------------------------------------- |
| `wisp-demo.mp4`       | Combined equipment, quests and tracker presentation (~24 seconds) |
| `gear.mp4`            | Equipment scene (~11 seconds)                                     |
| `tracker.mp4`         | Saved tracker and local bag-count updates (~9 seconds)            |
| `addon-preview.png`   | Gear comparison poster                                            |
| `tracker-preview.png` | Tracker poster                                                    |
| `provenance.json`     | Source hashes, tool revision and validation results               |

The landing's demo player switches between these files. Source changes require
rerunning `pnpm demo:render`; a normal Vercel build uses the committed media and
does not download or run the simulator.

## Fidelity limits

The UI layout and logic come from Wisp's Lua, but the external simulator emulates
WoW's widget API, fonts, borders and built-in art. This is **not verified pixel
parity**, a real game recording, a live AI response, or a latency benchmark. The
disclosure is present in the footage and beside the landing's player.

A native `Osso/wow-ui-sim` experiment was also attempted locally. Its pinned
Forever build differed from the installed build, and source extraction encountered
missing client assets. It is not a dependency of the working browser pipeline.
No extracted Blizzard source, font or texture files are shipped with this demo.
