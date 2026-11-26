import type { ClassAdapter } from './types.ts';
export const hunter: ClassAdapter = {
  token: 'HUNTER',
  engineClass: 'ClassHunter',
  spec: 'hunter',
  resource: 'mana',
  requiresRangedAuto: true,
  dots: ['SerpentSting'],
  families: [
    'ArcaneShot',
    'MultiShot',
    'SerpentSting',
    'HuntersMark',
    'AspectOfTheHawk',
    'RapidFire',
  ],
  assumptions: [
    'Ranged auto attacks; no pet, ammunition bonus or quiver bonus. These readings are not available.',
  ],
};
