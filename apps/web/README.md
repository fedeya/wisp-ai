# Wisp landing

Next.js App Router landing for **https://wisp.fedeya.sh**. The site is independent
of the desktop app and does not need its bridge, Rust build or credentials.

## Local development

From the repository root:

```sh
pnpm install
pnpm web:dev
```

Open http://127.0.0.1:3000. Production check: `pnpm web:build`.

## Styling and motion

Tailwind CSS 4 runs through PostCSS. `src/app/globals.css` contains only theme
tokens, typography defaults, resets and global accessibility preferences. Layout,
spacing, text styles and responsive states live in component utility classes;
there are no web `@apply` rules. `components/ui.ts` shares the content-width and
navigation-link utilities. The named breakpoints preserve the original layouts:
`sm` starts at 371px, `md` at 761px, `lg` at 1101px and `2xl` at 1600px.

Gradients, shadows, decorative effects and a few cross-component scene adjustments
use colocated CSS Modules. Semantic class hooks let these local selectors style
children rendered by `Item` and `Money` without exposing module internals. Keep
these hooks when editing a scene. Preflight is intentionally omitted to preserve
existing typography and native controls.

The language menu uses Base UI for keyboard navigation, dismissal and focus
restoration. `HeroMotion` uses Motion's mini animation API to stagger hero content
without hiding server-rendered text. The chat demo and level-up routine also use
Motion for message entrances, scene exits, the level-20 glow and the follow-up
sequence. `useSceneMotion` pauses and resumes in-flight animations alongside the
scene timers when paused, off screen or in a hidden tab. Motion also animates the
visible character count for the typewriter; React renders the corresponding text
slice. Reduced motion shows a static completed example. Keep simple hover effects,
the typing caret and thinking dots in CSS.

For a separate worktree preview, choose an unused port:

```sh
pnpm --filter @wisp/web exec next dev --hostname 127.0.0.1 --port 3037
pnpm --filter @wisp/desktop exec vite --host 127.0.0.1 --port 1437
```

The desktop command starts a design preview only, without Tauri or the bridge.
Its Tailwind theme lives in `apps/desktop/src/style.css`, using the Vite plugin.
Both themes require modern browsers supported by Tailwind 4 (Chrome/Edge 111+,
Safari 16.4+, Firefox 128+); desktop previews use the current WebView2 runtime.

## Vercel

1. Import this GitHub repository into Vercel.
2. Set **Root Directory** to `apps/web` and framework to **Next.js**.
3. Keep the output defaults and enable access to files outside the root directory.
   The checked-in `vercel.json` installs with `pnpm --filter @wisp/web... install
   --frozen-lockfile` and builds with `pnpm exec turbo run build --filter=@wisp/web`.
   There is one shared lockfile at the repository root. Root dependencies are
   repository tools only; agent, bridge, addon and test dependencies belong to their
   own workspaces and are not installed by the web deployment. Do not override
   installation with an unfiltered `pnpm install`.
4. Add `wisp.fedeya.sh` in the project's Domains settings and apply the DNS record
   Vercel provides.

No environment variables are required. Download buttons use `/download`, which
resolves the current stable Windows installer automatically. `NEXT_PUBLIC_INSTALL_URL`
is an optional explicit override; leave it unset to follow new releases.

For an isolated workspace export, run `pnpm exec turbo prune @wisp/web
--out-dir=.vercel-workspace` from the repository root. Turbo generates the reduced
workspace and lockfile from the shared graph; do not maintain a second lockfile.

## Launch configuration

`src/site.ts` controls the public URL, repository and download entry point.
`src/release.server.ts` reads `releases/latest/download/latest.json`, the same
manifest published for the desktop updater. The displayed version, structured
data and social card use that manifest too. Release data and versioned pages
revalidate every five minutes as requests arrive, without a new deployment.
The first request after expiry can receive cached data while Next.js refreshes it.

`/download` returns a temporary, non-cacheable redirect to the installer from the
manifest. If the manifest is unavailable or invalid, it redirects to GitHub's
latest release page; the landing stays available without a version label.
Publish the stable release with its installer and `latest.json` to update the web.
Drafts and prereleases do not change GitHub's latest stable release destination.

The hero is a native React reconstruction of the chat interface. It loops through
a macro, a gear conversation with an auction-price follow-up, and material advice.
Examples use sample data and make no live game or AI calls. The demo includes pause/play, pauses when the
tab is hidden, and starts static for reduced-motion users. No video or simulator
is loaded by the landing.

Stable capabilities are listed explicitly. Panels and trackers are marked Beta;
combat simulation is Experimental, without claiming complete class coverage.
SEO, canonical URL, sitemap, robots and a generated 1200×630 PNG social card are
included. Production pages load Rybbit for site `61b021a9d037` through the
first-party `/_fm/` proxy to `https://rybbit.fedeminaya.com/api/`. Development and Vercel previews do not load the tracker.
Enable **First-Party Proxy** in Rybbit Site Settings → Privacy & Security so
forwarded visitor IPs are interpreted correctly. Only tracking endpoints are
exposed; the dashboard and administrative API are not proxied.

The immersive hero uses a generated illustrative background and locally cached
WoW icons. Equipment, tooltips, auctions, bags and action bars are native React
and CSS, not a flattened mockup or video. See [asset provenance](ASSETS.md).

The setup guide and troubleshooting live at `/setup`, with local privacy/control
information at `/setup#privacy`. The hero types prompts and replies, shows a
thinking indicator, fades between conversations, and keeps its outer bounds
fixed throughout the loop.

SEO metadata, structured data, robots/sitemap behavior, asset delivery and local
Lighthouse measurements are documented in [SEO and performance](SEO.md).

English and Spanish versions are available under `/en` and `/es`, with browser
language detection and a persistent manual selector. See [website languages](LANGUAGES.md)
for translation maintenance, routing and localized SEO.
