import { test, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, open, readFile, rm, mkdir, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'eve/client';
import { appPaths, prepareEngine } from '@wisp/bridge/app-paths';
import { startEveProcess, stopEveProcess } from '@wisp/bridge/agent-process';
import { defaultCapabilities } from '@wisp/protocol/capabilities';
import { newChat } from '@wisp/bridge/chat-lifecycle';
import { applyEvent } from '@wisp/bridge/events';
import { ReplyProjection } from '@wisp/bridge/reply-stream';
import { turnInput } from '@wisp/bridge/context';
import { rebuildHistory } from '../apps/bridge/src/history.ts';
import { replyContent } from '../apps/bridge/src/reply-content.ts';

test(
  'the real Eve agent and AI SDK middleware complete an offline streamed turn',
  { timeout: 100_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wisp-agent-integration-'));
    const engine = path.join(root, 'engine');
    const flags = path.join(root, 'capabilities.json');
    const sourceExecutable = process.env.WISP_TEST_ENGINE_EXECUTABLE;
    const executable = sourceExecutable ? path.join(root, 'wisp-engine.exe') : undefined;
    if (executable) {
      await copyFile(sourceExecutable!, executable);
      await mkdir(engine, { recursive: true });
    } else {
      await prepareEngine(
        process.env.WISP_TEST_AGENT_ROOT || appPaths(process.cwd()).agent,
        engine,
      );
    }
    await writeFile(
      flags,
      JSON.stringify({
        enabled: {
          ...Object.fromEntries(defaultCapabilities().map((capability) => [capability.id, false])),
          'tool:get_settings': true,
          'tool:query_character': true,
        },
      }),
    );
    const requests: Record<string, unknown>[] = [];
    const toolCalls: unknown[] = [];
    const trace: unknown[] = [];
    let activeProjection: ReplyProjection | undefined;
    const text = 'Offline integration passed.';
    const model = createServer(async (req, res) => {
      if (req.url?.startsWith('/session-model?')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            model: 'offline-test',
            effort: 'provider-default',
            contextWindow: 128000,
          }),
        );
        return;
      }
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      if (req.url === '/present') {
        if (req.headers.authorization !== 'Bearer offline-token') {
          res.writeHead(401).end();
          return;
        }
        try {
          const data = JSON.parse(body) as { callId: string; presentation: unknown };
          const accepted = await activeProjection!.acceptPresentation(
            data.callId,
            data.presentation,
            AbortSignal.timeout(10000),
          );
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(accepted));
        } catch (error) {
          res.writeHead(503).end((error as Error).message);
        }
        return;
      }
      if (req.url === '/inspect') {
        if (req.headers.authorization !== 'Bearer offline-token') {
          res.writeHead(401).end();
          return;
        }
        toolCalls.push(JSON.parse(body));
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ status: 'completed', data: { settings: [], verified: true } }));
        return;
      }
      requests.push(JSON.parse(body));
      const count = requests.length;
      const presentation = {
        nodes: [
          {
            id: 'comparison',
            kind: 'comparison',
            unit: 'DPS',
            items: [
              { id: 'a', label: 'A', value: 10 },
              { id: 'b', label: 'B', value: 20 },
            ],
          },
        ],
        references: { nova: { kind: 'spell', id: 122, label: 'Nova' } },
      };
      const plannedCalls: Record<number, { name: string; input: unknown }> = {
        2: { name: 'eve__skill', input: { name: 'settings' } },
        3: { name: 'eve__search', input: { query: 'wow__get_settings' } },
        4: { name: 'eve__tool', input: { name: 'wow__get_settings', input: {} } },
        7: { name: 'eve__skill', input: { name: 'missing-skill' } },
        9: { name: 'eve__tool', input: { name: 'wow__update_settings', input: {} } },
        11: { name: 'wisp__present_ui', input: presentation },
        12: {
          name: 'wisp__present_ui',
          input: { references: { nova: { kind: 'spell', id: 116, label: 'Frostbolt' } } },
        },
        13: {
          name: 'wisp__present_ui',
          input: { references: { frostbolt: { kind: 'spell', id: 116, label: 'Frostbolt' } } },
        },
      };
      const call = plannedCalls[count];
      const output: Record<string, unknown>[] = [];
      const message = (value: string) => ({
        id: 'message-' + count,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: value, annotations: [] }],
      });
      if (count === 11) {
        output.push(message('Antes de la comparación.\n\n~~~text\n[[ref:example]]\n~~~\n\n'));
      }
      if (call) {
        output.push({
          id: 'tool-item-' + count,
          type: 'function_call',
          call_id: 'tool-call-' + count,
          status: 'completed',
          name: call.name,
          arguments: JSON.stringify(call.input),
        });
      } else {
        output.push(message(count === 14 ? '\n\nDespués de la comparación.' : text));
      }
      const events: Record<string, unknown>[] = [
        {
          type: 'response.created',
          response: { id: 'response-' + count, model: 'offline-test', created_at: 1 },
        },
      ];
      for (const [index, item] of output.entries()) {
        events.push({
          type: 'response.output_item.added',
          output_index: index,
          item:
            item.type === 'function_call' ? { ...item, arguments: '' } : { ...item, content: [] },
        });
        if (item.type === 'function_call') {
          events.push({
            type: 'response.function_call_arguments.delta',
            item_id: item.id,
            output_index: index,
            delta: item.arguments,
          });
          events.push({
            type: 'response.function_call_arguments.done',
            item_id: item.id,
            output_index: index,
            arguments: item.arguments,
          });
        } else {
          const value = (item.content as { text: string }[])[0]!.text;
          events.push({
            type: 'response.output_text.delta',
            item_id: item.id,
            output_index: index,
            delta: value,
          });
          events.push({
            type: 'response.output_text.done',
            item_id: item.id,
            output_index: index,
            text: value,
          });
        }
        events.push({ type: 'response.output_item.done', output_index: index, item });
      }
      events.push({
        type: 'response.completed',
        response: {
          id: 'response-' + count,
          model: 'offline-test',
          created_at: 1,
          output,
          usage: { input_tokens: 20, output_tokens: 10 },
        },
      });
      res
        .writeHead(200, { 'content-type': 'text/event-stream' })
        .end(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
    });
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + (model.address() as { port: number }).port;
    const reserved = createServer();
    await new Promise<void>((resolve) => reserved.listen(0, '127.0.0.1', resolve));
    const port = (reserved.address() as { port: number }).port;
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    const log = await open(path.join(root, 'eve.log'), 'a');
    // Override the launch port while keeping the production process setup and environment.
    const start = () =>
      startEveProcess({
        root: engine,
        logFile: log.fd,
        port,
        environment: {
          ...process.env,
          ...(executable
            ? {
                WISP_ENGINE_EXECUTABLE: executable,
                PATH: path.join(process.env.WINDIR || 'C:/Windows', 'System32'),
              }
            : {}),
          NODE_ENV: 'development',
          EVE_MOCK_AUTHORED_MODELS: '0',
          WOW_BRIDGE_TOKEN: 'offline-token',
          WOW_BRIDGE_URL: origin,
          WOW_CAPABILITIES_FILE: flags,
          WOW_MCP_CONFIG: path.join(root, 'mcp.json'),
        },
        onError: () => {},
        onExit: () => {},
      });
    let child = start();
    const client = new Client({
      baseUrl: 'http://127.0.0.1:' + port,
      auth: { bearer: () => 'offline-token' },
    });
    try {
      await vi.waitFor(() => client.health(), { timeout: 75_000, interval: 200 });
      if (executable) {
        await expect(
          new Client({ baseUrl: 'http://127.0.0.1:' + port }).info(),
        ).rejects.toMatchObject({ status: 401 });
      }
      const session = (await client.sessions.create()).session;
      const chat = newChat('offline', 'test');
      const input = turnInput(
        'What quest should I do next?',
        {
          capturedAt: 100,
          sections: {
            quests: {
              status: 'available',
              data: {
                quests: [{ id: 1492, title: 'Ratchet delivery', complete: true, objectives: [] }],
                count: 1,
                truncated: false,
              },
            },
          },
        },
        chat,
      );
      const delivery = await session.send(input, {
        signal: AbortSignal.timeout(15000),
      });
      const projection = new ReplyProjection();
      for await (const event of delivery.stream({ signal: AbortSignal.timeout(15000) })) {
        if (event.type.startsWith('content.')) {
          trace.push(event);
        }
        applyEvent(chat, event, projection);
      }
      projection.flush(chat, Date.now(), true);
      expect((await delivery.result()).status).toBe('completed');
      expect(chat.messages.map((message) => message.text)).toContain('Offline integration passed.');
      expect(requests.length).toBe(1);
      expect(chat.title).toBe('New conversation');
      expect(chat.titleGenerated).not.toBe(true);
      expect(JSON.stringify(requests[0])).not.toContain('Ratchet delivery');
      expect(JSON.stringify(requests[0])).not.toContain('Allowed kinds and fields');
      expect(JSON.stringify(requests[0])).not.toContain('To change a setting:');
      expect((requests[0]!.tools as { name: string }[]).map((tool) => tool.name)).toContain(
        'eve__skill',
      );
      expect((requests[0]!.tools as { name: string }[]).map((tool) => tool.name)).toContain(
        'wisp__present_ui',
      );
      expect(
        requests.every((request) => request.store === false && !('safety_identifier' in request)),
      ).toBe(true);
      const next = await session.send(
        turnInput('Load the settings skill and search its tools', undefined, {
          ...chat,
          titleGenerated: true,
        }),
        { signal: AbortSignal.timeout(15000) },
      );
      for await (const _event of next.stream({ signal: AbortSignal.timeout(15000) })) {
        /* Drain the real tool loop. */
      }
      expect((await next.result()).status).toBe('completed');
      expect(requests).toHaveLength(5);
      const names = (i: number) =>
        (requests[i]!.tools as { name: string }[]).map((tool) => tool.name);
      expect(names(1)).not.toContain('wow__get_settings');
      expect(names(2)).not.toContain('wow__get_settings');
      expect(JSON.stringify(requests[2])).toContain('Settings capabilities:');
      const systemInput = (requests[2]!.input as { role?: string }[]).filter(
        (message) => message.role === 'system' || message.role === 'developer',
      );
      expect(systemInput.length).toBeGreaterThan(0);
      expect(JSON.stringify(systemInput)).not.toContain('To change a setting:');
      expect(JSON.stringify(requests[2])).not.toContain('Allowed kinds and fields');
      const searchOutput = (
        requests[3]!.input as { type?: string; call_id?: string; output?: string }[]
      ).find(
        (item) => item.type === 'function_call_output' && item.call_id === 'tool-call-3',
      )!.output!;
      const searchResults = JSON.parse(searchOutput) as { results: { tool?: string }[] };
      expect(searchResults.results).toContainEqual(
        expect.objectContaining({ tool: 'wow__get_settings' }),
      );
      expect(searchResults.results.map((entry) => entry.tool)).not.toContain(
        'wow__update_settings',
      );
      expect(names(3)).not.toContain('wow__get_settings');
      expect(names(0)).toContain('wow__query_character');
      expect(names(0)).toContain('eve__search');
      expect(names(0)).toContain('eve__tool');
      expect(toolCalls).toEqual([
        expect.objectContaining({ inspection: expect.objectContaining({ kind: 'settings' }) }),
      ]);
      const settingsOutput = (
        requests[4]!.input as { type?: string; call_id?: string; output?: string }[]
      ).find(
        (item) => item.type === 'function_call_output' && item.call_id === 'tool-call-4',
      )!.output!;
      expect(JSON.parse(settingsOutput)).toMatchObject({
        status: 'completed',
        data: { verified: true },
      });
      const followup = await session.send(
        turnInput('Continue', undefined, { ...chat, titleGenerated: true }),
        { signal: AbortSignal.timeout(15000) },
      );
      for await (const _event of followup.stream({ signal: AbortSignal.timeout(15000) })) {
        /* Native skill instructions remain in history across turns. */
      }
      expect((await followup.result()).status).toBe('completed');
      expect(requests).toHaveLength(6);
      expect(JSON.stringify(requests[5])).toContain('Settings capabilities:');
      expect(names(5)).not.toContain('wow__get_settings');
      const missing = await session.send(
        turnInput('Load a missing skill', undefined, { ...chat, titleGenerated: true }),
        { signal: AbortSignal.timeout(15000) },
      );
      for await (const _event of missing.stream({ signal: AbortSignal.timeout(15000) })) {
        /* A failed activation must not enable any tool schemas. */
      }
      expect((await missing.result()).status).toBe('completed');
      expect(requests).toHaveLength(8);
      expect(JSON.stringify(requests[7])).toContain('No skill named');
      const blocked = await session.send(
        turnInput('Try a disabled tool', undefined, { ...chat, titleGenerated: true }),
        { signal: AbortSignal.timeout(15000) },
      );
      for await (const _event of blocked.stream({ signal: AbortSignal.timeout(15000) })) {
        /* Dynamic capability definitions reject a direct native call too. */
      }
      expect((await blocked.result()).status).toBe('completed');
      expect(requests).toHaveLength(10);
      expect(JSON.stringify(requests[9])).toContain('No tool named');
      expect(toolCalls).toHaveLength(1);
      const richInput = turnInput('Mostrá una comparación entre dos párrafos', undefined, {
        ...chat,
        titleGenerated: true,
      });
      chat.messages.push({
        id: 'rich-user',
        role: 'user',
        text: 'Mostrá una comparación entre dos párrafos',
      });
      const richProjection = new ReplyProjection();
      activeProjection = richProjection;
      const rich = await session.send(richInput, { signal: AbortSignal.timeout(15000) });
      const richEvents: { type: string; data: Record<string, unknown> }[] = [];
      for await (const event of rich.stream({ signal: AbortSignal.timeout(15000) })) {
        richEvents.push({ type: event.type, data: { ...event.data } });
        trace.push(event);
        applyEvent(chat, event, richProjection);
      }
      richProjection.finish();
      richProjection.flush(chat, Date.now(), true);
      expect((await rich.result()).status).toBe('completed');
      expect(requests).toHaveLength(14);
      expect(names(0)).toContain('wisp__present_ui');
      expect(names(10)).toContain('wisp__present_ui');
      const reply = chat.messages.at(-1)!;
      expect(reply.parts).toEqual([
        { type: 'text', text: 'Antes de la comparación.\n\n~~~text\n[[ref:example]]\n~~~\n\n' },
        { type: 'ui', id: 'comparison' },
        { type: 'text', text: '\n\nDespués de la comparación.' },
      ]);
      expect(reply.ui?.[0].kind).toBe('comparison');
      expect(replyContent(reply)?.text).toContain('~~~text\n[[ref:example]]\n~~~');
      expect(reply.references).toMatchObject({ nova: { id: 122 }, frostbolt: { id: 116 } });
      expect(chat.activity.some((entry) => entry.name === 'wisp__present_ui')).toBe(false);
      expect(chat.messages.some((entry) => entry.tool?.name === 'wisp__present_ui')).toBe(false);
      const richMessages = chat.messages.slice(
        chat.messages.findIndex((message) => message.id === 'rich-user'),
      );
      const restored = rebuildHistory({ ...chat, messages: richMessages }, richEvents);
      expect(restored?.at(-1) && replyContent(restored.at(-1)!)).toEqual(replyContent(reply));
      const continuation = JSON.stringify(requests[11]);
      expect(continuation).toContain('accepted');
      const uiAcknowledgement = (requests[11]!.input as Record<string, unknown>[]).find(
        (item) => item.type === 'function_call_output' && item.call_id === 'tool-call-11',
      );
      expect(JSON.parse(String(uiAcknowledgement?.output))).toEqual({ accepted: true });
      const uiRejection = (requests[12]!.input as Record<string, unknown>[]).find(
        (item) => item.type === 'function_call_output' && item.call_id === 'tool-call-12',
      );
      expect(String(uiRejection?.output)).toContain('already identifies something else');
      const repairedAcknowledgement = (requests[13]!.input as Record<string, unknown>[]).find(
        (item) => item.type === 'function_call_output' && item.call_id === 'tool-call-13',
      );
      expect(JSON.parse(String(repairedAcknowledgement?.output))).toEqual({ accepted: true });

      if (executable) {
        await stopEveProcess(child);
        child = start();
        await vi.waitFor(() => client.health(), { timeout: 15_000, interval: 200 });
        expect(JSON.stringify(await session.snapshot())).toContain('Offline integration passed.');
        expect(
          (await readdir(root, { recursive: true })).some((entry) =>
            entry.split(/[\\/]/).includes('node_modules'),
          ),
        ).toBe(false);
      }
    } catch (error) {
      throw new Error(
        'Offline agent integration failed: ' +
          JSON.stringify(trace) +
          '\nModel tools: ' +
          JSON.stringify(
            requests.map((request) =>
              (request.tools as { name?: string }[] | undefined)?.map((tool) => tool.name),
            ),
          ) +
          '\n' +
          (await readFile(path.join(root, 'eve.log'), 'utf8')),
        { cause: error },
      );
    } finally {
      await stopEveProcess(child);
      await log.close();
      await new Promise<void>((resolve) => model.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);
