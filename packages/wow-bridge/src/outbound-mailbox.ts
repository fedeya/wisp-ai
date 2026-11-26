import { Effect } from 'effect';
import type { addonFiles } from './addon-files.ts';
import { parseDownlinkAck, prepareDownlink } from './downlink.ts';
import {
  COMPACT_DOWNLINK_KIND,
  DOWNLINK_KIND,
  decodeFrame,
  encodeFrame,
  encodeMessage,
  FIRST,
  LAST,
  readDownlink,
} from './mailbox.ts';
import type { Packet } from './protocol.ts';
import type { makeWriter } from './writer.ts';

interface PublishedSnapshot {
  revision: number;
  json: string;
  snapshot: unknown;
}
interface DownlinkTransfer {
  snapshot: PublishedSnapshot;
  body: Buffer;
  frames: Buffer[];
  index: number;
  bulk: boolean;
  bulkSlot?: number;
  lastProgressAt: number;
  sentAt?: number;
  writes: number;
  startedAt: number;
  restarts: number;
  stallReported: boolean;
}

/** What the bridge knows about a snapshot that is taking long to reach the game. */
export interface SlowDownlink {
  phase: 'stalled' | 'delivered';
  revision: number;
  ageMs: number;
  restarts: number;
  bulk: boolean;
  frames: number;
  frame: number;
  /** Time since the game last wrote an uplink frame; small values mean it is still sending. */
  uplinkQuietMs?: number;
  uplinkBusy: boolean;
}

/** A transfer in flight this long is reported once, then again when it lands. */
export const SLOW_DOWNLINK_MS = 10_000;

export interface DownlinkCosts {
  fragmentMs: number;
  bulkMs: number;
  slotsRemaining: number;
}

/** Spend a one-use file only when its expected latency saving pays for that slot. */
export function preferBulkDelivery(bytes: number, costs: DownlinkCosts) {
  if (costs.slotsRemaining <= 0 || bytes <= 32) {
    return false;
  }
  const fragments = Math.ceil(bytes / 32);
  const remaining = Math.min(1024, Math.max(0, costs.slotsRemaining));
  // Keep increasingly scarce slots for transfers with a larger measured benefit.
  // This is a tunable policy, not an assertion of an optimal native threshold.
  const slotCostMs = 200 + 800 * (1 - remaining / 1024) ** 2;
  return fragments * costs.fragmentMs - costs.bulkMs >= slotCostMs;
}

interface Link {
  readonly files: ReturnType<typeof addonFiles>;
  readonly writer: Effect.Success<ReturnType<typeof makeWriter>>;
  readonly activeFile: () => string | undefined;
  readonly stopped: () => boolean;
  readonly uplinkBusy: (file: string) => boolean | undefined;
  readonly uplinkObservedAt: (file: string) => number | undefined;
  readonly now: () => number;
  readonly nextGeneration: () => number;
  readonly onError: (error: unknown) => void;
  readonly onSlowDownlink: (report: SlowDownlink) => void;
}

/** Downlink state is updated by the same worker that writes the game files. */
export class OutboundMailbox {
  private readonly link: Link;
  private publishedRevision = 0;
  private notification?: Buffer;
  private generation: number;
  private notificationSequence = 0;
  private mailboxVersion = false;
  private compactAck = false;
  private bulkAvailable = true;
  private latestSnapshot?: PublishedSnapshot;
  private acknowledgedSnapshot?: PublishedSnapshot;
  private downlink?: DownlinkTransfer;
  private publicationEpoch = 0;
  private lastControlWriteAt = 0;
  private published = '';
  nextSlot = 1;
  peerRevision = 0;
  performance: {
    controlWrites: number;
    wireBytes: number;
    acknowledgments: number;
    compactAcknowledgments: number;
    mailboxStarts: number;
    bulkStarts: number;
    restarts: number;
    fragmentRttMs?: number;
    bulkRttMs?: number;
  } = {
    controlWrites: 0,
    wireBytes: 0,
    acknowledgments: 0,
    compactAcknowledgments: 0,
    mailboxStarts: 0,
    bulkStarts: 0,
    restarts: 0,
  };
  constructor(link: Link) {
    this.link = link;
    this.generation = link.nextGeneration();
  }

  get reusable() {
    return this.mailboxVersion;
  }
  get compact() {
    return this.compactAck;
  }

  observe(packet: Packet) {
    return Effect.suspend(() => {
      if (
        packet.mailboxVersion !== 1 ||
        (this.mailboxVersion &&
          (!packet.compactAck || this.compactAck) &&
          (packet.bulkAvailable !== false || !this.bulkAvailable))
      ) {
        return Effect.void;
      }
      const epoch = this.publicationEpoch;
      return this.link.writer.submit(
        Effect.sync(() => {
          if (epoch !== this.publicationEpoch) return;
          this.mailboxVersion = true;
          this.compactAck ||= packet.compactAck === true;
          this.bulkAvailable &&= packet.bulkAvailable !== false;
        }),
      );
    });
  }

