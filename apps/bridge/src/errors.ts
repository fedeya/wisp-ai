import { safeErrorMessage } from '@wisp/protocol/model-errors';
export function errorMessage(error: unknown): string {
  // Tagged errors such as the agent's HostError carry no message of their own.
  if (error instanceof Error && !error.message && error.cause !== undefined) {
    return errorMessage(error.cause);
  }
  return safeErrorMessage(error instanceof Error ? error.message : String(error));
}
