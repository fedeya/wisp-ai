import type { ClassAdapter } from './types.ts';
export const priest: ClassAdapter = {
  token: 'PRIEST',
  engineClass: 'ClassPriest',
  spec: 'dpsPriest',
  resource: 'mana',
  dots: ['ShadowWordPain'],
  families: ['Smite', 'MindBlast', 'ShadowWordPain'],
  wand: true,
  assumptions: ['Damage only; no healing, Shadowform or external buffs.'],
};