  acceptAck(ack: NonNullable<ReturnType<typeof parseDownlinkAck>>) {
    return this.link.writer.submit(this.acknowledgeDownlink(ack));
  }

  acceptCompactAck(frame: { generation: number; sequence: number; flags: number }) {
    const epoch = this.publicationEpoch;
    return this.link.writer.submit(
      Effect.suspend(() => {
        if (epoch !== this.publicationEpoch) return Effect.void;
        const transfer = this.downlink;
        const applied =
          transfer && (transfer.bulk || transfer.index + 1 === transfer.frames.length);
        return this.acknowledgeDownlink(
          {
            a: [
              frame.generation,
              frame.sequence,
              applied ? transfer.snapshot.revision : this.peerRevision,
            ],
            b: Boolean(frame.flags & 2),
            n: Boolean(frame.flags & 1),
          },
          true,
        );
      }),
    );
  }

  restartStalledTransfer() {
    const epoch = this.publicationEpoch;
    return this.link.writer.submit(
      Effect.sync(() => {
        const transfer = this.downlink;
        const now = this.link.now();
        if (
          this.link.stopped() ||
          epoch !== this.publicationEpoch ||
          !transfer ||
          now - transfer.lastProgressAt <= 5000
        ) {
          return;
        }
        // A lost final ACK or an interrupted receiver must not pin the lane
        // forever. A fresh FIRST frame also restarts partial reassembly.
        this.performance.restarts++;
        transfer.restarts++;
        if (!transfer.stallReported && now - transfer.startedAt >= SLOW_DOWNLINK_MS) {
          transfer.stallReported = true;
          this.reportSlowDownlink('stalled', transfer);
        }
        this.frameTransfer(transfer);
      }),
    );
  }

