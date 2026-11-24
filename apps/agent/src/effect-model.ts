import type {
  JSONValue,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FinishReason,
  LanguageModelV4FunctionTool,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolResultOutput,
  LanguageModelV4Usage,
  SharedV4ProviderOptions,
} from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import { Effect, Stream } from 'effect';
import { AiError, LanguageModel, Prompt, Response, Tool } from 'effect/ai';

/**
 * Effect AI language models over AI SDK providers. Wisp keeps every AI SDK
 * provider (and the ChatGPT subscription transport) and runs them as Effect
 * `LanguageModel`s, while history stays in AI SDK `ModelMessage` form so
 * stored conversations keep working.
 */

// The provider's own error behind an AiError, which the bridge classifies by
// its code and message (usage limits, timeouts).
const causes = new WeakMap<object, unknown>();
export function providerCause(error: unknown): unknown {
  return (error && typeof error === 'object' && causes.get(error)) || error;
}

function aiError(method: string, cause: unknown) {
  const error = AiError.make({
    module: 'AiSdkLanguageModel',
    method,
    reason: new AiError.UnknownError({
      description: cause instanceof Error ? cause.message : String(cause),
    }),
  });
  causes.set(error, cause);
  return error;
}

// Tool results keep their AI SDK output under this option key, so a stored
// result reaches the provider exactly as it was recorded.
const WISP = 'wisp';
type Options = { readonly [key: string]: unknown } | undefined;

