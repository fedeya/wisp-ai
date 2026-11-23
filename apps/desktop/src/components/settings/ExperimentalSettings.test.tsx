import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FeaturesState } from '@wisp/protocol/features';
import { desktopStore } from '../../desktop-controller';
import { FeatureFlags, useFeature } from '../../features';
import ExperimentalSettings from './ExperimentalSettings';

vi.mock('../../api', () => ({ native: false, desktop: vi.fn(), bridge: {}, call: vi.fn() }));
afterEach(cleanup);

const initial = desktopStore.getState();
afterEach(() => desktopStore.setState(initial, true));

function show(features: FeaturesState) {
  const setFeature = vi.fn(async () => {});
  act(() =>
    desktopStore.setState({
      busy: '',
      status: { activeTurns: 0, features } as never,
      actions: { ...initial.actions, setFeature },
    }),
  );
  return setFeature;
}
const flag = {
  id: 'new_panel',
  name: 'New panel',
  description: 'A new panel.',
  enabled: true,
  channelDefault: true,
  override: null,
};

test('nothing shows while the build has no experimental features', () => {
  show({ channel: 'nightly', flags: [] });
  const { container } = render(<ExperimentalSettings />);
  expect(container.innerHTML).toBe('');
});

test('a flag shows its channel default and can be turned off', async () => {
  const setFeature = show({ channel: 'nightly', flags: [flag] });
  render(<ExperimentalSettings />);
  expect(screen.getByText('On by default in Nightly')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Use the default for New panel' })).toBeNull();
  const toggle = screen.getByRole('switch', { name: 'Enable New panel' });
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  await fireEvent.click(toggle);
  expect(setFeature).toHaveBeenCalledWith('new_panel', false);
});

test('an overridden flag says so and can return to its default', async () => {
  const setFeature = show({
    channel: 'stable',
    flags: [{ ...flag, channelDefault: false, override: true }],
  });
  render(<ExperimentalSettings />);
  expect(screen.getByText('Changed by you · off by default in Stable')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: 'Use the default for New panel' }));
  expect(setFeature).toHaveBeenCalledWith('new_panel', null);
});

function Probe() {
  return <p>{useFeature('new_panel' as never) ? 'on' : 'off'}</p>;
}

test('useFeature mirrors the value the bridge resolved', async () => {
  show({ channel: 'nightly', flags: [{ ...flag, enabled: false }] });
  render(
    <FeatureFlags>
      <Probe />
    </FeatureFlags>,
  );
  await screen.findByText('off');
  show({ channel: 'nightly', flags: [flag] });
  await screen.findByText('on');
});
