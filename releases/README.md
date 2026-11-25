# Wisp releases

Stable and Nightly are channels of the same product. The installer, GitHub release,
updater and website use the same Markdown notes. The website reads published GitHub
Releases, so drafts never appear in the public changelog.

## Release notes

Stable notes are written for players, one [Changie](https://changie.dev) fragment per
change, so pull requests never edit the same file:

```powershell
pnpm changie new --kind Fixed --body "Messages with an emoji keep the chat's font."
```

This adds `releases/unreleased/<Kind>-<time>.yaml`. Kinds are `New`, `Improved` and
`Fixed` (`.changie.yaml`); a release lists them in that order under
`# What's new in Wisp`. Explain the benefit and any action players need to take, in
one bullet. Leave test coverage, CI changes and implementation details out, and use
absolute HTTPS URLs for images. Changes players will not notice need no fragment.
Edit or delete a fragment like any other file before it ships.

## Stable

A Stable release promotes a Nightly that was already published from `main`, so it
ships exactly the source you tested on the Nightly channel, never newer commits.

1. Install and check the Nightly you want to ship.
2. Run **Release** from GitHub Actions on `main` with **channel** `stable`.
   By default it promotes the latest published Nightly from `main` as its own `X.Y.Z`
   (`0.3.3-nightly.214.1` becomes `0.3.3`). **nightly** picks an older one by tag and
   **version** overrides the number, for example `0.4.0`. It must be newer than the
   last Stable. From a terminal:
   `gh workflow run release.yml -f channel=stable [-f nightly=v0.3.3-nightly.214.1] [-f version=0.4.0]`.
3. The run checks out the Nightly's commit, stamps the version into that build only,
   collects the Changie fragments of that commit into the notes, then builds and
   signs the Windows installer and the Linux packages, and verifies the installer. It skips validation because the Nightly's own run
   validated that commit. It creates a draft with the notes and `latest.json`.
4. Review the draft and publish it as latest. Publishing creates the `vX.Y.Z` tag on
   the Nightly's commit. To correct notes first, edit the draft and run
   `pnpm release:notes vX.Y.Z <file> --apply` (see below) so `latest.json` matches.
5. **Record stable release** then opens a pull request on `main` that archives the
   published notes in `releases/X.Y.Z.md`, deletes the fragments that release shipped
   (fragments merged after the promoted Nightly stay for the next release) and moves
   `main`'s version to `X.Y.Z`. With the `RELEASE_APP_ID` variable and
   `RELEASE_APP_PRIVATE_KEY` secret of a GitHub App that can write contents and pull
   requests, it opens the pull request and enables auto-merge; without them, it
   pushes the branch and its run summary links to open the pull request by hand.
   Run it manually with a tag to retry.

A Nightly built before Stable promotion existed cannot be promoted; promote a newer
one. To retry a failed promotion, delete its draft first. Release tooling does not
publish npm packages or automatically publish stable drafts.

### CurseForge addon

Create the WoW Addons project in [CurseForge for Authors](https://authors.curseforge.com/)
and explain that Wisp Desktop for Windows is required. Link the
[setup guide](https://wisp.fedeya.sh/setup) in the project description.

After publishing the matching stable GitHub release, run **CurseForge addon**
from GitHub Actions with its tag and **Upload** unchecked. Download the workflow
artifact, extract the inner `WispAI-X.Y.Z.zip`, and submit that ZIP under
**Files > Upload File** as a **Release** for **Forever 1.60.1**.

For subsequent releases, set the Actions repository variable
`CURSEFORGE_PROJECT_ID` to the numeric project ID and the Actions repository
secret `CURSEFORGE_API_TOKEN` to a
[CurseForge author token](https://authors.curseforge.com/#/api-tokens).
Publishing a stable GitHub release then submits the matching addon ZIP and
changelog to CurseForge for review. The manual workflow also accepts **Upload**
for a published stable tag that still needs to be submitted.

## Nightly

Pushes to `main` run validation once through the release workflow. App packaging
is skipped when all changed paths belong to the
website, documentation/release notes, contributor instructions, GitHub workflows
or the website revalidation script and its tests. Validation still runs for those
changes. Mixed pushes that also change app code still build an installer. Shared
dependencies, lockfiles and build scripts remain release inputs, as do the agent's
runtime Markdown instructions and skills. Manual workflow runs (including Stable
promotion) bypass the packaging filter. The policy lives in `scripts/release-inputs.ts`.

After checks pass, CI assigns
`<current stable, next patch>-nightly.<run number>.<attempt>` only in the build
checkout, where the current stable is the newer of `main`'s version and the latest
Stable tag. No version commits are pushed back to `main`. Each installer has an
immutable version tag targeting the exact source SHA. No notes need to be authored
for a PR or Nightly build: merging is enough. Generated GitHub release notes
start with **Changes since ...** and the technical commit list since the
previous published Nightly on this build's ancestry. Drafts and incomplete builds
are excluded, so failed builds do not hide changes. The first Nightly compares
against its nearest Stable ancestor; without any Stable tag it lists up to 30
recent commits. Notes link both to that build's diff and, when available, all
changes since Stable. GitHub lookup errors stop preparation rather than silently
choosing an incorrect baseline. Nightly never reads the Changie fragments or copies
pending Stable highlights into every build.

The website lists Nightlies compactly: version, date, platform download and the
technical link, which opens that build's GitHub release to read its notes. The
commit list stays off the website, including version detail pages. The channel
explains that builds are experimental; the version detail repeats that notice.
GitHub and the updater use the same generated notes.

The signed installer must pass installation/upgrade tests before the prerelease
is published. The moving `nightly` prerelease holds only the latest updater
manifest; it is updated last and is excluded from the web history. Failed builds
leave the previous feed intact. Re-running a workflow generates a distinct build.

## Updates and changelog

- Stable feed: GitHub `releases/latest/download/latest.json` (kept compatible with
  existing installs).
- Nightly feed: GitHub `releases/download/nightly/latest.json`. Manifest URLs point
  to immutable versioned artifacts, never a moving installer.
- Set the addon's base version in `addon/WispAI/WispAI.toc` as `MAJOR.MINOR.0`.
  Update the major or minor number when the addon needs a new version series.
  Windows packaging computes the patch from first-parent commits that change
  `addon/WispAI` or `packages/protocol/src/addon-helpers.ts` after that base was
  set, starting at zero. Stable and nightly builds from the same commit use the
  same version. Packaging writes it into the bundled TOC, and generated helpers
  inherit it. `/wisp diag` checks the loaded addon against that bundled version.
- App Settings → App updates persists the selected channel. Fresh Nightly installs
  default to Nightly; stable installs default to Stable. Switching clears pending
  updates. Returning from Nightly explicitly permits an older stable version;
  ordinary updates only move forward within the selected channel. Both channels
  share the installation and user data; they are not side-by-side apps.
- `/changelog` shows stable releases; `?channel=nightly` shows previews.
  `/changelog/<version>` is a permanent link. The website and app use the same
  restricted Markdown renderer (headings, lists, links, images, code; raw HTML is
  escaped). Release notes currently remain in their authored language.
- To correct notes, edit the archived Markdown and run
  `pnpm release:notes v0.0.8 releases/0.0.8.md` to preview the correction, then
  repeat with `--apply`. The command synchronizes the GitHub release body and
  updater notes, preserves all other manifest fields (including URLs and
  signatures), verifies the result and attempts rollback on failure. For the
  current Nightly it also updates the moving feed; older Nightlies leave that
  feed untouched. Run one release maintenance operation at a time, outside an
  active release publication. Commit the corrected Markdown for traceability.
- The web uses the public GitHub Releases API, cached for five minutes, with
  ten releases per page within each channel and separate failure states.
  Optionally set `GITHUB_RELEASES_TOKEN` on the web
  server for a higher API quota. It is never sent to the browser.

Both channels require the existing `TAURI_SIGNING_PRIVATE_KEY` Actions secret
(and its password secret if configured). Never replace the checked-in public key
to add a channel. GitHub Actions must have permission to create releases/tags.

## Verify a downloaded build

The release workflow and its post-release installer check both verify the build
version from the `latest.json` next to the installer. Keep both files together
when downloading an artifact. The manifest version and installer filename must
match before installation begins, even when the source checkout still contains
the stable version. The installer report includes the verified build version.
Run this check only in the disposable Windows CI profile, never against a local
installation or real WoW addon directory.
