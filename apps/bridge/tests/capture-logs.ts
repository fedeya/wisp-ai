import { onTestFinished, vi } from 'vitest';
import { z } from 'zod';

const logRecord = z.looseObject({});

export function captureLogs() {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  onTestFinished(() => output.mockRestore());
  return (event?: string) =>
    output.mock.calls
      .map(([line]: unknown[]) => {
        if (typeof line !== 'string') throw new Error('Expected a JSON log line');
        return logRecord.parse(JSON.parse(line));
      })
      .filter((log) => event === undefined || log.event === event);
}
