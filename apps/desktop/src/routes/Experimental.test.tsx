import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { FeaturesState } from '@wisp/protocol/features';
import { desktopStore } from '../desktop-controller';
import { FeatureFlags, useFeature } from '../features';
import Experimental from './Experimental';
import Settings from './Settings';

vi.mock('../api', () => ({ native: false, desktop: vi.fn(), bridge: {}, call: vi.fn() }));
afterEach(cleanup);

const initial = desktopStore.getState();
afterEach(() => desktopStore.setState(initial, true));

function show(features: FeaturesState) {
  const setFeature = vi.fn(async () => {});
  act(() =>
    desktopStore.setState({
      loading: false,
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

function open(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/experimental" element={<Experimental />} />
      </Routes>
    </MemoryRouter>,
  );
}

test('Settings has no Experimental entry while the build has no flags', () => {
  show({ channel: 'nightly', flags: [] });
  open('/settings');
  expect(screen.queryByRole('link', { name: 'Open experimental features' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Open diagnostics' })).toBeTruthy();
});

test('Settings links to the Experimental page while there are flags', async () => {
  show({ channel: 'nightly', flags: [flag] });
  open('/settings');
  expect(screen.getByText('1 feature in testing that you can turn on or off.')).toBeTruthy();
  await fireEvent.click(screen.getByRole('link', { name: 'Open experimental features' }));
  expect(screen.getByRole('switch', { name: 'Enable New panel' })).toBeTruthy();
});

test('the Experimental page returns to Settings once no flags are left', () => {
  show({ channel: 'nightly', flags: [] });
  open('/settings/experimental');
  expect(screen.queryByRole('switch', { name: 'Enable New panel' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Open diagnostics' })).toBeTruthy();
});

test('a flag shows its channel default and can be turned off', async () => {
  const setFeature = show({ channel: 'nightly', flags: [flag] });
  open('/settings/experimental');
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
  open('/settings/experimental');
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
