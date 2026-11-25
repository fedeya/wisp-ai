import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setAgentHost } from '@wisp/agent/agent-host';
import { createAgentEngine, type TurnInput } from '@wisp/agent/engine';
import { MemoryHistory } from '@wisp/agent/memory-history';
import { defaultCapabilities } from '@wisp/protocol/capabilities';
import { newChat } from '@wisp/bridge/chat-lifecycle';
import { applyEvent } from '@wisp/bridge/events';
import { ReplyProjection } from '@wisp/bridge/reply-stream';
import { turnInput } from '@wisp/bridge/context';
import { rebuildHistory } from '../apps/bridge/src/chat/history.ts';
import { replyContent } from '../apps/bridge/src/reply/reply-content.ts';

type Item = Record<string, unknown>;

test(
  'the in-process agent and AI SDK middleware complete offline streamed turns',
  { timeout: 100_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wisp-agent-integration-'));
    const flags = path.join(root, 'capabilities.json');
    await writeFile(
      flags,
      JSON.stringify({
        enabled: {
          ...Object.fromEntries(defaultCapabilities().map((capability) => [capability.id, false])),
          'tool:get_settings': true,
          'tool:get_quest': true,
          'tool:query_character': true,
        },
      }),
    );
    const requests: Item[] = [];
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
      if (req.headers.authorization !== 'Bearer offline-token') {
        res.writeHead(401).end();
        return;
      }
      if (req.url === '/present') {
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
        const request = JSON.parse(body);
        toolCalls.push(request);
        const result =
          request.inspection.kind === 'questie_quest'
            ? {
                status: 'available',
                data: {
                  status: 'available',
                  questId: 166,
                  data: { name: 'The Defias Brotherhood' },
                  reference: { kind: 'quest', id: 166 },
                },
              }
            : { status: 'completed', data: { settings: [], verified: true } };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
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
        2: { name: 'skill', input: { name: 'settings' } },
        3: { name: 'tool_search', input: { query: 'wow__get_settings' } },
        4: { name: 'tool_call', input: { name: 'wow__get_settings', input: {} } },
        7: { name: 'skill', input: { name: 'missing-skill' } },
        9: { name: 'tool_call', input: { name: 'wow__update_settings', input: {} } },
        11: { name: 'wisp__present_ui', input: presentation },
        12: {
          name: 'wisp__present_ui',
          input: { references: { nova: { kind: 'spell', id: 116, label: 'Frostbolt' } } },
        },
        13: {
          name: 'wisp__present_ui',
          input: { references: { frostbolt: { kind: 'spell', id: 116, label: 'Frostbolt' } } },
        },
        15: { name: 'tool_call', input: { name: 'questie__get_quest', input: { questId: 166 } } },
      };
      const call = plannedCalls[count];
      const output: Item[] = [];
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
      const events: Item[] = [
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
    setAgentHost({ origin, token: 'offline-token', capabilitiesFile: flags });
    const history = new MemoryHistory();
    const engine = createAgentEngine({
      origin: () => origin,
      token: 'offline-token',
      history,
      logger: { info: () => {}, warn: () => {} },
    });
    const session = engine.newSessionId();
    const send = (input: TurnInput) =>
      engine.send(session, input, AbortSignal.timeout(15000), 'chat');
    const names = (i: number) =>
      (requests[i]!.tools as { name: string }[]).map((tool) => tool.name);
    const output = (i: number, callId: string) =>
      (requests[i]!.input as { type?: string; call_id?: string; output?: unknown }[]).find(
        (item) => item.type === 'function_call_output' && item.call_id === callId,
      )?.output;
    try {
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
      const first = send(input);
      const projection = new ReplyProjection();
      for await (const event of first.events) {
        if (event.type.startsWith('content.')) {
          trace.push(event);
        }
        applyEvent(chat, event, projection);
      }
      projection.flush(chat, Date.now(), true);
      expect((await first.result).status).toBe('completed');
      expect(chat.messages.map((message) => message.text)).toContain(text);
      expect(requests).toHaveLength(1);
      expect(chat.title).toBe('New conversation');
      expect(chat.titleGenerated).not.toBe(true);
      expect(JSON.stringify(requests[0])).not.toContain('Ratchet delivery');
      expect(JSON.stringify(requests[0])).not.toContain('Allowed kinds and fields');
      expect(JSON.stringify(requests[0])).not.toContain('To change a setting:');
      for (const tool of [
        'skill',
        'tool_search',
        'tool_call',
        'wisp__present_ui',
        'wow__query_character',
      ]) {
        expect(names(0)).toContain(tool);
      }
      expect(
        requests.every((request) => request.store === false && !('safety_identifier' in request)),
      ).toBe(true);

      const next = send(
        turnInput('Load the settings skill and search its tools', undefined, {
          ...chat,
          titleGenerated: true,
        }),
      );
      const settingsChat = newChat('settings', 'test');
      const settingsProjection = new ReplyProjection();
      let settingsRunningLabel: string | undefined;
      for await (const event of next.events) {
        applyEvent(settingsChat, event, settingsProjection);
        const tool = settingsChat.activity.find((entry) => entry.name === 'wow__get_settings');
        if (tool?.status === 'running') {
          settingsRunningLabel = tool.label;
        }
      }
      expect((await next.result).status).toBe('completed');
      expect(settingsRunningLabel).toBe('Reading settings');
      expect(
        settingsChat.messages.find((entry) => entry.tool?.name === 'wow__get_settings'),
      ).toMatchObject({ text: 'Read settings', tool: { status: 'completed' } });
      // Meta tools are not player-facing activity.
      expect(settingsChat.activity.map((entry) => entry.name)).toEqual(['wow__get_settings']);
      expect(requests).toHaveLength(5);
      // The skill arrives as a tool result, never as system instructions.
      expect(JSON.stringify(requests[2])).toContain('Settings capabilities:');
      const systemInput = (requests[2]!.input as { role?: string }[]).filter(
        (message) => message.role === 'system' || message.role === 'developer',
      );
      expect(systemInput.length).toBeGreaterThan(0);
      expect(JSON.stringify(systemInput)).not.toContain('To change a setting:');
      const searchResults = JSON.parse(String(output(3, 'tool-call-3'))) as {
        results: { name?: string }[];
      };
      expect(searchResults.results.map((entry) => entry.name)).toContain('wow__get_settings');
      // A disabled capability is neither searchable nor callable.
      expect(searchResults.results.map((entry) => entry.name)).not.toContain(
        'wow__update_settings',
      );
      // The request's tool list never changes, so the provider can reuse its cache.
      for (let i = 1; i < 5; i++) {
        expect(names(i)).toEqual(names(0));
      }
      expect(names(4)).not.toContain('wow__get_settings');
      expect(toolCalls).toEqual([
        expect.objectContaining({ inspection: expect.objectContaining({ kind: 'settings' }) }),
      ]);
      expect(JSON.parse(String(output(4, 'tool-call-4')))).toMatchObject({
        status: 'completed',
        data: { verified: true },
      });

      const followup = send(turnInput('Continue', undefined, { ...chat, titleGenerated: true }));
      for await (const _event of followup.events) {
        /* Skill instructions remain in history across turns. */
      }
      expect((await followup.result).status).toBe('completed');
      expect(requests).toHaveLength(6);
      expect(JSON.stringify(requests[5])).toContain('Settings capabilities:');

      const missing = send(
        turnInput('Load a missing skill', undefined, { ...chat, titleGenerated: true }),
      );
      for await (const _event of missing.events) {
        /* A failed activation enables nothing. */
      }
      expect((await missing.result).status).toBe('completed');
      expect(requests).toHaveLength(8);
      expect(String(output(7, 'tool-call-7'))).toContain('"missing-skill" not found');

      const blocked = send(
        turnInput('Try a disabled tool', undefined, { ...chat, titleGenerated: true }),
      );
      for await (const _event of blocked.events) {
        /* Capability switches reject a direct deferred call too. */
      }
      expect((await blocked.result).status).toBe('completed');
      expect(requests).toHaveLength(10);
      expect(String(output(9, 'tool-call-9'))).toContain('Unknown or disabled tool');
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
      const rich = send(richInput);
      const richEvents: { type: string; data: Record<string, unknown> }[] = [];
      for await (const event of rich.events) {
        richEvents.push({ type: event.type, data: { ...event.data } });
        trace.push(event);
        applyEvent(chat, event, richProjection);
      }
      richProjection.finish();
      richProjection.flush(chat, Date.now(), true);
      expect((await rich.result).status).toBe('completed');
      expect(requests).toHaveLength(14);
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
      // The model sees an acknowledgement, not another copy of the panel.
      expect(JSON.parse(String(output(11, 'tool-call-11')))).toEqual({ accepted: true });
      expect(String(output(12, 'tool-call-12'))).toContain('already identifies something else');
      expect(JSON.parse(String(output(13, 'tool-call-13')))).toEqual({ accepted: true });

      const questChat = newChat('quest', 'test');
      const questProjection = new ReplyProjection();
      const questLookup = send(
        turnInput('Read the details for quest 166', undefined, {
          ...questChat,
          titleGenerated: true,
        }),
      );
      let runningLabel: string | undefined;
      for await (const event of questLookup.events) {
        applyEvent(questChat, event, questProjection);
        const tool = questChat.activity.find((entry) => entry.name === 'questie__get_quest');
        if (tool?.status === 'running') {
          runningLabel = tool.label;
        }
      }
      expect((await questLookup.result).status).toBe('completed');
      expect(runningLabel).toBe('Reading details for quest #166');
      expect(
        questChat.messages.find((entry) => entry.tool?.name === 'questie__get_quest'),
      ).toMatchObject({
        text: 'Read quest details for “The Defias Brotherhood”',
        tool: {
          inputPreview: '{"questId":166}',
          resultPreview: expect.stringContaining('The Defias Brotherhood'),
        },
      });
      // Every turn's model history persists for the next one.
      expect(JSON.stringify(history.entries(session))).toContain(text);
    } catch (error) {
      throw new Error(
        'Offline agent integration failed: ' +
          JSON.stringify(trace) +
          '\nModel tools: ' +
          JSON.stringify(
            requests.map((request) =>
              (request.tools as { name?: string }[] | undefined)?.map((tool) => tool.name),
            ),
          ),
        { cause: error },
      );
    } finally {
      setAgentHost(undefined);
      await engine.close();
      await new Promise<void>((resolve) => model.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);
