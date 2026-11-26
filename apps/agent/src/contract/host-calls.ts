import { z } from 'zod';
import type { inspectionSchema } from './game-inspection.ts';
import type { actionSchema } from './game-actions.ts';
import type { panelInput } from './panels.ts';
import type { routineInput } from '@wisp/protocol/routines';
import type { simulationInput } from './simulation.ts';
import type { databaseRequest } from './database.ts';
import type { wowheadQuery } from '@wisp/protocol/search';
import { providerId } from '@wisp/protocol/providers';
import type { ReplyPresentation } from './reply-presentation.ts';

export const characterSections = z
  .array(
    z.enum([
      'character',
      'location',
      'group',
      'talents',
      'spells',
      'quests',
      'gear',
      'bags',
      'pvp',
    ]),
  )
  .min(1)
  .max(9);

export const memoryEntry = z.object({ key: z.string(), text: z.string(), updatedAt: z.string() });
export type MemoryEntry = z.infer<typeof memoryEntry>;
type MemorySlot = 'preferences' | 'character';
export type MemoryRequest =
  | { slot: MemorySlot; operation: 'list' }
  | { slot: MemorySlot; operation: 'save'; key: string; text: string }
  | { slot: MemorySlot; operation: 'remove'; key: string };

/**
 * What each call to the host takes. The tool that makes a call has already
 * validated its input with its own schema, so these only type the call.
 */
export interface HostRequests {
  state: { sections: z.output<typeof characterSections>; refresh?: boolean };
  identity: Record<string, never>;
  title: { title: string };
  present: { callId: string; presentation: ReplyPresentation };
  memory: MemoryRequest;
  inspect: { inspection: z.output<typeof inspectionSchema> };
  action: { action: z.output<typeof actionSchema> };
  panels: { input: z.output<typeof panelInput> };
  routines: { input: z.output<typeof routineInput> };
  simulate: z.output<typeof simulationInput>;
  database: z.output<typeof databaseRequest>;
  wowhead: z.output<typeof wowheadQuery>;
}

/** What each call to the host returns. Game readings and tool results go to the model as they are. */
export interface HostResponses {
  state: unknown;
  identity: { characterKey: string | null };
  title: { title: string };
  present: ReplyPresentation;
  memory: { entries: MemoryEntry[] };
  inspect: unknown;
  action: unknown;
  panels: unknown;
  routines: unknown;
  simulate: unknown;
  database: unknown;
  wowhead: unknown;
}

export type HostCall = keyof HostRequests;

/** The model a session runs on, as the bridge's chat settings choose it. */
export const selectedModel = z.object({
  model: z.string().min(1),
  effort: z.string().min(1),
  contextWindow: z.number().positive().optional(),
  connectionId: z.string().uuid().optional(),
  provider: providerId.optional(),
  modelId: z.string().min(1).optional(),
  webSearchAvailable: z.boolean().optional(),
});
export type SelectedModel = z.infer<typeof selectedModel>;

/**
 * What the agent asks of its host (the bridge). The agent runs in the
 * bridge's process, so these are plain calls. A call names the agent session
 * it acts for; the host resolves it to the chat whose turn is running.
 */
export interface AgentHostCalls {
  call<K extends HostCall>(
    session: string,
    call: K,
    input: HostRequests[K],
    signal: AbortSignal,
  ): Promise<HostResponses[K]>;
  /** The model the session's chat runs on. */
  selectedModel(session: string, signal: AbortSignal): Promise<SelectedModel>;
}

/** Calls to the host for one session. `timeoutMs` bounds a call that hangs. */
export type SessionHost = <K extends HostCall>(
  call: K,
  input: HostRequests[K],
  timeoutMs?: number,
) => Promise<HostResponses[K]>;

/** The host's calls bound to a session and the signal that cancels its work. */
export function sessionHost(
  calls: AgentHostCalls,
  session: string,
  signal: AbortSignal,
): SessionHost {
  return (call, input, timeoutMs = 35_000) => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    return new Promise((resolve, reject) => {
      const abort = () => reject(bounded.reason);
      if (bounded.aborted) return abort();
      bounded.addEventListener('abort', abort, { once: true });
      calls.call(session, call, input, bounded).then(
        (value) => {
          bounded.removeEventListener('abort', abort);
          resolve(value);
        },
        (error: unknown) => {
          bounded.removeEventListener('abort', abort);
          reject(error);
        },
      );
    });
  };
}

/** Names the agent session on model requests, so the bridge can tell which turn a failure belongs to. */
export const MODEL_SESSION_HEADER = 'x-wisp-session';
