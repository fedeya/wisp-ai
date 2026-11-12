---
name: lockouts
description: Use when asked about saved raids, instance lockouts, or which observed reset comes next.
---

Find `wow__inspect_lockouts` with native tool search and read on demand. This is
the connected character's already-cached saved-instance list, not all raids,
world bosses, alts, boss progress or a loot-eligibility checker.

Explain provenance before planning: `capturedAt` is this tool read, while
`data.cache.observedAt` / `ageSeconds` describe an UPDATE_INSTANCE_INFO actually
observed by Wisp. `unobserved` means cache age is unknown. Even `update_observed`
does not guarantee server freshness or eligibility. Never call enumeration fresh.
If a newer reading is needed, ask the player to refresh through the native raid
information UI, then explicitly reread. The tool never requests refresh or polls.

Use a concise table/card with native name, difficulty label/ID, observed lock and
extension flags, reset text, and availability. Known active upcoming resets sort
first; preserve inactive/expired and unknown-time records explicitly. Missing
flags are unknown, not false. Respect partial/truncated/text-clipped coverage;
ordering covers at most the first 100 cached entries, not necessarily every save.
Zero/absent cached entries never imply that all raids or loot are available.
Do not invent maps, IDs or exact eligibility. No extensions, clears, invitations,
entering instances, reminders or background planning/actions.
