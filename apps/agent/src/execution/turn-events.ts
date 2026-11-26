import type { TextStreamPart, ToolSet } from 'ai';
import type { Effect } from 'effect';
import { z } from 'zod';
import { CONTROL_TOOLS, TOOL_CALL, type assembleTools } from '../tools/turn-tools.ts';
import { errorText } from './engine-errors.ts';
import { stepUsage } from './usage.ts';

/** The stream events the bridge projects into a reply (`chat/events.ts`). */
export interface EngineEvent {
  type: string;
  data: Record<string, unknown>;
}

export type Emit = (event: EngineEvent) => Effect.Effect<unknown>;

function safeLabel(label: () => string | undefined) {
  try {
    return label();
  } catch {
    return undefined;
  }
}

type Labels = Pick<ReturnType<typeof assembleTools>, 'labels' | 'deferred'>;

/** The input of a `tool_call`: the deferred tool it runs and that tool's input. */
const deferredCall = z.object({ name: z.string(), input: z.unknown().optional() });

/**
 * The bridge events of one turn's AI SDK stream. A deferred call is shown as
 * the tool it runs, not as tool_call, and keeps its input for the settled label.
 */
export class TurnEvents {
  private texts = new Map<string, string>();
  private inputs = new Map<string, string>();
  private calls = new Map<string, { name: string; input: unknown }>();
  private tools: Labels;
  constructor(tools: Labels) {
    this.tools = tools;
  }

  private label(name: string) {
    return this.tools.labels.get(name) ?? this.tools.deferred.get(name)?.label;
  }

  private shown(name: string, input: unknown) {
    const deferred = name === TOOL_CALL ? deferredCall.safeParse(input) : undefined;
    return deferred?.success
      ? { name: deferred.data.name, input: deferred.data.input ?? {} }
      : { name, input };
  }

  read(part: TextStreamPart<ToolSet>): EngineEvent[] {
    switch (part.type) {
      case 'text-start':
        this.texts.set(part.id, '');
        return [];
      case 'text-delta':
        this.texts.set(part.id, (this.texts.get(part.id) ?? '') + part.text);
        return [
          { type: 'content.delta', data: { partId: part.id, kind: 'text', delta: part.text } },
        ];
      case 'text-end':
        return [
          {
            type: 'content.completed',
            data: { partId: part.id, kind: 'text', value: this.texts.get(part.id) ?? '' },
          },
        ];
      case 'tool-input-start':
        this.inputs.set(part.id, part.toolName);
        return [];
      case 'tool-input-delta':
        return [
          {
            type: 'call.input',
            data: { callId: part.id, delta: part.delta, name: this.inputs.get(part.id) },
          },
        ];
      case 'tool-call': {
        const call = this.shown(part.toolName, part.input);
        this.calls.set(part.toolCallId, call);
        const label = safeLabel(() => this.label(call.name)?.start?.(call.input as never));
        return [
          {
            type: 'call.requested',
            data: {
              callId: part.toolCallId,
              input: call.input,
              capability: {
                name: call.name,
                label,
                kind: CONTROL_TOOLS.has(call.name) ? 'control' : 'tool',
              },
            },
          },
        ];
      }
      case 'tool-result': {
        if ((part as { preliminary?: boolean }).preliminary) {
          return [];
        }
        const call = this.calls.get(part.toolCallId);
        const label =
          call &&
          safeLabel(() =>
            this.label(call.name)?.complete?.(call.input as never, part.output as never),
          );
        return [
          {
            type: 'call.settled',
            data: {
              callId: part.toolCallId,
              outcome: 'completed',
              output: part.output,
              ...(label ? { label } : {}),
            },
          },
        ];
      }
      case 'tool-error':
        return [
          {
            type: 'call.settled',
            data: {
              callId: part.toolCallId,
              outcome: 'failed',
              error: { message: errorText(part.error) },
            },
          },
        ];
      case 'finish-step': {
        const usage = stepUsage(part.usage);
        return usage ? [{ type: 'usage.recorded', data: { kind: 'model', usage } }] : [];
      }
      // A provider error fails the turn where the stream is read.
      case 'error':
      case 'start':
      case 'start-step':
      case 'finish':
      case 'abort':
      case 'raw':
      case 'ping':
      case 'custom':
      case 'file':
      case 'source':
      case 'reasoning-start':
      case 'reasoning-delta':
      case 'reasoning-end':
      case 'reasoning-file':
      case 'steering-message':
      case 'tool-input-end':
      case 'tool-approval-request':
      case 'tool-approval-response':
      case 'tool-output-denied':
        return [];
    }
  }
}