function providerOptions(options: Options): SharedV4ProviderOptions | undefined {
  if (!options) {
    return undefined;
  }
  const entries = Object.entries(options).filter(
    (entry): entry is [string, Record<string, JSONValue>] =>
      entry[0] !== WISP && !!entry[1] && typeof entry[1] === 'object',
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function withOptions<T extends object>(value: T, options: Options) {
  const provider = providerOptions(options);
  return provider ? { ...value, providerOptions: provider } : value;
}

function fileData(data: unknown) {
  return data instanceof URL || data instanceof Uint8Array || typeof data === 'string'
    ? data
    : String(data);
}

function resultOutput(part: Prompt.ToolResultPart): LanguageModelV4ToolResultOutput {
  const stored = (part.options as { [WISP]?: { output?: unknown } } | undefined)?.[WISP]?.output;
  if (stored) {
    return stored as LanguageModelV4ToolResultOutput;
  }
  if (part.modelOutput?.length) {
    return {
      type: 'content',
      value: part.modelOutput.map((item) =>
        item.type === 'text'
          ? { type: 'text', text: item.text }
          : { type: 'file-data', data: String(fileData(item.data)), mediaType: item.mediaType },
      ) as never,
    };
  }
  const value = (part.result ?? null) as JSONValue;
  return part.isFailure ? { type: 'error-json', value } : { type: 'json', value };
}

function toolResult(part: Prompt.ToolResultPart) {
  return withOptions(
    {
      type: 'tool-result' as const,
      toolCallId: part.id,
      toolName: part.name,
      output: resultOutput(part),
    },
    part.options,
  );
}

/** An Effect prompt as the AI SDK provider call takes it. */
export function toProviderPrompt(prompt: Prompt.Prompt): LanguageModelV4Prompt {
  return prompt.content.map((message): LanguageModelV4Message => {
    switch (message.role) {
      case 'system':
        return withOptions({ role: 'system', content: message.content }, message.options);
      case 'user':
        return withOptions(
          {
            role: 'user',
            content: message.content.map((part) =>
              part.type === 'text'
                ? withOptions({ type: 'text' as const, text: part.text }, part.options)
                : withOptions(
                    {
                      type: 'file' as const,
                      data: fileData(part.data) as never,
                      mediaType: part.mediaType,
                      ...(part.fileName ? { filename: part.fileName } : {}),
                    },
                    part.options,
                  ),
            ),
          },
          message.options,
        );
      case 'assistant':
        return withOptions(
          {
            role: 'assistant',
            content: message.content.flatMap((part): any[] => {
              switch (part.type) {
                case 'text':
                  return [withOptions({ type: 'text' as const, text: part.text }, part.options)];
                case 'reasoning':
                  return [
                    withOptions({ type: 'reasoning' as const, text: part.text }, part.options),
                  ];
                case 'file':
                  return [
                    withOptions(
                      {
                        type: 'file' as const,
                        data: fileData(part.data) as never,
                        mediaType: part.mediaType,
                      },
                      part.options,
                    ),
                  ];
                case 'tool-call':
                  return [
                    withOptions(
                      {
                        type: 'tool-call' as const,
                        toolCallId: part.id,
                        toolName: part.name,
                        input: part.params,
                        ...(part.providerExecuted ? { providerExecuted: true } : {}),
                      },
                      part.options,
                    ),
                  ];
                case 'tool-result':
                  return [toolResult(part)];
                default:
                  return [];
              }
            }),
          },
          message.options,
        );
      case 'tool':
        return withOptions(
          {
            role: 'tool',
            content: message.content.flatMap((part) =>
              part.type === 'tool-result' ? [toolResult(part)] : [],
            ),
          },
          message.options,
        );
    }
  }) as LanguageModelV4Prompt;
}

function optionsOf(provider: unknown, output?: unknown) {
  const options = {
    ...(provider && typeof provider === 'object' ? provider : {}),
    ...(output !== undefined ? { [WISP]: { output } } : {}),
  } as Prompt.ProviderOptions;
  return Object.keys(options).length ? { options } : {};
}

function resultOf(output: { type: string; value?: unknown }) {
  return {
    isFailure: output.type.startsWith('error'),
    result: 'value' in output ? output.value : null,
  };
}

/** Stored AI SDK history as an Effect prompt; tool outputs ride along unchanged. */
export function toEffectPrompt(messages: readonly ModelMessage[]): Prompt.Prompt {
  const encoded = messages.map((message): Prompt.MessageEncoded => {
    const options = optionsOf(message.providerOptions);
    if (message.role === 'system') {
      return { role: 'system', content: message.content, ...options };
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        ...options,
        content: message.content.flatMap((part) =>
          part.type === 'tool-result'
            ? [
                {
                  type: 'tool-result' as const,
                  id: part.toolCallId,
                  name: part.toolName,
                  ...resultOf(part.output),
                  ...optionsOf(part.providerOptions, part.output),
                },
              ]
            : [],
        ),
      };
    }
    if (message.role === 'user') {
      return {
        role: 'user',
        ...options,
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.flatMap((part): Prompt.UserMessagePartEncoded[] =>
                part.type === 'text'
                  ? [{ type: 'text', text: part.text, ...optionsOf(part.providerOptions) }]
                  : part.type === 'file'
                    ? [
                        {
                          type: 'file',
                          mediaType: part.mediaType,
                          data: part.data as never,
                          ...(part.filename ? { fileName: part.filename } : {}),
                          ...optionsOf(part.providerOptions),
                        },
                      ]
                    : [],
              ),
      };
    }
    return {
      role: 'assistant',
      ...options,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content.flatMap((part): Prompt.AssistantMessagePartEncoded[] => {
              switch (part.type) {
                case 'text':
                  return [{ type: 'text', text: part.text, ...optionsOf(part.providerOptions) }];
                case 'reasoning':
                  return [
                    { type: 'reasoning', text: part.text, ...optionsOf(part.providerOptions) },
                  ];
                case 'tool-call':
                  return [
                    {
                      type: 'tool-call',
                      id: part.toolCallId,
                      name: part.toolName,
                      params: part.input,
                      ...(part.providerExecuted ? { providerExecuted: true } : {}),
                      ...optionsOf(part.providerOptions),
                    },
                  ];
                case 'tool-result':
                  return [
                    {
                      type: 'tool-result',
                      id: part.toolCallId,
                      name: part.toolName,
                      ...resultOf(part.output),
                      providerExecuted: true,
                      ...optionsOf(part.providerOptions, part.output),
                    },
                  ];
                default:
                  return [];
              }
            }),
    };
  });
  return Prompt.make(encoded);
}

function finishReason(reason: LanguageModelV4FinishReason): Response.FinishReason {
  const unified = typeof reason === 'string' ? reason : reason.unified;
  return unified === 'stop' ||
    unified === 'length' ||
    unified === 'content-filter' ||
    unified === 'tool-calls' ||
    unified === 'error'
    ? unified
    : 'other';
}

function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function usage(raw: LanguageModelV4Usage) {
  return {
    inputTokens: defined({
      total: raw.inputTokens.total,
      uncached: raw.inputTokens.noCache,
      cacheRead: raw.inputTokens.cacheRead,
      cacheWrite: raw.inputTokens.cacheWrite,
    }),
    outputTokens: defined({
      total: raw.outputTokens.total,
      text: raw.outputTokens.text,
      reasoning: raw.outputTokens.reasoning,
    }),
  };
}

function parseInput(input: string) {
  try {
    return input.trim() ? JSON.parse(input) : {};
  } catch {
    return input;
  }
}

const metadata = (value: unknown) =>
  value ? { metadata: value as Response.ProviderMetadata } : ({} as const);

function streamPart(part: LanguageModelV4StreamPart): Response.StreamPartEncoded[] {
  switch (part.type) {
    case 'text-start':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-end':
      return [{ type: part.type, id: part.id, ...metadata(part.providerMetadata) }];
    case 'text-delta':
    case 'reasoning-delta':
      return [
        { type: part.type, id: part.id, delta: part.delta, ...metadata(part.providerMetadata) },
      ];
    case 'tool-input-start':
      return [
        {
          type: 'tool-params-start',
          id: part.id,
          name: part.toolName,
          ...(part.providerExecuted ? { providerExecuted: true } : {}),
        },
      ];
    case 'tool-input-delta':
      return [{ type: 'tool-params-delta', id: part.id, delta: part.delta }];
    case 'tool-input-end':
      return [{ type: 'tool-params-end', id: part.id }];
    case 'tool-call':
      return [
        {
          type: 'tool-call',
          id: part.toolCallId,
          name: part.toolName,
          params: parseInput(part.input),
          ...(part.providerExecuted ? { providerExecuted: true } : {}),
          ...metadata(part.providerMetadata),
        },
      ];
    case 'tool-result':
      return [
        {
          type: 'tool-result',
          id: part.toolCallId,
          name: part.toolName,
          result: part.result,
          isFailure: !!part.isError,
          providerExecuted: true,
          ...metadata(part.providerMetadata),
        },
      ];
    case 'response-metadata':
      return [
        defined({
          type: 'response-metadata' as const,
          id: part.id,
          modelId: part.modelId,
          timestamp: part.timestamp?.toISOString(),
        }),
      ];
    case 'finish':
      return [
        {
          type: 'finish',
          reason: finishReason(part.finishReason),
          usage: usage(part.usage),
          ...metadata(part.providerMetadata),
        },
      ];
    case 'error':
      return [{ type: 'error', error: part.error }];
    default:
      // Stream starts, sources, files and custom content carry nothing Wisp shows.
      return [];
  }
}

function providerTools(options: LanguageModel.ProviderOptions) {
  const tools = options.tools.filter((tool) => !Tool.isProviderDefined(tool));
  const choice = options.toolChoice;
  let allowed = tools;
  let toolChoice: LanguageModelV4CallOptions['toolChoice'] = { type: 'auto' };
  if (choice === 'none' || choice === 'required' || choice === 'auto') {
    toolChoice = { type: choice };
  } else if ('tool' in choice) {
    toolChoice = { type: 'tool', toolName: choice.tool };
  } else if ('oneOf' in choice) {
    allowed = tools.filter((tool) => choice.oneOf.includes(tool.name));
    toolChoice = { type: choice.mode === 'required' ? 'required' : 'auto' };
  }
  const definitions = allowed.map((tool): LanguageModelV4FunctionTool => ({
    type: 'function',
    name: tool.name,
    description: Tool.getDescription(tool),
    inputSchema: Tool.getJsonSchema(tool) as never,
  }));
  return definitions.length ? { tools: definitions, toolChoice } : {};
}

function callOptions(
  options: LanguageModel.ProviderOptions,
  extra: SharedV4ProviderOptions | undefined,
  abortSignal: AbortSignal,
): LanguageModelV4CallOptions {
  return {
    prompt: toProviderPrompt(options.prompt),
    abortSignal,
    ...providerTools(options),
    ...(options.responseFormat.type === 'json'
      ? {
          responseFormat: {
            type: 'json',
            name: options.responseFormat.objectName,
            schema: Tool.getJsonSchemaFromSchema(options.responseFormat.schema) as never,
          },
        }
      : {}),
    ...(extra ? { providerOptions: extra } : {}),
  };
}

/**
 * An AI SDK provider model as an Effect `LanguageModel`. `providerOptions`
 * are sent with every call, as the AI SDK's own `providerOptions` would be.
 */
export function aiSdkLanguageModel(
  model: LanguageModelV4,
  providerOptions?: SharedV4ProviderOptions,
) {
  return LanguageModel.make({
    generateText: (options) =>
      Effect.tryPromise({
        try: (signal) => model.doGenerate(callOptions(options, providerOptions, signal)),
        catch: (error) => aiError('generateText', error),
      }).pipe(
        Effect.map((result): Response.PartEncoded[] => [
          ...result.content.flatMap((part): Response.PartEncoded[] => {
            switch (part.type) {
              case 'text':
                return [{ type: 'text', text: part.text, ...metadata(part.providerMetadata) }];
              case 'reasoning':
                return [{ type: 'reasoning', text: part.text, ...metadata(part.providerMetadata) }];
              case 'tool-call':
                return [
                  {
                    type: 'tool-call',
                    id: part.toolCallId,
                    name: part.toolName,
                    params: parseInput(part.input),
                    ...metadata(part.providerMetadata),
                  },
                ];
              default:
                return [];
            }
          }),
          {
            type: 'finish',
            reason: finishReason(result.finishReason),
            usage: usage(result.usage),
            ...metadata(result.providerMetadata),
          },
        ]),
      ),
    streamText: (options) =>
      Stream.unwrap(
        Effect.tryPromise({
          try: (signal) => model.doStream(callOptions(options, providerOptions, signal)),
          catch: (error) => aiError('streamText', error),
        }).pipe(
          Effect.map(({ stream }) =>
            Stream.fromReadableStream({
              evaluate: () => stream,
              onError: (error) => aiError('streamText', error),
            }).pipe(Stream.flatMap((part) => Stream.fromIterable(streamPart(part)))),
          ),
        ),
      ),
  });
}
