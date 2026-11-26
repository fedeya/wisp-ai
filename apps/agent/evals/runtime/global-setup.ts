import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import type { AgentHost } from '../../src/host/agent-host.ts';
import { itemSourcesFixture } from '../fixtures/fedrath.ts';
import { startModelBridge } from './model-bridge.ts';

declare module 'vitest' {
  interface ProvidedContext {
    evalBridge: AgentHost & { model: string };
  }
}

export default async function setup(project: TestProject) {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-evals-'));
  const sources = path.join(directory, 'item-sources.json');
  try {
    await writeFile(sources, JSON.stringify(itemSourcesFixture()));
    const { url, token, model, close } = await startModelBridge({
      WISP_EVAL_ITEM_SOURCES: sources,
    });
    project.provide('evalBridge', { origin: url, token, model });
    return async () => {
      try {
        await close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
