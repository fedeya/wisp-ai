import posthog from 'posthog-js';

// Public ingestion token, shared with the desktop project. Never use a personal API key here.
const projectToken =
  process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ||
  'phc_se29yi8DLMmFxhRcqQrzrSs9vGLzAiEGmsaMvjotDdTE';
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';
let initialized = false;

export type DownloadDetails = {
  location: 'header' | 'hero' | 'home-footer' | 'setup' | 'changelog' | 'release';
  locale: string;
  version?: string;
  channel?: 'stable' | 'nightly';
};

export function initializeAnalytics() {
  if (initialized) {
    return;
  }
  try {
    posthog.init(projectToken, {
      api_host: host,
      defaults: '2025-05-24',
      capture_pageview: 'history_change',
      capture_pageleave: true,
      autocapture: false,
      capture_dead_clicks: false,
      rageclick: false,
      disable_session_recording: true,
      capture_exceptions: false,
      capture_heatmaps: false,
      capture_performance: false,
      disable_surveys: true,
      person_profiles: 'identified_only',
      persistence: 'localStorage',
      loaded: (client) => client.register({ surface: 'web' }),
    });
    initialized = true;
  } catch {
    // Analytics must never interrupt the page or its download links.
  }
}

export function trackDownload(details: DownloadDetails) {
  if (!initialized) {
    return;
  }
  try {
    posthog.capture(
      'download_clicked',
      { surface: 'web', platform: 'windows-x64', channel: 'stable', ...details },
      { transport: 'sendBeacon' },
    );
  } catch {
    // Navigation remains native even if tracking is unavailable.
  }
}
