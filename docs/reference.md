# Integrations and simulator

[Home](../README.md) · [Usage](usage.md) · [Development](development.md)

## Game tools and knowledge sources

Wisp reads character state on demand and can inspect references, compare item stats, check progress/resources and create saved panels. See [action controls](usage.md#actions-you-control) for pins, macros and settings; the [agent definitions](../apps/agent/agent) and [protocol schemas](../packages/protocol/src) are the exhaustive tool and UI reference.

| Source                                            | Useful for                                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installed Forever QuestieDB                       | NPC spawns, class trainers and supported town services. Optional; Wisp neither installs nor modifies it. Locations are database spawns, not live sightings.   |
| [TheWoWDB](https://thewowdb.com/developers/)      | Primary external Forever catalog: search and entity details. Catalog area IDs are not necessarily native map IDs.                                             |
| [Everloot](https://everloot.app/docs/mcp/clients) | Read-only Forever references, recipes, locations, talent plans and market estimates/history. No API key, uploader or extra addon required.                    |
| Wowhead search                                    | Forever-only fallback via ChatGPT or Exa, independently of the model. Public Exa needs no key and has free rate limits; an optional key uses account credits. |

Source links, build, age and coverage matter; see [how to interpret answers](usage.md#reading-the-answers) and [what leaves your computer](usage.md#what-leaves-your-computer). For filtering and integration contracts, consult [TheWoWDB](../apps/bridge/src/thewowdb.ts), [Everloot’s allowlist](../apps/agent/agent/connections/everloot.ts), [Wowhead search](../apps/bridge/src/wowhead-search.ts) and the agent instructions.

## Native desired CVar presets

In the in-game Wisp window, open **Settings → CVar presets**. This is a local
player control, not a natural-language save/list tool or a desktop settings profile.

1. Choose **New preset**, enter a name, explicitly check **1–12** discovered numeric
   or boolean CVars, and enter their desired numbers or `true`/`false`. No targets
   or desired values are selected for you. The picker shows at most the first
   **60 discovered targets**, not every game setting; it reports truncation.
2. **Save definition** stores the name and normalized desired values only. Choose
   its name under **Saved presets** to see the saved desired definition.
3. **Review changes** rediscovers all selected targets and creates a **new** preview
   from their current native readings. Save, list, selection and Review make no
   game writes, model calls or transport requests. **At review** labels an immutable
   reading, not a continuously live value—even after Apply or Undo.
4. Deliberately choose **Apply changes** to use the existing settings transaction
   engine and verified readback. **Undo changes** restores the values immediately
   before that Apply only if they remain safe to restore. A manual change after
   preview blocks stale Apply; a manual change after Apply blocks destructive Undo.

Definitions belong to the verified current character. **This does not make the
CVars character-local**: their native scope is unknown here and may be account-wide.
Missing, read-only, incompatible, wrong-owner or stale-revision targets block the
entire review, without partial application. Apply/Undo retain character/session,
combat, current-value and capability gates; disconnected, disabled, unavailable
or pending capabilities block the native mutation buttons. Each later Review
gets a new transaction ID; there is no automatic switching or historical replay.

Select a definition, choose **Delete preset**, then confirm **Delete definition**
or **Cancel**. Deletion checks current owner, exact ID and selected revision. It
removes only that definition: no game writes or model/transport calls, no undo of
applied settings, and no erasure of transaction history. Names are limited to
48 bytes, with no overwrite of an existing name for that owner; the local
collection holds at most 30 definitions. There is no rename/edit/import feature.

Definitions persist in the addon's existing **WispAIDB SavedVariables**, restored
after the game saves and reloads them. Only supported discovered numeric/boolean
CVars are included—not keybindings, scripts, addon profiles or complete game
configuration. Actual CVar support/scope and SavedVariables logout/restart behavior
depend on the client; offline fixtures and approximate UI reconstructions do not
establish real-client appearance, availability or scope.

## Custom MCP connections

In desktop **Tools & MCPs**, choose **Add MCP**:

1. Select **Streamable HTTP**, **SSE** or **stdio**.
2. For HTTP/SSE, enter the endpoint and optional bearer token. For stdio, enter the executable, each argument separately and any required environment values.
3. Test discovery, then save. Use in-game **Settings > Tools & MCPs** to enable connections or individual tools.

**Stdio works directly**: the bridge starts the process and relays tools to the agent; no HTTP adapter is needed. For an already-installed Node server, for example, use `node` as the executable and its absolute script path as one argument. `node` uses Wisp’s runtime; `npx` uses bundled npm. Other commands may need their own installed dependencies.

Stdio receives a limited OS environment plus configured values, not inherited bridge tokens. On Windows, configured secrets use DPAPI; metadata stores only secret-presence flags/key names. Generic MCP OAuth sign-in is not provided: OAuth-only services need a supported token flow or a separately configured adapter. Review the [custom-server trust boundary](usage.md#actions-you-control) before connecting.

For manual source configuration, copy [mcp.example.json](../mcp.example.json) to a local file, replace the example endpoint and enable the entry. Set `mcpConfig` in `config.local.json` to its path relative to the data root; the default is `runtime/mcp.json`. `transport` accepts `http` (default), `sse` or `stdio`; stdio uses `command` and `args`, while `tokenEnv` names an HTTP bearer-token environment variable. Prefer desktop secret fields, keep secrets out of source, and restart after manual edits. Exact fields are in [mcp-manager.ts](../apps/bridge/src/mcp-manager.ts).

## Experimental local DPS simulations

`simulate_dps` compares up to **three damage plans**, using current equipment and up to **two alternative equipment sets**, against one stationary target. It runs the pinned WoWSims Forever **levelsim** engine locally on request with one fresh character snapshot. It never changes equipment in the game.

| Class   | Validated action families                                                             | Initial coverage                                        |
| ------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Mage    | Frostbolt, Fireball, Fire Blast, Arcane Missiles, Frost Nova, Arcane Explosion        | Caster damage, complete channels, optional wand         |
| Warrior | Heroic Strike, Rend, Slam, Thunder Clap, Bloodrage                                    | Melee, Battle Stance, zero starting rage                |
| Rogue   | Sinister Strike, Eviscerate                                                           | Melee, energy and combo-point conditions, no poisons    |
| Hunter  | Arcane Shot, Multi-Shot, Serpent Sting, Hunter's Mark, Aspect of the Hawk, Rapid Fire | Ranged auto attacks; no pet, ammunition or quiver bonus |
| Paladin | Seal of Righteousness, Judgement, Holy Strike, Consecration                           | Melee; seals must be explicit actions                   |
| Priest  | Smite, Mind Blast, Shadow Word: Pain                                                  | Caster damage, optional wand                            |
| Shaman  | Lightning Bolt, Chain Lightning, Earth Shock, Flame Shock                             | Caster damage, no totems or imbues                      |
| Warlock | Shadow Bolt, Incinerate, Immolate, Corruption                                         | Caster damage, optional wand; no demon or sacrifice     |
| Druid   | Wrath, Starfire, Moonfire                                                             | Caster damage; Moonkin Form follows applied talents     |

This is damage coverage for all nine classes, not every specialization or ability. A family is available only when its engine-selected rank is confirmed learned. Orc Blood Fury is an explicit action. Talents and rank ladders are generated from the pinned engine source; no level-60 preset replaces live data. Native regression tests exercise each class at levels 11, 30 and 60.

- **Plans:** a once-only ordered opener, then repeating priorities whose first castable action wins. Conditions support mana percentages, rage, energy, combo points and DoT refresh time. Use a seal in the paladin opener before Judgement; put rogue finishers before builders with a combo-point threshold. Spells must be available in the selected adapter.
- **Equipment:** current equipment is always the baseline. Each alternative has a label and explicit `replacements: [{ slot, itemId }]`, with native inventory slots (for example, rings 11/12, main hand 16, off hand 17, ranged 18). `itemId: 0` removes a slot. Replacements use unenchanted base catalog items without random suffixes; unchanged slots retain their live enchants and suffixes. Item IDs must first be verified with inspection tools. The bridge validates catalog presence, level, class, faction, slot, armor/weapon type, unique restrictions and weapon combinations. Profession-specific candidates are unavailable because the snapshot cannot verify their requirements. Replacing a main hand with a two-handed weapon requires explicitly removing the off hand. Weapon training and actual skill are not read; results assume trained types and engine weapon skills.
- **Scenario:** **10–180 seconds**, **100–2,000 iterations**, target level offset **−2 to +3**. Melee adapters default to and require 5 yards; other adapters default to 20. Spell range checks apply. All combinations share duration, target, snapshot, iterations and seed. A comparison has at most nine runs within one 45-second execution budget; failure returns unavailable, without partial rankings.
- **Results:** mean DPS, standard deviation and standard error, spell/auto-attack breakdown, cast counts, unused actions, zero-damage actions, mana exhaustion where relevant, engine provenance and class assumptions. `equipmentDeltaDps` and `equipmentDeltaPercent` compare each set to current equipment **with the same plan**. `relativeToFirstPercent` compares to the first plan with current equipment and can include rotation differences. Small differences must be interpreted with sampling variation; a shared seed alone is not a reported paired confidence interval.
- **Inputs:** fresh character, applied talents, spellbook and equipment readings. Missing data, unknown items/talents, duplicate talents/slots, pending talent changes, unlearned engine-selected ranks or a mismatched binary make the simulation unavailable.
- **Limits:** no healing/tanking estimates, pets, movement, incoming attacks, kiting, survival or latency. Mage Arcane Intellect is applied automatically by the engine. No external buffs, consumables or temporary enchants. This is a bounded scenario comparison, not measured questing DPS or a globally optimal rotation/build. It must never run automatically in the background.

Example equipment comparison (the agent resolves learned spell and candidate item IDs first):

```json
{
  "plans": [{ "label": "Current rotation", "priority": [{ "spellId": 205 }] }],
  "equipmentSets": [
    { "label": "Minor Channeling Ring", "replacements": [{ "slot": 11, "itemId": 1449 }] }
  ],
  "durationSeconds": 30,
  "iterations": 500
}
```

Build prerequisites are in [development](development.md#build-and-run-on-windows); packaged Windows apps include the binary, so players do not need Go/protoc. See the [pinned manifest](../simulator/manifest.json), [adapter](../apps/bridge/src/simulation.ts), [attribution](../NOTICE) and [MIT license](../simulator/LICENSE-WoWSims.txt).
