import type { GameEvent } from '@wisp/wow-bridge';
import { packetSchema } from '@wisp/wow-bridge/protocol';
import { Schema } from 'effect';

const decodePacket = Schema.decodeUnknownSync(packetSchema);

export function gameEvent(input: unknown): GameEvent {
  const packet = decodePacket(input);
  if (packet.type === 'state_result') throw Error('Game results are consumed by the bridge');
  return packet;
}
