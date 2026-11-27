// @effect-migrated
import type { ModelMessage, TextStreamPart, ToolSet } from 'ai';
import { Predicate } from 'effect';
import type { Assistant, AssistantPart, Native, Tool, ToolState } from './session-message.ts';

/** A step's timing and outcome, recorded beside its content. */
export interface StepInfo {
  finish?: Assistant['finish'];
  tokens?: Assistant['tokens'];
  error?: string;
  created: number;
  completed?: number;
}

type ToolResultOutput = Extract<
  Exclude<ModelMessage['content'], string>[number],
  { type: 'tool-result' }
>['output'];

const nativeOf = (options: unknown): { native?: Native } =>
  Predicate.isObject(options) && Object.keys(options).length ? { native: options as Native } : {};

function settled(input: unknown, output: ToolResultOutput, options: unknown): ToolState {
  const native = nativeOf(options);
  switch (output.type) {
    case 'text':
      return {
        status: 'completed',
        input,
        output: { type: 'text', text: output.value },
        ...native,
      };
    case 'json':
      return {
        status: 'completed',
        input,
        output: { type: 'json', value: output.value },
        ...native,
      };
    case 'content':
      return {
        status: 'completed',
        input,
        output: { type: 'content', value: output.value },
        ...native,
      };
    case 'error-text':
      return { status: 'error', input, error: output.value, ...native };
    case 'error-json':
      return { status: 'error', input, error: JSON.stringify(output.value), ...native };
    case 'execution-denied':
      return {
        status: 'error',
        input,
        error: output.reason ?? 'The tool call was denied.',
        ...native,
      };
  }
}

/**
 * One finished step, from the AI SDK's response messages for it: an assistant
 * message whose tool calls carry their results. Parts the log does not keep
 * (files, approvals, provider-specific parts) are left out.
 */
export function stepMessage(response: readonly ModelMessage[], info: StepInfo): Assistant {
  const content: AssistantPart[] = [];
  const tools = new Map<string, number>();
  let native: Native | undefined;
  const settle = (id: string, output: ToolResultOutput, options: unknown) => {
    const index = tools.get(id);
    const tool = index === undefined ? undefined : content[index];
    if (tool?.type === 'tool') {
      content[index!] = { ...tool, state: settled(tool.state.input, output, options) };
    }
  };
  for (const message of response) {
    if (message.role === 'assistant') {
      native = nativeOf({ ...native, ...message.providerOptions }).native;
    }
    if (typeof message.content === 'string') {
      if (message.role === 'assistant' && message.content) {
        content.push({ type: 'text', text: message.content });
      }
      continue;
    }
    for (const part of message.content) {
      switch (part.type) {
        case 'text':
          content.push({ type: 'text', text: part.text, ...nativeOf(part.providerOptions) });
          break;
        case 'reasoning':
          content.push({ type: 'reasoning', text: part.text, ...nativeOf(part.providerOptions) });
          break;
        case 'tool-call':
          tools.set(part.toolCallId, content.length);
          content.push({
            type: 'tool',
            id: part.toolCallId,
            name: part.toolName,
            state: { status: 'running', input: part.input },
            ...(part.providerExecuted ? { providerExecuted: true } : {}),
            ...nativeOf(part.providerOptions),
          });
          break;
        case 'tool-result':
          settle(part.toolCallId, part.output, part.providerOptions);
          break;
        default:
          break;
      }
    }
  }
  return {
    type: 'assistant',
    content,
    ...(info.finish ? { finish: info.finish } : {}),
    ...(info.tokens ? { tokens: info.tokens } : {}),
    ...(info.error ? { error: info.error } : {}),
    ...(native ? { native } : {}),
    time: {
      created: info.created,
      ...(info.completed === undefined ? {} : { completed: info.completed }),
    },
  };
}

/**
 * The step in progress, read from the AI SDK's chunks in the order it
 * processes them, so a turn that stops mid-step can still log what the model
 * said and which tools it started. Reasoning is left out: without the
 * provider's signature, which arrives at the step's end, it cannot be replayed.
 */
export class StepDraft {
  private created = Date.now();
  private parts: AssistantPart[] = [];
  private texts = new Map<string, number>();
  private tools = new Map<string, number>();

  start(now: number) {
    this.created = now;
    this.parts = [];
    this.texts.clear();
    this.tools.clear();
  }

  get startedAt() {
    return this.created;
  }

  read(chunk: TextStreamPart<ToolSet>) {
    switch (chunk.type) {
      case 'text-delta': {
        const index = this.texts.get(chunk.id);
        const part = index === undefined ? undefined : this.parts[index];
        if (part?.type === 'text') {
          this.parts[index!] = { ...part, text: part.text + chunk.text };
        } else {
          this.texts.set(chunk.id, this.parts.length);
          this.parts.push({ type: 'text', text: chunk.text });
        }
        return;
      }
      case 'tool-call':
        this.tools.set(chunk.toolCallId, this.parts.length);
        this.parts.push({
          type: 'tool',
          id: chunk.toolCallId,
          name: chunk.toolName,
          state: { status: 'running', input: chunk.input },
          ...(chunk.providerExecuted ? { providerExecuted: true } : {}),
        });
        return;
      case 'tool-result':
        if (!(chunk as { preliminary?: boolean }).preliminary) {
          this.settle(chunk.toolCallId, (tool) => ({
            status: 'completed',
            input: tool.state.input,
            output: { type: 'json', value: chunk.output },
          }));
        }
        return;
      case 'tool-error':
        this.settle(chunk.toolCallId, (tool) => ({
          status: 'error',
          input: tool.state.input,
          error: chunk.error instanceof Error ? chunk.error.message : String(chunk.error),
        }));
        return;
      default:
        return;
    }
  }

  private settle(id: string, state: (tool: Tool) => ToolState) {
    const index = this.tools.get(id);
    const part = index === undefined ? undefined : this.parts[index];
    if (part?.type === 'tool') {
      this.parts[index!] = { ...part, state: state(part) };
    }
  }

  /** What the step had produced when the turn stopped; undefined when nothing. */
  stopped(info: Omit<StepInfo, 'created'>): Assistant | undefined {
    const content = this.parts.filter((part) => part.type !== 'text' || part.text);
    if (!content.length) return undefined;
    return { ...stepMessage([], { ...info, created: this.created }), content };
  }
}
