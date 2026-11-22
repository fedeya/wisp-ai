import { defineEvalConfig } from 'eve/evals';
import { startFakeBridge } from './fake-bridge.ts';

export default defineEvalConfig({
  timeoutMs: 300_000,
  maxConcurrency: 2,
  async setup() {
    return { bridge: await startFakeBridge() };
  },
  async teardown(context) {
    await context?.bridge.close();
  },
});
