import { defineEvalConfig } from 'eve/evals';
import { startModelBridge } from './model-bridge.ts';

export default defineEvalConfig({
  timeoutMs: 300_000,
  maxConcurrency: 2,
  async setup() {
    return { bridge: await startModelBridge() };
  },
  async teardown(context) {
    await context?.bridge.close();
  },
});
