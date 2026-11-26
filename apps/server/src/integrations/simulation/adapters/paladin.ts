import type { ClassAdapter } from './types.ts';
export const paladin: ClassAdapter = {
  token: 'PALADIN',
  engineClass: 'ClassPaladin',
  spec: 'retributionPaladin',
  resource: 'mana',
  areaRanges: { Consecration: 10 },
  dots: ['Consecration'],
  families: ['SealOfRighteousness', 'Judgement', 'HolyStrike', 'Consecration'],
  melee: true,
  assumptions: ['Melee damage adapter; seals must be explicit actions. No automatic blessing.'],
};
