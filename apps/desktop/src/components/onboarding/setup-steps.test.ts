import { expect, test } from 'vitest';
import { firstScreen, railSteps, stepLabel } from './setup-steps';

test('a new setup starts at welcome and an installed addon skips straight to the AI step', () => {
  expect(firstScreen(false)).toBe('welcome');
  expect(firstScreen(true)).toBe('provider');
});

test('the rail marks earlier screens done and the current one', () => {
  expect(railSteps('provider').map(({ screen, state }) => `${screen}:${state}`)).toEqual([
    'welcome:done',
    'addon:done',
    'provider:current',
    'ready:upcoming',
  ]);
});

test('only the addon and AI steps are numbered', () => {
  expect(stepLabel('welcome')).toBeUndefined();
  expect(stepLabel('addon')).toBe('Step 1 of 2');
  expect(stepLabel('provider')).toBe('Step 2 of 2');
  expect(stepLabel('ready')).toBeUndefined();
});

test('the ready screen shows every rail step with a check', () => {
  expect(railSteps('ready').every(({ complete }) => complete)).toBe(true);
  expect(railSteps('provider').some(({ complete }) => complete)).toBe(false);
});
