import {
  rpcRequests,
  rpcResponses,
  type RpcEndpoint,
  type RpcInput,
  type RpcOutput,
} from '../contract/agent-rpc.ts';
import { agentHost } from './agent-host.ts';
export function bridgeOrigin() {
  return new URL(agentHost()?.origin || process.env.WOW_BRIDGE_URL || 'http://127.0.0.1:43187')
    .origin;
}
function bridgeToken() {
  return agentHost()?.token ?? process.env.WOW_BRIDGE_TOKEN;
}
export async function agentRPC<K extends RpcEndpoint>(
  endpoint: K,
  data: RpcInput<K>,
  signal?: AbortSignal,
  timeoutMs = 35_000,
): Promise<RpcOutput<K>> {
  const res = await fetch(bridgeOrigin() + '/' + endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + bridgeToken(),
    },
    body: JSON.stringify(rpcRequests[endpoint].parse(data)),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return rpcResponses[endpoint].parse(await res.json()) as RpcOutput<K>;
}
