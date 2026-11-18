import { expect, test } from 'vitest';
import { diagnosticsReport, reportLogLines } from './diagnostics-report';

test('the report summarizes the app state and ends with the log tail', () => {
  const logs = Array.from({ length: reportLogLines + 5 }, (_, index) => `line ${index}`).join('\n');
  const report = diagnosticsReport({
    version: '0.2.1',
    platform: 'windows',
    readiness: 'waiting',
    serviceReady: true,
    gameConnected: false,
    addonOutdated: false,
    connectionError: 'Bridge timed out',
    logs,
  });
  expect(report).toContain('Version: 0.2.1');
  expect(report).toContain('State: waiting');
  expect(report).toContain('Wisp service ready: yes');
  expect(report).toContain('WoW connected: no');
  expect(report).toContain('Last connection error: Bridge timed out');
  expect(report).not.toContain('line 4\n');
  expect(report).toContain('line 5\n');
  expect(report.endsWith(`line ${reportLogLines + 4}`)).toBe(true);
});

test('missing values read as unknown instead of breaking the report', () => {
  const report = diagnosticsReport({ readiness: 'unavailable', logs: '' });
  expect(report).toContain('Version: unknown');
  expect(report).toContain('Wisp service ready: unknown');
  expect(report).toContain('Last connection error: none');
  expect(report).toContain('(no logs loaded)');
});
