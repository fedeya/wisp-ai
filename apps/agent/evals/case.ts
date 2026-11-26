import { inject } from 'vitest';
import { createJudge, describeEval } from 'vitest-evals';
import { setAgentHost } from '../src/host/agent-host.ts';
import { turnView } from './checks.ts';
import type { Check } from './checks.ts';
import { wispHarness } from './harness.ts';
import type { WispInput } from './harness.ts';
import { judgeModel, scoreQuality } from './quality-scorer.ts';

interface WispCase extends WispInput {
  description: string;
  tags: string[];
  gates: Check[];
  scorers?: Check[];
}

export function wispEval(name: string, { description, tags, gates, scorers, ...input }: WispCase) {
  describeEval(name, { harness: wispHarness }, (it) => {
    it(description, { tags }, async ({ expect, run, signal }) => {
      const bridge = inject('evalBridge');
      setAgentHost(bridge);
      try {
        const result = await run(input);
        expect(result.errors ?? []).toEqual([]);
        const turn = turnView(result);
        for (const gate of gates) {
          expect.soft(gate.test(turn), gate.name).toBe(true);
        }
        for (const scorer of scorers ?? []) {
          const judge = createJudge(scorer.name, () => ({ score: scorer.test(turn) ? 1 : 0 }));
          await expect(result).toSatisfyJudge(judge, { threshold: null });
        }
        if (process.env.WISP_EVAL_GRADE === '1') {
          const model = judgeModel(
            bridge.origin,
            bridge.token,
            process.env.WISP_GRADE_MODEL || bridge.model,
          );
          const judge = createJudge('Answer quality', async () => {
            const { quality, notes, ...scores } = await scoreQuality(
              model,
              name,
              input.question,
              turn,
              signal,
            );
            return { score: quality, metadata: { rationale: notes, output: scores } };
          });
          await expect(result).toSatisfyJudge(judge, { threshold: null });
        }
      } finally {
        setAgentHost(undefined);
      }
    });
  });
}
