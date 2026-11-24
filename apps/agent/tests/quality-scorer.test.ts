import { expect, test } from 'vitest';
import { createServer } from 'node:http';
import { grade, judgeModel, qualityScorer, type Run } from '../evals/quality-scorer.ts';

test('the quality grader asks the eval model for structured grades over the eval bridge', async () => {
  const requests: Record<string, any>[] = [];
  const grades = { correctness: 2, fit: 1, usefulness: 2, honesty: 2, clarity: 1, notes: 'Brief.' };
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
    const run: Run = {
      label: 'test',
      name: 'find-upgrades',
      prompt: 'find upgrades for me',
      seconds: 1,
      steps: 2,
      reply: 'Get Spidersilk Boots.',
      presented: [],
      results: [{ tool: 'wow__search_armor', input: {}, output: { items: [] } }],
    };
    const graded = await grade(qualityScorer(judgeModel(origin, 'eval-token', 'gpt-5.4')), run);
    expect(graded).toMatchObject({ ...grades, quality: 0.8 });
    const request = requests.at(-1)!;
    expect(request.url).toBe('/model/responses');
    expect(request.authorization).toBe('Bearer eval-token');
    // Reasoning models get the grading effort, as the raw grader request did.
    expect(request.reasoning).toMatchObject({ effort: 'medium' });
    // The judge sees the scenario's facts, the answer and what the agent read.
    const prompt = JSON.stringify(request.input);
    expect(prompt).toContain('Spidersilk Boots');
    expect(prompt).toContain('wow__search_armor');
    expect(prompt).toContain('Fedrath');
  } finally {
    server.close();
  }
});
