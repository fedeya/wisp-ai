import { afterEach, expect, test, vi } from 'vitest';
import { connectionModel } from '../src/models/connection-model.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

test.each([true, false])(
  'tool availability respects both search service and integration settings (API=%s)',
  async (native) => {
    for (const available of [true, false]) {
      for (const enabled of [true, false]) {
        let body = '';
        vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
          body = String(init?.body);
          throw Error('Captured search tool');
        });
        const model = connectionModel(
          {
            model: 'test',
            effort: 'provider-default',
            webSearchAvailable: available,
            ...(native
              ? {
                  provider: 'compatible' as const,
                  connectionId: '35302f8c-128a-48fb-98a1-9eb03bb71f72',
                  modelId: 'test',
                }
              : {}),
          },
          'http://127.0.0.1:43187',
          'local-token',
          async () => enabled,
        );
        await expect(
          model.doGenerate({
            prompt: [{ role: 'user', content: [{ type: 'text', text: 'Find a guide.' }] }],
            tools: [
              {
                type: 'function',
                name: 'web__web_search',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          }),
        ).rejects.toThrow('Captured search tool');
        expect(body.includes('web__web_search')).toBe(available && enabled);
      }
    }
  },
);
