import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ init: vi.fn(), capture: vi.fn() }));
vi.mock('posthog-js', () => ({ default: sdk }));

beforeEach(() => {
  vi.resetModules();
  sdk.init.mockReset();
  sdk.capture.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

test('download tracking is inactive until the production layout initializes it', async () => {
  const { trackDownload } = await import('../src/analytics.ts');
  trackDownload({ location: 'header', locale: 'es' });
  expect(sdk.init).not.toHaveBeenCalled();
  expect(sdk.capture).not.toHaveBeenCalled();
});

test('download events include release attribution and survive navigation using a beacon', async () => {
  const { initializeAnalytics, trackDownload } = await import('../src/analytics.ts');
  initializeAnalytics();
  initializeAnalytics();
  expect(sdk.init).toHaveBeenCalledTimes(1);
  trackDownload({
    location: 'changelog',
    locale: 'es',
    version: '0.1.1-nightly.53.1',
    channel: 'nightly',
  });
  expect(sdk.capture).toHaveBeenCalledWith(
    'download_clicked',
    {
      surface: 'web',
      platform: 'windows-x64',
      location: 'changelog',
      locale: 'es',
      version: '0.1.1-nightly.53.1',
      channel: 'nightly',
    },
    { transport: 'sendBeacon' },
  );
});

test('SDK failures cannot prevent rendering or downloads and initialization can retry', async () => {
  const { initializeAnalytics, trackDownload } = await import('../src/analytics.ts');
  sdk.init.mockImplementationOnce(() => {
    throw new Error('blocked');
  });
  expect(initializeAnalytics).not.toThrow();
  trackDownload({ location: 'hero', locale: 'en' });
  expect(sdk.capture).not.toHaveBeenCalled();
  initializeAnalytics();
  sdk.capture.mockImplementationOnce(() => {
    throw new Error('offline');
  });
  expect(() => trackDownload({ location: 'hero', locale: 'en' })).not.toThrow();
});

test('deployments can override the public project token and region', async () => {
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test');
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://eu.i.posthog.com');
  const { initializeAnalytics } = await import('../src/analytics.ts');
  initializeAnalytics();
  expect(sdk.init).toHaveBeenCalledWith(
    'phc_test',
    expect.objectContaining({ api_host: 'https://eu.i.posthog.com' }),
  );
});
