import { selectedModel, type AgentHostCalls } from '../src/contract/host-calls.ts';

/**
 * The agent's host calls for evals. The eval bridge
 * (apps/bridge/src/evals/eval-bridge.ts) runs in its own process with its own
 * ChatGPT sign-in, so evals reach it over HTTP; the app calls the bridge in
 * process.
 */
export function evalBridgeCalls(origin: string, token: string): AgentHostCalls {
  const headers = { authorization: 'Bearer ' + token };
  const answer = async (response: Response) => {
    if (!response.ok) {
      throw Error((await response.text()) || 'The eval bridge failed.');
    }
    return response.json() as Promise<never>;
  };
  return {
    call: async (session, call, input, signal) =>
      answer(
        await fetch(origin + '/' + call, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ agentSession: session, ...input }),
          signal,
        }),
      ),
    selectedModel: async (session, signal) =>
      selectedModel.parse(
        await answer(
          await fetch(origin + '/session-model?session=' + encodeURIComponent(session), {
            headers,
            signal,
          }),
        ),
      ),
  };
}
