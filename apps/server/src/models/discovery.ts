// @effect-migrated
import { Effect, Option, Schema } from 'effect';
import {
  contextWindow,
  discoveredConnectionModel,
  reasoningEffort,
} from '@wisp/protocol/providers';
import type { DiscoveredConnectionModel, ProviderId } from '@wisp/protocol/providers';
import { modelReasoningEfforts } from '@wisp/agent/reasoning';
import { modelToolSupport } from '@wisp/agent/tool-support';
import { modelContextWindow } from '@wisp/agent/context-windows';

/**
 * An optional field that is dropped, rather than rejected, when it is not a
 * `schema`. Model lists were read field by field before, ignoring a field of
 * an unexpected type, and still are.
 */
const lenient = <S extends Schema.Top>(schema: S) =>
  Schema.optional(schema.pipe(Schema.catchDecoding(() => Effect.succeedNone)));

const values = lenient(Schema.Array(Schema.Unknown));
const text = lenient(Schema.String);
/** A size field is kept as sent: the first one present decides, even when it is not a size. */
const size = Schema.optional(Schema.Unknown);

/** The fields of a listed model that discovery reads, across the providers' formats. */
const ListedModel = Schema.Struct({
  id: text,
  name: text,
  type: text,
  display_name: text,
  displayName: text,
  // OpenRouter and other OpenAI-style aggregators.
  supported_parameters: values,
  tags: values,
  // Mistral.
  capabilities: lenient(Schema.Struct({ function_calling: lenient(Schema.Boolean) })),
  // Cohere.
  features: values,
  // Fireworks.
  supports_tools: lenient(Schema.Boolean),
  supportsTools: lenient(Schema.Boolean),
  // Google.
  supportedGenerationMethods: values,
  context_window: size,
  context_length: size,
  inputTokenLimit: size,
  max_input_tokens: size,
  max_context_length: size,
  contextWindow: size,
  // Vercel AI Gateway.
  reasoning_options: values,
});
type ListedModel = typeof ListedModel.Type;
const decodeListed = Schema.decodeUnknownOption(ListedModel);

/** A provider answers with `{ data }`, `{ models }` or, like Together, a bare array. */
const ModelList = Schema.Struct({ data: values, models: values });
const decodeRows = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));
const decodeList = Schema.decodeUnknownOption(ModelList);

const EffortOption = Schema.Struct({ type: text, values });
const decodeEffortOption = Schema.decodeUnknownOption(EffortOption);
const decodeDiscovered = Schema.decodeUnknownOption(discoveredConnectionModel);
const decodeContextWindow = Schema.decodeUnknownOption(contextWindow);
const isReasoningEffort = Schema.is(reasoningEffort);

const toolCallingChatProviders = new Set<ProviderId>([
  'xai',
  'groq',
  'cerebras',
  'togetherai',
  'deepinfra',
  'alibaba',
  'moonshotai',
  'minimax',
  'baseten',
  'zai',
]);
const nonChatModel =
  /embed|bge-|whisper|tts|speech|transcri|audio|orpheus|image|imagine|video|dall-e|flux|stable-diffusion|sdxl|guard|moderation|rerank|paraformer|cogview|cogvideo|wan\d|ocr|compound/i;

/**
 * Whether a discovered model accepts function tools: true or false when the
 * provider's model list, the pinned SDK catalog or what the provider serves
 * says so, otherwise undefined. Discovery only offers models marked true, so
 * every provider needs an answer here or its catalog shows nothing.
 */
