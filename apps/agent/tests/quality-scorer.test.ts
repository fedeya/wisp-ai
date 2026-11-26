import { expect, test } from 'vitest';
import { createServer } from 'node:http';
import {
  judgeAnswer,
  judgeInstructions,
  judgeModel,
  qualityPrompt,
} from '../evals/judges/quality-scorer.ts';
import { judges } from '../evals/judges/binary-judges.ts';

test('a judge asks the eval model for a structured verdict over the eval bridge', async () => {
  const requests: Record<string, any>[] = [];
  const grades = { critique: 'The boots come from the search results.', result: 'Pass' };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    requests.push({ url: req.url, authorization: req.headers.authorization, ...JSON.parse(body) });
    const item = {
      id: 'message',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify(grades), annotations: [] }],
    };
    const response = {
      id: 'response',
      model: 'judge',
      created_at: 1,
      output: [item],
      usage: { input_tokens: 5, output_tokens: 5 },
    };
    if (!JSON.parse(body).stream) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
      return;
    }
    const events = [
      { type: 'response.created', response: { ...response, output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      {
        type: 'response.output_text.delta',
        item_id: 'message',
        output_index: 0,
        delta: JSON.stringify(grades),
      },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ];
    res
      .writeHead(200, { 'content-type': 'text/event-stream' })
      .end(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  try {
    const { output } = await judgeAnswer(
      judgeModel(origin, 'eval-token', 'gpt-5.4'),
      judgeInstructions(judges['unsupported-claim']),
      qualityPrompt('find-upgrades', 'find upgrades for me', 'Get Spidersilk Boots.', [
        { name: 'wow__search_armor', arguments: {}, status: 'ok', result: { items: [] } },
      ]),
      AbortSignal.timeout(5000),
    );
    expect(output).toEqual(grades);
    const request = requests.at(-1)!;
    expect(request.url).toBe('/model/responses');
    expect(request.authorization).toBe('Bearer eval-token');
    // Reasoning models get the grading effort, as the raw grader request did.
    expect(request.reasoning).toMatchObject({ effort: 'medium' });
    // The judge sees its criterion, the scenario's facts, the answer and what the agent read.
    const prompt = JSON.stringify(request.input);
    expect(prompt).toContain('Spidersilk Boots');
    expect(prompt).toContain('wow__search_armor');
    expect(prompt).toContain('Fedrath');
    expect(JSON.stringify(request.instructions ?? request.input)).toContain('Criterion');
  } finally {
    server.close();
  }
});
