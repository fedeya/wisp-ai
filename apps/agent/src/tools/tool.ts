import type { z } from 'zod';
import type { SessionHost } from '../contract/host-calls.ts';

/** What a tool receives besides its input. */
export interface ToolContext {
  /** The agent session the call belongs to; the bridge resolves it to a chat. */
  session: { id: string };
  abortSignal: AbortSignal;
  /** The model's id for this call. */
  callId: string;
  /** Calls to the host (the bridge) for this session, cancelled with the call. */
  host: SessionHost;
}

/** A tool result shaped for the model, in the AI SDK tool-result form. */
export type ToolModelOutput =
  | { type: 'text'; value: string }
  | { type: 'error-text'; value: string }
  | { type: 'json'; value: unknown }
  | { type: 'content'; value: unknown[] };

export interface ToolDefinition<Input = any, Output = any> {
  description: string;
  inputSchema: z.ZodType<Input>;
  outputSchema?: z.ZodType<Output>;
  /**
   * Deferred tools stay out of every request until the model finds them with
   * `tool_search` and runs them with `tool_call`, which keeps the request's
   * tool list, and so the provider's prompt cache, stable.
   */
  deferred?: boolean;
  /** The turn ends once the model calls this tool, without another model step. */
  endsTurn?: boolean;
  /** Presentation-safe activity labels shown to the player. */
  label?: {
    start?: (input: Input) => string;
    complete?: (input: Input, output: Output) => string;
  };
  execute: (input: Input, ctx: ToolContext) => Output | Promise<Output>;
  /** What the model sees instead of the full output. */
  toModelOutput?: (output: Output) => ToolModelOutput;
  /** Capability switch that must be on for the model to see the tool. */
  capability?: string;
}

export function defineTool<Input, Output>(
  definition: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return definition;
}

export const toolOutput = {
  text: (value: string): ToolModelOutput => ({ type: 'text', value }),
  errorText: (value: string): ToolModelOutput => ({ type: 'error-text', value }),
  json: (value: unknown): ToolModelOutput => ({ type: 'json', value }),
};
