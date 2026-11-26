import type { ClassAdapter } from './types.ts';
export const warlock: ClassAdapter = {
  token: 'WARLOCK',
  engineClass: 'ClassWarlock',
  spec: 'warlock',
  resource: 'mana',
  dots: ['Immolate', 'Corruption'],
  requiredTalents: { Incinerate: 412758 },
  families: ['ShadowBolt', 'Incinerate', 'Immolate', 'Corruption'],
  wand: true,
  options: {
    curseOptions: 'NoCurse',
  },
  assumptions: ['No demon, sacrifice, armor buff or assigned curse.'],
};
