import { Mastra } from '@mastra/core';
import { noopLogger } from '@mastra/core/logger';
import { wisp } from './agents/wisp.ts';

/**
 * Wisp's Mastra instance. The bridge imports it and keeps it quiet; `pnpm
 * --filter @wisp/agent studio` (`mastra dev`, which sets MASTRA_DEV) serves it
 * in Mastra Studio with console logs.
 */
export const mastra = new Mastra({
  agents: { wisp },
  ...(process.env.MASTRA_DEV ? {} : { logger: noopLogger }),
});
