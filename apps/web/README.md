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
Examples are inspired by actual usage, with sample data and condensed replies;
they make no live game or AI calls. The demo includes pause/play, pauses when the
tab is hidden, and starts static for reduced-motion users. No video or simulator
is loaded by the landing. Optional earlier recording tools remain documented in
[the offline recording workflow](../../scripts/demo/README.md).

Stable capabilities are listed explicitly. Panels and trackers are marked Beta;
combat simulation is Experimental, without claiming complete class coverage.
SEO, canonical URL, sitemap, robots and a generated 1200×630 PNG social card are
included. Production pages load Rybbit for site `61b021a9d037` through the
first-party `/_fm/` proxy to `https://rybbit.fedeminaya.com/api/`, matching the
portfolio integration. Development and Vercel previews do not load the tracker.
Enable **First-Party Proxy** in Rybbit Site Settings → Privacy & Security so
forwarded visitor IPs are interpreted correctly. Only tracking endpoints are
exposed; the dashboard and administrative API are not proxied. Download buttons
record `download_clicked` with their placement. See [telemetry and download metrics](../../docs/telemetry.md)
for desktop opt-in, GitHub counters and dashboard setup.

The immersive hero uses a generated illustrative background and locally cached
WoW icons. Equipment, tooltips, auctions, bags and action bars are native React
and CSS, not a flattened mockup or video. See [asset provenance](ASSETS.md).

The setup guide and troubleshooting live at `/setup`, with local privacy/control
information at `/setup#privacy`. The hero types prompts and replies, shows a
thinking indicator, fades between conversations, and keeps its outer bounds
fixed throughout the loop. The decorative character equipment panel was removed.

SEO metadata, structured data, robots/sitemap behavior, asset delivery and local
Lighthouse measurements are documented in [SEO and performance](SEO.md).

English and Spanish versions are available under `/en` and `/es`, with browser
language detection and a persistent manual selector. See [website languages](LANGUAGES.md)
for translation maintenance, routing and localized SEO.
