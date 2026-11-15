import { invoke, isTauri } from '@tauri-apps/api/core';
import { desktopInputs } from '@wisp/protocol/desktop-inputs';
import { desktopResponses, desktopInfoSchema } from '@wisp/protocol/desktop';
export const native = isTauri();
export async function desktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!native) {
    return Promise.reject(Error('This action is available in the Wisp desktop app.'));
  }
  const result = await invoke<unknown>(command, args);
  return (command === 'desktop_info' ? desktopInfoSchema.parse(result) : result) as T;
}
export async function request<T = Record<string, unknown>>(
  route: string,
  body?: unknown,
): Promise<T> {
  const input =
    body !== undefined && Object.hasOwn(desktopInputs, route)
      ? desktopInputs[route as keyof typeof desktopInputs].parse(body)
      : body;
  const result = await desktop<unknown>('bridge_request', {
    method: body === undefined ? 'GET' : 'POST',
    route,
    body: input ?? null,
  });
  return (
    Object.hasOwn(desktopResponses, route)
      ? desktopResponses[route as keyof typeof desktopResponses].parse(result)
      : result
  ) as T;
}
export type { DesktopInfo, Model, Mcp, Panel, Status } from '@wisp/protocol/desktop';
