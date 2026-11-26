import type { ClassAdapter } from './types.ts';
export const rogue: ClassAdapter = {
  token: 'ROGUE',
  engineClass: 'ClassRogue',
  spec: 'rogue',
  resource: 'energy',
  families: ['SinisterStrike', 'Eviscerate'],
  melee: true,
  assumptions: ['Full starting energy, zero combo points; no poisons or stealth opener.'],
};
