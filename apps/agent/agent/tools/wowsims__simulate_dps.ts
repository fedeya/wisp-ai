import { defineTool } from 'eve/tools';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { simulationInput } from '@wisp/protocol/simulation';
export default enabledTool(
  'simulate_dps',
  defineTool({
    deferred: true,
    description:
      'Simulate freely using the pinned WoWSims engine. Two input modes: (1) nativeRequest is a complete WoWSims RaidSimRequest JSON object forwarded unchanged to the engine, with no live game reading or Wisp gameplay filters. It supports any engine-supported player/spec, equipment, enchants, stats, pets, buffs, targets, rotation/APL and scenario. Required native fields typically include raid.parties[].players[], encounter.duration/targets, simOptions.iterations/randomSeed. Native mode returns status:native with the raw engine result; engine errors are unavailable, never fabricated zero. (2) Structured plans/equipmentSets compile convenient comparisons. No fixed number of plans or sets; durationSeconds and iterations are positive and configurable. A 45-second runtime budget remains. If nextIndex is non-null, repeat the identical structured input with startIndex:nextIndex; preserve all returned results and failures and continue until null. Percentage deltas are null for zero or unavailable baselines; compare raw DPS across pages only when scenario, character, gear, talents and seed match. Each plan has label, optional complete talents:[{id,rank}], opener and priority actions using exact spellId rank IDs. Empty priority is allowed and zero DPS is a valid outcome. Do not require ownership, learned status, highest rank, in-game equipment changes, class/level/faction/profession eligibility, talent tiers or a Wisp spell whitelist. Let the engine evaluate these. Character override {class,level,raceToken} plus includeCurrentEquipment:false and equipmentSets with base:empty permits fully hypothetical runs with no live reading; omitted plan talents then means none. Omit character to use live identity; omit plan talents to use applied talents for live identity. Equipment sets base:current inherit live gear; base:empty starts naked. Replacements {slot,itemId}; itemId:0 removes a slot. Structured replacements are base catalog items; use nativeRequest for other item variants/fields. catalogOnly:true returns helper metadata for the selected class; it is not an engine capability whitelist. Structured conditions include manaBelowPercent, manaAbovePercent, rageAbove, energyAbove, comboPointsAtLeast and dotRefreshBelowSeconds. The helper detects known channels; use nativeRequest for other channel actions or richer APL. Treat unused actions, zero damage and engine errors as evidence. Report scenario, uncertainty, actual IDs/assumptions and source; never claim a global optimum. Never auto-run CPU simulations in the background.',
    inputSchema: simulationInput,
    label: { start: () => 'Simulating DPS with WoWSims' },
    execute: (args, ctx) =>
      agentRPC('simulate', { eveSession: ctx.session.id, ...args }, ctx.abortSignal, 85000),
  }),
);
