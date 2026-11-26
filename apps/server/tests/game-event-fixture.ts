import type { GameEvent } from '@wisp/wow-bridge';
import { packetSchema } from '@wisp/wow-bridge/protocol';
import { Schema } from 'effect';

const decodePacket = Schema.decodeUnknownSync(packetSchema);

export function gameEvent(input: unknown): GameEvent {
  const {
    seq: _seq,
    nextSlot: _nextSlot,
    receivedRev: _receivedRev,
    transportVersion: _transportVersion,
    mailboxVersion: _mailboxVersion,
    compactAck: _compactAck,
    bulkAvailable: _bulkAvailable,
    ...event
  } = decodePacket(input);
  if (event.type === 'state_result') throw Error('Game results are consumed by the bridge');
  return event;
}
