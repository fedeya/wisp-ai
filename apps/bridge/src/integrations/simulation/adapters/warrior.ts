import type { ClassAdapter } from './types.ts';
export const warrior: ClassAdapter = {
  token: 'WARRIOR',
  engineClass: 'ClassWarrior',
  spec: 'dpsWarrior',
  resource: 'rage',
  areaRanges: { ThunderClap: 10 },
  dots: ['Rend'],
  families: ['HeroicStrike', 'Rend', 'Slam', 'ThunderClap', 'Bloodrage'],
  melee: true,
  options: {
    defaultStance: 'WarriorStanceBattle',
    startingRage: 0,
  },
  assumptions: ['Battle Stance; zero starting rage; no incoming attacks.'],
};
