import type { TestProject } from 'vitest/node';
import type { AgentHost } from '../../src/host/agent-host.ts';
import { startModelBridge } from './model-bridge.ts';

declare module 'vitest' {
  interface ProvidedContext {
    evalBridge: AgentHost & { model: string };
  }
}

export default async function setup(project: TestProject) {
  const { url, token, model, close } = await startModelBridge();
  project.provide('evalBridge', { origin: url, token, model });
  return close;
}
