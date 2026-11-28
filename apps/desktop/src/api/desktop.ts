import { invoke, isTauri } from '@tauri-apps/api/core';
import { Schema } from 'effect';
import { desktopInfoSchema, type DesktopInfo } from '@wisp/protocol/desktop';
export const native = isTauri();
const decodeInfo = Schema.decodeUnknownPromise(desktopInfoSchema);
/**
 * Runs a native host command. What the host reports about the app is decoded
 * here, at the IPC boundary; other replies are whatever the caller expects.
 */
export function desktop(command: 'desktop_info'): Promise<DesktopInfo>;
export function desktop<T>(command: string, args?: Record<string, unknown>): Promise<T>;
export async function desktop(command: string, args?: Record<string, unknown>): Promise<unknown> {
  if (!native) {
    return Promise.reject(Error('This action is available in the Wisp desktop app.'));
  }
  const result = await invoke(command, args);
  return command === 'desktop_info' ? decodeInfo(result) : result;
}
