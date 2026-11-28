import { invoke, isTauri } from '@tauri-apps/api/core';
import { Schema } from 'effect';
import {
  nativeCommands,
  type NativeCommand,
  type NativeReply,
} from '@wisp/protocol/native-commands';
export const native = isTauri();
/**
 * Runs a native host command and decodes its reply with the command's
 * contract schema, at the IPC boundary; a reply of another shape rejects.
 */
export async function desktop<C extends NativeCommand>(
  command: C,
  args?: Record<string, unknown>,
): Promise<NativeReply<C>> {
  if (!native) {
    return Promise.reject(Error('This action is available in the Wisp desktop app.'));
  }
  const reply: (typeof nativeCommands)[C] = nativeCommands[command];
  return Schema.decodeUnknownPromise(reply)(await invoke(command, args));
}
