export type DiagnosticsInput = {
  version?: string;
  platform?: string;
  readiness: string;
  serviceReady?: boolean;
  gameConnected?: boolean;
  addonOutdated?: boolean | null;
  connectionError?: string;
  logs: string;
};

/** How many trailing log lines a shared report includes. */
export const reportLogLines = 80;

/**
 * Plain-text summary to paste into an issue or a support message. It holds
 * only app state and the tail of the local log, which the page already warns
 * users to review before sharing.
 */
export function diagnosticsReport(input: DiagnosticsInput): string {
  const yesNo = (value?: boolean | null) =>
    value === undefined || value === null ? 'unknown' : value ? 'yes' : 'no';
  const logTail = input.logs.trim().split(/\r?\n/).slice(-reportLogLines).join('\n');
  return [
    'Wisp diagnostics',
    `Version: ${input.version || 'unknown'}`,
    `Platform: ${input.platform || 'unknown'}`,
    `State: ${input.readiness}`,
    `Wisp service ready: ${yesNo(input.serviceReady)}`,
    `WoW connected: ${yesNo(input.gameConnected)}`,
    `Addon out of date: ${yesNo(input.addonOutdated)}`,
    `Last connection error: ${input.connectionError || 'none'}`,
    '',
    `Last ${reportLogLines} log lines:`,
    logTail || '(no logs loaded)',
  ].join('\n');
}