  repairControl(text: string) {
    const file = this.link.activeFile();
    if (
      !this.notification ||
      !this.controlPending() ||
      readDownlink(text)?.equals(this.notification) ||
      !file ||
      this.link.uplinkBusy(file) ||
      this.link.now() - this.lastControlWriteAt < 150
    ) {
      return Effect.void;
    }
    return this.link.writer
      .submit(this.writeControlFrame())
      .pipe(Effect.catch((error) => Effect.sync(() => this.link.onError(error))));
  }
  controlPending() {
    return Boolean(
      this.notification && (this.downlink || this.peerRevision < this.publishedRevision),
    );
  }
  private writeControlFrame() {
    return Effect.gen({ self: this }, function* () {
      const file = this.link.activeFile();
      const frame = this.notification;
      if (
        this.link.stopped() ||
        !file ||
        !frame ||
        !this.controlPending() ||
        this.link.uplinkBusy(file)
      ) {
        return;
      }
      const epoch = this.publicationEpoch;
      const quietMs = 5 - (this.link.now() - (this.link.uplinkObservedAt(file) || 0));
      if (quietMs > 0) {
        yield* Effect.sleep(quietMs);
      }
      const replaced = yield* this.link.files.writeControl(
        file,
        frame,
        () =>
          !this.link.stopped() &&
          this.publicationEpoch === epoch &&
          this.link.activeFile() === file &&
          this.notification === frame,
      );
      if (!replaced) return;
      this.lastControlWriteAt = this.link.now();
      this.performance.controlWrites++;
      this.performance.wireBytes += frame.length;
      if (this.downlink && this.notification === frame) {
        this.downlink.sentAt ??= this.lastControlWriteAt;
        this.downlink.writes++;
      }
    });
  }
  private reportSlowDownlink(phase: SlowDownlink['phase'], transfer: DownlinkTransfer) {
    const file = this.link.activeFile();
    const observed = file ? this.link.uplinkObservedAt(file) : undefined;
    try {
      this.link.onSlowDownlink({
        phase,
        revision: transfer.snapshot.revision,
        ageMs: this.link.now() - transfer.startedAt,
        restarts: transfer.restarts,
        bulk: transfer.bulk,
        frames: transfer.frames.length,
        frame: transfer.index,
        uplinkQuietMs: observed !== undefined ? this.link.now() - observed : undefined,
        uplinkBusy: Boolean(file && this.link.uplinkBusy(file)),
      });
    } catch (error) {
      this.link.onError(error);
    }
  }
  private clearDownlink() {
    this.downlink = undefined;
    this.latestSnapshot = undefined;
    this.acknowledgedSnapshot = undefined;
  }
  private frameTransfer(transfer: DownlinkTransfer) {
    const kind = this.compactAck ? COMPACT_DOWNLINK_KIND : DOWNLINK_KIND;
    transfer.frames = transfer.bulk
      ? [
          encodeFrame({
            kind,
            flags: FIRST | LAST,
            generation: this.generation,
            sequence: this.notificationSequence,
            payload: Buffer.from(JSON.stringify({ r: transfer.snapshot.revision })),
          }),
        ]
      : encodeMessage(transfer.body, kind, this.generation, this.notificationSequence, true);
    this.notificationSequence = (this.notificationSequence + transfer.frames.length) & 65535;
    transfer.index = 0;
    transfer.lastProgressAt = this.link.now();
    transfer.sentAt = undefined;
    transfer.writes = 0;
    if (transfer.bulk) {
      this.performance.bulkStarts++;
    } else {
      this.performance.mailboxStarts++;
    }
    this.notification = transfer.frames[0];
  }
  private startDownlink() {
    return Effect.gen({ self: this }, function* () {
      const epoch = this.publicationEpoch;
      const record = this.latestSnapshot;
      if (
        this.link.stopped() ||
        !this.mailboxVersion ||
        !this.link.activeFile() ||
        this.downlink ||
        !record ||
        record.revision <= this.peerRevision
      ) {
        return;
      }
      const prepared = prepareDownlink(record.snapshot, this.acknowledgedSnapshot?.snapshot);
      const transfer: DownlinkTransfer = {
        snapshot: record,
        body: prepared.body,
        frames: [],
        index: 0,
        bulk:
          this.bulkAvailable &&
          preferBulkDelivery(prepared.body.length, {
            fragmentMs: this.performance.fragmentRttMs ?? (this.compactAck ? 50 : 100),
            bulkMs: this.performance.bulkRttMs ?? 150,
            slotsRemaining: 1025 - this.nextSlot,
          }),
        bulkSlot: this.nextSlot,
        lastProgressAt: this.link.now(),
        writes: 0,
        startedAt: this.link.now(),
        restarts: 0,
        stallReported: false,
      };
      this.downlink = transfer;
      if (transfer.bulk) {
        // Bulk files are an acceleration, never a prerequisite for progress.
        transfer.bulk = yield* this.link.files.writePayload(record.json).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      }
      if (epoch !== this.publicationEpoch || this.link.stopped()) {
        return;
      }
      this.frameTransfer(transfer);
      yield* this.writeControlFrame();
    });
  }
  private finishDownlink(revision: number) {
    const transfer = this.downlink;
    if (!transfer || revision < transfer.snapshot.revision) {
      return false;
    }
    const record =
      transfer.snapshot.revision === revision
        ? transfer.snapshot
        : this.latestSnapshot?.revision === revision
          ? this.latestSnapshot
          : undefined;
    if (!record) {
      return false;
    }
    if (transfer.bulk && transfer.bulkSlot !== undefined) {
      // Raw transport ACKs do not carry an application cursor. Account for a
      // confirmed bulk read here so scarcity estimates do not wait for the
      // next user message; max also avoids counting a newer app cursor twice.
      this.nextSlot = Math.max(this.nextSlot, Math.min(1024, transfer.bulkSlot + 1));
    }
    if (transfer.stallReported || this.link.now() - transfer.startedAt >= SLOW_DOWNLINK_MS) {
      this.reportSlowDownlink('delivered', transfer);
    }
    this.peerRevision = Math.max(this.peerRevision, revision);
    this.acknowledgedSnapshot = record;
    this.downlink = undefined;
    this.notification = undefined;
    return true;
  }
  private acknowledgeDownlink(
    ack: NonNullable<ReturnType<typeof parseDownlinkAck>>,
    compact = false,
  ) {
    const epoch = this.publicationEpoch;
    return Effect.gen({ self: this }, function* () {
      if (this.link.stopped() || epoch !== this.publicationEpoch) return;
      const transfer = this.downlink;
      const frame = this.notification && decodeFrame(this.notification);
      if (!transfer || !frame || ack.a[0] !== frame.generation || ack.a[1] !== frame.sequence) {
        return;
      }
      this.performance.acknowledgments++;
      if (compact) {
        this.performance.compactAcknowledgments++;
      }
      const sample = transfer.sentAt === undefined ? undefined : this.link.now() - transfer.sentAt;
      if (
        !ack.n &&
        transfer.writes === 1 &&
        sample !== undefined &&
        sample >= 1 &&
        sample <= 2000
      ) {
        const key = transfer.bulk ? 'bulkRttMs' : 'fragmentRttMs';
        const previous = this.performance[key];
        this.performance[key] = previous === undefined ? sample : previous * 0.8 + sample * 0.2;
      }
      this.bulkAvailable &&= ack.b;
      transfer.lastProgressAt = this.link.now();
      const finalFragment = !transfer.bulk && transfer.index + 1 === transfer.frames.length;
      if (ack.n || (finalFragment && ack.a[2] !== transfer.snapshot.revision)) {
        // A decoder/base mismatch needs a full snapshot, not a repeated patch.
        this.acknowledgedSnapshot = undefined;
        this.downlink = undefined;
        this.notification = undefined;
        yield* this.startDownlink();
      } else if (transfer.bulk) {
        if (ack.a[2] >= transfer.snapshot.revision) {
          if (this.finishDownlink(ack.a[2])) yield* this.startDownlink();
        } else if (!ack.b) {
          transfer.bulk = false;
          this.frameTransfer(transfer);
          yield* this.writeControlFrame();
        }
      } else if (finalFragment) {
        if (this.finishDownlink(ack.a[2])) yield* this.startDownlink();
      } else {
        transfer.index++;
        transfer.sentAt = undefined;
        transfer.writes = 0;
        this.notification = transfer.frames[transfer.index];
        yield* this.writeControlFrame();
      }
    });
  }
  publish(snapshot: unknown) {
    return Effect.suspend(() => {
      const json = JSON.stringify(snapshot);
      const revision = (snapshot as { rev?: unknown } | null)?.rev;
      const epoch = this.publicationEpoch;
      return this.link.writer.submit(
        Effect.gen({ self: this }, function* () {
          if (this.link.stopped() || epoch !== this.publicationEpoch || json === this.published) {
            return;
          }
          this.published = json;
          if (this.mailboxVersion && Number.isSafeInteger(revision) && Number(revision) > 0) {
            this.publishedRevision = Number(revision);
            this.latestSnapshot = {
              revision: Number(revision),
              json,
              snapshot: JSON.parse(json),
            };
            yield* this.startDownlink();
            return;
          }
          yield* this.link.files.writePayload(json);
          if (this.link.stopped() || epoch !== this.publicationEpoch) return;
          if (Number.isSafeInteger(revision) && Number(revision) > 0) {
            this.publishedRevision = Number(revision);
            this.notification = encodeFrame({
              kind: DOWNLINK_KIND,
              flags: FIRST | LAST,
              generation: this.generation,
              sequence: this.notificationSequence,
              payload: Buffer.from(JSON.stringify({ r: revision })),
            });
            this.notificationSequence = (this.notificationSequence + 1) & 65535;
            yield* this.writeControlFrame();
          }
        }).pipe(
          Effect.tapCause(() =>
            Effect.sync(() => {
              if (this.published === json) this.published = '';
            }),
          ),
        ),
      );
    });
  }
  waitForWrites() {
    return this.link.writer.submit(Effect.void);
  }
  setCursor(slot: number, receivedRevision: number) {
    return Effect.suspend(() => {
      const epoch = this.publicationEpoch;
      return this.link.writer.submit(
        Effect.gen({ self: this }, function* () {
          if (this.link.stopped() || epoch !== this.publicationEpoch) return;
          this.nextSlot = Math.max(this.nextSlot, slot);
          if (
            !this.mailboxVersion ||
            receivedRevision === this.peerRevision ||
            receivedRevision === this.downlink?.snapshot.revision ||
            receivedRevision === this.latestSnapshot?.revision ||
            receivedRevision === this.acknowledgedSnapshot?.revision
          ) {
            this.peerRevision = Math.max(this.peerRevision, receivedRevision);
          }
          if (
            this.mailboxVersion &&
            this.downlink &&
            receivedRevision === this.downlink.snapshot.revision &&
            this.finishDownlink(receivedRevision)
          ) {
            yield* this.startDownlink().pipe(
              Effect.catch((error) => Effect.sync(() => this.link.onError(error))),
            );
          }
        }),
      );
    });
  }
  resetSession(hello?: Packet) {
    // Invalidate queued publications before waiting on the writer.
    return Effect.suspend(() => {
      const epoch = ++this.publicationEpoch;
      return this.link.writer.submit(
        Effect.sync(() => {
          if (epoch !== this.publicationEpoch) return;
          if (hello) {
            this.mailboxVersion = hello.mailboxVersion === 1;
            this.compactAck = this.mailboxVersion && hello.compactAck === true;
            this.bulkAvailable = hello.bulkAvailable !== false;
          }
          this.nextSlot = 1;
          this.peerRevision = 0;
          this.published = '';
          this.publishedRevision = 0;
          this.notification = undefined;
          this.clearDownlink();
          this.generation = this.link.nextGeneration();
          this.notificationSequence = 0;
        }),
      );
    });
  }
}
