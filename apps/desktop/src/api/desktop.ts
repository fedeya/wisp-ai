import { invoke, isTauri } from '@tauri-apps/api/core';
import { desktopInfoSchema } from '@wisp/protocol/desktop';
export const native = isTauri();
export async function desktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!native) {
    return Promise.reject(Error('This action is available in the Wisp desktop app.'));
  }
  const result = await invoke<unknown>(command, args);
  return (command === 'desktop_info' ? desktopInfoSchema.parse(result) : result) as T;
}
