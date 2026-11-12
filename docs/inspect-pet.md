# Active owned pet inspection

`wow__inspect_pet` is an on-demand, read-only deferred Eve tool. Discover it with
`eve__search` and invoke it with `eve__tool` and empty input `{}`. The authenticated
bridge requires an active Eve conversation in the current addon transport session
and the `inspect_pet` capability. It uses the existing `pet` inspection request.

The reader uses only the owned `pet` unit token. It returns `presence` plus
`identity`, `learned` and `actionBar` sections, each with its own source,
`capturedAt`, status and completeness. Only readable `UnitExists("pet") == false`
confirms absence. Missing/throwing/restricted identity is unknown. GUID and name
are revalidated after enumeration; swap/despawn invalidates all former sections
as stale. No readings are cached.

The learned section enumerates at most 64 pet-bank slots, returning spell IDs
only for spell entries, not pet commands. Unreadable/incomplete enumeration cannot
establish unlearned abilities. The separate action bar reads 10 slots and labels
command tokens, identified spells and empty/unknown slots. A named non-token slot
without a readable spell ID remains unknown and makes the bar partial, regardless
of its autocast flags; a missing ID does not establish a non-spell button or
inapplicable autocast. Autocast is `enabled`,
`disabled`, `not_autocastable`, `unknown` or `not_applicable`; missing from the bar
does not imply unlearned or disabled. Text is clipped at UTF-8 boundaries (96
bytes), with explicit clipping flags. Escaped aggregate JSON is limited to 16 KiB,
dropping learned entries first while marking partial/omitted; transport envelope
headroom is retained without changing general transport limits.

## Forever compatibility

Verified against the explicit `Gethe/wow-ui-source` **forever** branch at
`4cd0ab752a77164f654ccbca9d0c1fe8dafceebe`:

- `Blizzard_PlayerSpells/SpellBook/Blizzard_SpellBookCategory.lua`: native pet
  bank, slot offset zero, count from `C_SpellBook.HasPetSpells()`.
- `Blizzard_PlayerSpells/SpellBook/Blizzard_SpellBookItem.lua`: native
  `GetSpellBookItemInfo(slotIndex, spellBank)` and spell vs pet-action handling.
- `Blizzard_APIDocumentationGenerated/SpellBookDocumentation.lua`: count may
  return nothing; item info contains `itemType`, `spellID`, `name`.
- `Blizzard_APIDocumentationGenerated/SpellBookConstantsDocumentation.lua`:
  explicit Pet bank and Spell/PetAction item enums.
- `Blizzard_ActionBar/Shared/PetActionBar.lua:353-365`: native
  `GetPetActionInfo(slot)` returns name, texture, isToken, isActive,
  autoCastAllowed, autoCastEnabled, spellID. No casts/toggles are called.
- `Blizzard_APIDocumentationGenerated/UnitDocumentation.lua`: existence is a
  boolean; GUID/name may be restricted. Secret values are rejected before use.

Optional APIs are feature-detected, with no Retail fallback or protected/secret
bypass. No feeding, training, summoning, stable access, movement or pet commands;
no polling, automatic model call or simulator changes.

Linux mocks validate production modules and native discovery/RPC, not in-game
Forever compatibility or Windows UX. Future authorized human validation: inspect
a hunter pet, manually toggle autocast then explicitly refresh, swap pets and
refresh, dismiss the pet and verify confirmed absence. These checks are not run.
