import { test, expect } from 'vitest';
import {
  MailboxDecoder,
  UPLINK_KIND,
  inflateMessage,
} from '../../packages/protocol/src/mailbox.ts';
import { observeQuestRewards } from './quest-rewards-fixture.ts';

test(
  'maximum quest observation traverses production Send and checked decoder with real fixture JSON/zlib',
  { timeout: 30_000 },
  () => {
    const fixture = observeQuestRewards({ maximum: true, transport: true });
    const decoder = new MailboxDecoder(UPLINK_KIND);
    const decoded = fixture.frames.map((frame: Buffer) => decoder.add(frame)).filter(Boolean);
    expect(decoded).toHaveLength(1);
    const packet = JSON.parse(inflateMessage(decoded[0]).toString('utf8'));
    expect(packet.type).toBe('state_result');
    expect(packet.requestId).toBe('max-rewards');
    expect(packet.data).toEqual(fixture.observation);
    expect(packet.data.status).toBe('available');
    const data = packet.data.data;
    expect(data.choices.options).toHaveLength(10);
    expect(data.guaranteed.options).toHaveLength(10);
    expect(data.choices.options.every((item: any) => item.comparisons.length === 2)).toBe(true);
    expect(data.guaranteed.options.every((item: any) => item.comparisons.length === 2)).toBe(true);
    expect(data.choices.optionsTruncated).toBe(false);
    expect(data.truncated).toBe(true);
    expect(data.titleTruncated).toBe(true);
    expect(data.choices.options[0].nameTruncated).toBe(true);
    expect(data.choices.options[0].comparisons[0].equipped.nameTruncated).toBe(true);
    expect(data.choices.options[9].stats).toBeUndefined();
    expect(data.choices.options[9].statsReason).toBe('observation_stat_limit');
    expect(fixture.serializedBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(fixture.compressedBytes).toBeLessThanOrEqual(65535);
    expect(fixture.frames.length).toBeGreaterThan(1);
    console.info(
      `Maximum quest fixture: ${fixture.serializedBytes} JSON bytes, ${fixture.compressedBytes} zlib bytes, ${fixture.frames.length} checked frames`,
    );
  },
);
