---
name: visual-pr
description: Always use when creating or updating a pull request.
license: MIT
---

# Visual pull requests

Portable Wisp adaptation of HumanLayer's visual-pr skill. Explain why a change exists and its implementation shape with concise, source-grounded diagrams. No HumanLayer runtime, task directory, hooks or cloud service is required. See [LICENSE](LICENSE) for the preserved HumanLayer MIT notice.

This is a contributor workflow; it does not register an in-game tool or change Wisp's agent runtime. All supporting paths below resolve relative to this SKILL.md.

## When to use

- Use whenever creating or updating a pull request, without requiring explicit invocation by name.
- Do not rewrite unrelated PRs or publish mockups as proof of working software.

## Prerequisites

Follow the repository's Git rules and the user's authorization. Use an authenticated GitHub CLI for PR operations and the available file-reading, search, editing and shell tools for source inspection. Read both supporting references in full before drafting.

Use Wisp's pinned Node/pnpm toolchain and Turborepo scripts, not a Bun default. Select checks appropriate to the diff; documentation-only changes do not require full app tests or dependency installation. Live diagnostics and subscription/player-data tests require separate explicit authorization.

## Procedure

1. Read [the PR description template](references/pr_description_template.md) and [structural visual conventions](references/show-me.md).
2. Identify the exact repository, branch and PR with `git status --short --branch`, `git remote -v` and `gh pr view --json number,url,title,state,baseRefName,headRefName,headRefOid`. If none exists, inspect commits and establish the intended repository and base; create a PR only within the user's authorized scope. Never merge or force-push merely to describe a PR.
3. Inspect the complete diff against the actual PR base, changed-file metadata and surrounding code. Resolve the base and head to exact SHAs; use `git diff --stat BASE_SHA...HEAD_SHA`, `git diff --name-status BASE_SHA...HEAD_SHA` and `git diff BASE_SHA...HEAD_SHA`, not an assumed `main`. Confirm the inspected head matches the PR's `headRefOid`; distinguish uncommitted changes from the published diff. If refs are missing or stale, obtain current refs only as authorized or report the blocker. For stacked PRs, explain the dependency and describe only the delta from that base. Check relevant issue/plan context without inventing links.
4. Write the body following the template: one sentence for Why, 1–3 reviewer notes (or `- None.`), and the smallest structural outline that explains the change. Prefer focused diff sketches for existing shapes; use a complete target shape for new structures. Keep names, ordering and ownership consistent with the source. Do not produce a file-by-file changelog or unnecessary diagrams.
5. Add verified test results and remaining limitations only inside a collapsed `<details><summary>Verification</summary>…</details>` block, not a top-level PR section. For UI changes, include real screenshots/recordings only when they clarify behavior; label mockups as proposals. Keep credentials and private fixtures out. Evidence must be accessible to the intended reviewer before embedding it: a local path is not a GitHub image URL. Do not publish recordings, create hosting tags/releases or modify CI without appropriate authorization.
6. Save the description outside the repository in a workspace/scratch location; do not commit temporary task artifacts. When publication is authorized, update the exact PR using `gh pr edit NUMBER --repo OWNER/REPO --body-file PATH`, or create it with an explicit repository, base and head. If editing fails due to the classic-project GraphQL deprecation, use `gh api --method PATCH repos/OWNER/REPO/pulls/NUMBER -F body=@PATH` (only for that same authorized PR). If publication is not authorized, hand off the draft without writing to GitHub.
7. After publication, read back the exact PR with `gh api repos/OWNER/REPO/pulls/NUMBER`. Verify body equality with the saved draft, URL, base ref and SHA, and head ref and SHA against the inspected diff before reporting success. If they changed, re-inspect and correct the description or report the blocker. Report the URL, concise changes, verified checks and any blocker. Do not invent cloud permalinks or repeat the whole workflow.

## Pitfalls

- Diagrams explain implementation; they do not replace executing tests or checking the running UI.
- Keep reviewer-relevant omissions, compatibility warnings and stack dependencies visible in reviewer notes; keep check results and unverified behavior in collapsed Verification.
- Source publication does not imply a downloadable release or merged feature.
- A failed write or inaccessible attachment is a blocker, not a success.

## Verification

Confirm all diagram identifiers against the exact diff, distinguish actual checks from untested assumptions, and read back the published body and branch/base after any authorized publication.
