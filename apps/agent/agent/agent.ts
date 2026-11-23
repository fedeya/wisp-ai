import { createHash } from 'node:crypto';
import { selectedModel } from '@wisp/protocol/agent-rpc';
import { bridgeOrigin } from '@wisp/agent/agent-rpc';
import { defineAgent, defineDynamic } from 'eve';
import { connectionModel } from '@wisp/agent/connection-model';
import { capabilityEnabled } from '@wisp/agent/capabilities';
import { COMPACTION_THRESHOLD } from '@wisp/protocol/context-usage';
// Only the bridge owns account credentials; Eve receives a loopback token.
const origin = bridgeOrigin();
export default defineAgent({
  model: defineDynamic(async (ctx) => {
    const response = await fetch(
      origin + '/session-model?session=' + encodeURIComponent(ctx.session.id),
      {
        headers: { authorization: 'Bearer ' + process.env.WOW_BRIDGE_TOKEN },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) {
      throw Error('Could not load model settings for this conversation.');
    }
    const selected = selectedModel.parse(await response.json());
    const openai: Record<string, string> =
      selected.provider || selected.effort === 'provider-default'
        ? {}
        : { reasoningEffort: selected.effort };
    return {
      model: connectionModel(
        selected,
        origin,
        process.env.WOW_BRIDGE_TOKEN!,
        () => capabilityEnabled('tool:web_search'),
        // A stable per-conversation key keeps the tool loop on one prompt cache.
        'wisp-' + createHash('sha256').update(ctx.session.id).digest('hex').slice(0, 32),
        ctx.session.id,
      ),
      reasoning: 'provider-default' as const,
      modelContextWindowTokens: selected.contextWindow,
      modelOptions: {
        providerOptions: {
          openai,
        },
      },
    };
  }),
  defaultTools: false,
  // Native TLS client must be traced and shipped, rather than bundled as JS.
  build: { externalDependencies: ['impit'] },
  compaction: { threshold: COMPACTION_THRESHOLD },
});