function discoveredToolSupport(
  provider: ProviderId,
  id: string,
  m: ListedModel,
  officialEndpoint: boolean,
): boolean | undefined {
  // OpenRouter and other OpenAI-style aggregators.
  if (m.supported_parameters !== undefined) {
    return m.supported_parameters.includes('tools');
  }
  if (provider === 'gateway' && m.tags?.includes('tool-use')) {
    return true;
  }
  // Mistral.
  if (m.capabilities?.function_calling !== undefined) {
    return m.capabilities.function_calling;
  }
  // Cohere.
  if (m.features !== undefined) {
    return m.features.includes('tools');
  }
  // Fireworks.
  const fireworks = m.supports_tools ?? m.supportsTools;
  if (fireworks !== undefined) {
    return fireworks;
  }
  // These official endpoints list only chat models, and all of them call tools.
  if (officialEndpoint && (provider === 'anthropic' || provider === 'deepseek')) {
    return true;
  }
  // Together tags each model with what it does; only chat models take tools.
  if (provider === 'togetherai' && officialEndpoint && m.type !== undefined) {
    return m.type === 'chat';
  }
  // These lists say nothing about tools. Their chat models all call tools, so
  // only the speech, image, embedding and safety models listed beside them are
  // left out. A local server is the player's own choice of models.
  if ((officialEndpoint && toolCallingChatProviders.has(provider)) || provider === 'compatible') {
    return !nonChatModel.test(id);
  }
  return modelToolSupport(provider, id);
}

/** The display name a model list gives a model, when it is a usable one. */
const displayName = (m: ListedModel) =>
  [m.display_name, m.displayName, m.name].find(
    (name): name is string =>
      name !== undefined && name.trim().length > 0 && name.trim().length <= 200,
  );

/** The reasoning efforts the Gateway advertises for a model, in its own order. */
const advertisedEfforts = (m: ListedModel) =>
  (m.reasoning_options ?? [])
    .flatMap((option) =>
      Option.match(decodeEffortOption(option), {
        onNone: () => [],
        onSome: ({ type, values }) => (type === 'effort' && values !== undefined ? values : []),
      }),
    )
    .filter(isReasoningEffort);

function discoveredModel(
  provider: ProviderId,
  m: ListedModel,
  officialEndpoint: boolean,
): Option.Option<DiscoveredConnectionModel> {
  if (provider === 'gateway' && m.type !== undefined && m.type !== 'language') {
    return Option.none();
  }
  const id = m.id ?? m.name?.replace(/^models\//, '');
  if (!id) {
    return Option.none();
  }
  if (
    provider === 'google' &&
    m.supportedGenerationMethods !== undefined &&
    !m.supportedGenerationMethods.includes('generateContent')
  ) {
    return Option.none();
  }
  const context =
    m.context_window ??
    m.context_length ??
    m.inputTokenLimit ??
    m.max_input_tokens ??
    m.max_context_length ??
    m.contextWindow;
  const metadataEfforts = provider === 'gateway' ? advertisedEfforts(m) : [];
  return decodeDiscovered({
    id,
    name: displayName(m) ?? id,
    contextWindow: Option.getOrElse(decodeContextWindow(context), () =>
      modelContextWindow(provider, id),
    ),
    reasoningEfforts: metadataEfforts.length
      ? metadataEfforts
      : modelReasoningEfforts(provider, id),
    supportsTools: discoveredToolSupport(provider, id, m, officialEndpoint),
  });
}

/**
 * The models a provider's model list offers, each once by id, in the order
 * listed. `officialEndpoint` says the list came from the provider's own API
 * rather than a proxy, which decides what some lists say about tools.
 */
export function discoveredModels(
  provider: ProviderId,
  body: unknown,
  officialEndpoint: boolean,
): DiscoveredConnectionModel[] {
  const rows = Option.getOrElse(decodeRows(body), () =>
    Option.match(decodeList(body), {
      onNone: () => [],
      onSome: ({ data, models }) => data ?? models ?? [],
    }),
  );
  const models = new Map<string, DiscoveredConnectionModel>();
  for (const row of rows) {
    const model = Option.flatMap(decodeListed(row), (m) =>
      discoveredModel(provider, m, officialEndpoint),
    );
    if (Option.isSome(model)) models.set(model.value.id, model.value);
  }
  return [...models.values()];
}
