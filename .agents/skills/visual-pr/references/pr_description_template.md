# PR description template

Optional: existing issue, dependent PR or design links (omit when unavailable).

## Why the change

Exactly one sentence: the problem addressed and what becomes possible.

## Special things to note

- One to three reviewer-relevant warnings, stack dependencies, migrations, constraints or deliberate omissions. Use `None.` when none apply.

## Change outline

The smallest useful structural view, with a short explanation next to it. Use focused `diff` blocks for existing shapes, or language-specific/text blocks for mostly new shapes. Suitable views: data types, API/schema contracts, UI regions/component ownership, shallow responsibility trees, or control/data flow. Omit irrelevant categories and do not dump every changed file.

<details>
<summary>Verification</summary>

- Actual commands/results and verified UI evidence where relevant.
- Explicit unverified behavior or blockers. Do not imply hosted CI ran if only local checks ran.

</details>
