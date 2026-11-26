import type { GameEvent } from '@wisp/wow-bridge';
import { packetSchema } from '@wisp/wow-bridge/protocol';

export function gameEvent(input: unknown): GameEvent {
  const packet = packetSchema.parse(input);
  if (packet.type === 'state_result') throw Error('Game results are consumed by the bridge');
  return packet;
}
