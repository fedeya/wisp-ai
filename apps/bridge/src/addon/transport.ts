import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { luaJson, packetSchema, type Packet } from '@wisp/protocol/protocol';
import {
  MailboxDecoder,
  UPLINK_KIND,
  DOWNLINK_KIND,
  COMPACT_ACK_KIND,
  COMPACT_DOWNLINK_KIND,
  FIRST,
  LAST,
  decodeFrame,
  encodeFrame,
  encodeMessage,
  inflateMessage,
  readUplink,
  readDownlink,
  replaceDownlink,
} from '@wisp/protocol/mailbox';
import { parseDownlinkAck, prepareDownlink } from '@wisp/protocol/downlink';

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
}

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

/**
 * A game window that sent anything this recently keeps the bridge: another window's
 * periodic heartbeat (every 60 seconds) cannot take it. Two windows otherwise steal
 * the session from each other on every heartbeat, interrupting turns each time.
 */
export const ACTIVE_SESSION_MS = 150_000;

/** How often the fallback tick walks every character folder once a session is active. */
export const FULL_SCAN_INTERVAL_MS = 5000;

export class DiskTransport {
  private scans?: Promise<void>;
  private reads = new Map<string, Promise<void>>();
  private onError: (error: unknown) => void;
  private mailboxDecoders = new Map<string, MailboxDecoder>();
  private activeFile?: string;
  private activeSession?: string;
  private activeAt = 0;
  /** Wall-clock time of the last message from the active window. */
  private activeSeenAt = 0;
  private onHeldOff: (session: string) => void;
  private uplinkBusy = new Map<string, boolean>();
  private uplinkObserved = new Map<string, { frame: Buffer; at: number }>();
  private publishedRevision = 0;
  private notification?: Buffer;
  private generation = randomBytes(4).readUInt32BE() || 1;
  private notificationSequence = 0;
  private mailboxVersion = false;
  private compactAck = false;
  private bulkAvailable = true;
  private latestSnapshot?: PublishedSnapshot;
  private acknowledgedSnapshot?: PublishedSnapshot;
  private downlink?: DownlinkTransfer;
  private publicationEpoch = 0;
  private controlTimer?: ReturnType<typeof setInterval>;
  private controlWriting?: Promise<void>;
  private lastControlWriteAt = 0;
  stopped = false;
  published = '';
  timer?: ReturnType<typeof setInterval>;
  nextSlot = 1;
  peerRevision = 0;
  writing = Promise.resolve();
  watchers = new Map<string, FSWatcher>();
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
  wow: string;
  receive: (packet: Packet) => void;
  constructor(
    wow: string,
    receive: (packet: Packet) => void,
    onError: (error: unknown) => void = console.error,
    onHeldOff: (session: string) => void = () => {},
  ) {
    this.wow = wow;
    this.receive = receive;
    this.onError = onError;
    this.onHeldOff = onHeldOff;
  }
  async start() {
    await this.scan(true);
    if (this.stopped) return;
    let lastScanAt = Date.now();
    this.timer = setInterval(() => {
      if (this.scans) return;
      // Folder watchers deliver most changes; this tick is the fallback.
      // Walking every character folder and rereading every state file each
      // second costs I/O that grows with the number of characters, so once a
      // game session is active only its file is reread every second and the
      // full walk (new characters, character switches) runs less often.
      const active = this.activeFile;
      const work =
        !active || Date.now() - lastScanAt >= FULL_SCAN_INTERVAL_MS
          ? ((lastScanAt = Date.now()), this.scan(false))
          : this.read(active, false);
      this.scans = work.catch(this.onError).finally(() => {
        this.scans = undefined;
      });
    }, 1000);
    this.controlTimer = setInterval(() => {
      if (this.activeFile && this.controlPending()) {
        const transfer = this.downlink;
        if (transfer && Date.now() - transfer.lastProgressAt > 5000) {
          // A lost final ACK or an interrupted receiver must not pin the lane
          // forever. A fresh FIRST frame also restarts partial reassembly.
          this.performance.restarts++;
          this.frameTransfer(transfer);
        }
        void this.read(this.activeFile, false).catch(this.onError);
      }
    }, 150);
  }
  async scan(baseline: boolean) {
    const account = path.join(this.wow, 'WTF', 'Account');
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (this.stopped || depth > 4) {
        return;
      }
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (this.stopped) return;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(file, depth + 1);
        } else if (entry.name.toLowerCase() === 'addons.txt') {
          if (!this.mailboxDecoders.has(file)) {
            this.mailboxDecoders.set(file, new MailboxDecoder(UPLINK_KIND));
          }
          this.watchDirectory(dir, file);
          await this.read(file, baseline);
        }
      }
    };
    await walk(account, 0);
  }
  /**
   * Watch a character folder for state-file changes. The watch only speeds up
   * reads; the one-second scan still finds every change. A watcher that fails
   * (for example because its folder was deleted or renamed) is closed and
   * dropped instead of raising an unhandled 'error' event, which would end the
   * bridge process; the next scan that still finds the folder watches it again.
   */
  private watchDirectory(dir: string, file: string) {
    if (this.stopped || this.watchers.has(dir)) {
      return;
    }
    let watcher: FSWatcher;
    try {
      watcher = watch(dir, (_, name) => {
        if (String(name).toLowerCase() === 'addons.txt') {
          void this.read(file, false).catch(this.onError);
        }
      });
    } catch (error) {
      this.onError(error);
      return;
    }
    watcher.on('error', (error) => {
      watcher.close();
      if (this.watchers.get(dir) === watcher) {
        this.watchers.delete(dir);
      }
      if (!this.stopped) {
        this.onError(error);
      }
    });
    this.watchers.set(dir, watcher);
  }
  async read(file: string, baseline: boolean) {
    if (this.stopped) return;
    const work = (this.reads.get(file) || Promise.resolve())
      .catch(() => {})
      .then(() => this.readCurrent(file, baseline));
    this.reads.set(file, work);
    try {
      await work;
    } finally {
      if (this.reads.get(file) === work) {
        this.reads.delete(file);
      }
    }
  }
  private async readCurrent(file: string, baseline: boolean) {
    if (this.stopped) {
      return;
    }
    let text;
    try {
      text = await this.sharedFile(() => readFile(file, 'utf8'));
    } catch {
      return;
    }
    if (this.stopped) return;
    const mailboxFrame = readUplink(text);
    let mailboxDecoder = this.mailboxDecoders.get(file);
    if (!mailboxDecoder) {
      mailboxDecoder = new MailboxDecoder(UPLINK_KIND);
      this.mailboxDecoders.set(file, mailboxDecoder);
    }
    if (baseline) {
      // State files persist across host restarts and addon downgrades. Never
      // replay an on-disk operation merely because it fits in a single frame.
      if (mailboxFrame) {
        mailboxDecoder.baseline(mailboxFrame);
      }
      return;
    }
    const compact = mailboxFrame && decodeFrame(mailboxFrame.subarray(0, 16));
    if (compact?.kind === COMPACT_ACK_KIND) {
      if (file === this.activeFile && this.mailboxVersion && this.compactAck) {
        this.uplinkBusy.set(file, false);
        if (!this.uplinkObserved.get(file)?.frame.equals(mailboxFrame!)) {
          this.uplinkObserved.set(file, { frame: mailboxFrame!, at: Date.now() });
        }
        const transfer = this.downlink;
        const applied =
          transfer && (transfer.bulk || transfer.index + 1 === transfer.frames.length);
        await this.acknowledgeDownlink(
          {
            a: [
              compact.generation,
              compact.sequence,
              applied ? transfer.snapshot.revision : this.peerRevision,
            ],
            b: Boolean(compact.flags & 2),
            n: Boolean(compact.flags & 1),
          },
          true,
        );
      }
    } else if (mailboxFrame) {
      const parsed = decodeFrame(mailboxFrame);
      if (parsed?.kind === UPLINK_KIND) {
        if (!this.uplinkObserved.get(file)?.frame.equals(mailboxFrame)) {
          this.uplinkObserved.set(file, { frame: mailboxFrame, at: Date.now() });
        }
        this.uplinkBusy.set(file, !(parsed.flags & LAST));
        const message = mailboxDecoder.add(mailboxFrame);
        if (message) {
          let value: unknown;
          let packet: Packet | undefined;
          try {
            value = JSON.parse(inflateMessage(message).toString('utf8'));
            const ack = message.flags === 0 && parseDownlinkAck(value);
            if (ack) {
              if (file === this.activeFile && this.mailboxVersion) {
                await this.acknowledgeDownlink(ack);
              }
            } else {
              packet = packetSchema.parse(value);
            }
          } catch {
            // Corrupt, oversized or schema-invalid messages wait for the game's
            // existing application-level resend; never dispatch partial data.
          }
          if (packet?.transportVersion === 2) {
            if (
              packet.type === 'hello' &&
              (!this.activeFile || this.activeSession !== packet.session)
            ) {
              // Ignore old sessions from inactive historical character files.
              if (this.activeFile && packet.at < this.activeAt) {
                packet = undefined;
              } else if (
                this.activeFile &&
                packet.heartbeat &&
                !packet.takeover &&
                Date.now() - this.activeSeenAt < ACTIVE_SESSION_MS
              ) {
                // Another game window's periodic heartbeat never takes a session
                // that is still in use; only its player's own request can.
                this.onHeldOff(packet.session);
                packet = undefined;
              } else {
                this.activeFile = file;
                this.activeSession = packet.session;
                this.notification = undefined;
                this.publishedRevision = 0;
                this.published = '';
                this.clearDownlink();
                this.mailboxVersion = packet.mailboxVersion === 1;
                this.compactAck = packet.mailboxVersion === 1 && packet.compactAck === true;
                this.bulkAvailable = packet.bulkAvailable !== false;
              }
            }
            if (packet && file === this.activeFile && packet.session === this.activeSession) {
              this.activeAt = Math.max(this.activeAt, packet.at);
              this.activeSeenAt = Date.now();
              if (packet.mailboxVersion === 1) {
                this.mailboxVersion = true;
                this.compactAck ||= packet.compactAck === true;
                this.bulkAvailable &&= packet.bulkAvailable !== false;
              }
              // Duplicates (application resends) are expected here: the packet
              // receiver dedupes by session and sequence and re-acknowledges them.
              this.receive(packet);
            }
          }
        }
      }
    }
    if (file === this.activeFile) {
      this.repairControl(text);
    }
  }
  private repairControl(text: string) {
    if (
      !this.notification ||
      !this.controlPending() ||
      readDownlink(text)?.equals(this.notification) ||
      !this.activeFile ||
      this.uplinkBusy.get(this.activeFile) ||
      Date.now() - this.lastControlWriteAt < 150
    ) {
      return;
    }
    void this.writeControl().catch(this.onError);
  }
  private controlPending() {
    return Boolean(
      this.notification && (this.downlink || this.peerRevision < this.publishedRevision),
    );
  }
  private async sharedFile<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 8 || !['EBUSY', 'EPERM', 'EACCES', 'ENOENT'].includes(code || '')) {
          throw error;
        }
        await delay(4 * (attempt + 1));
      }
    }
  }
  private writeControl(): Promise<void> {
    if (this.controlWriting) {
      return this.controlWriting;
    }
    const work = (async () => {
      const file = this.activeFile;
      const frame = this.notification;
      if (this.stopped || !file || !frame || !this.controlPending() || this.uplinkBusy.get(file)) {
        return;
      }
      const quietMs = 5 - (Date.now() - (this.uplinkObserved.get(file)?.at || 0));
      if (quietMs > 0) {
        await delay(quietMs);
      }
      const current = await this.sharedFile(() => readFile(file, 'utf8'));
      // An empty file is one being rewritten (truncated, not yet written).
      // Replacing it would drop the writer's uplink frame and every other
      // addon's setting; the watchdog retries once the content is back.
      if (!current.trim()) {
        return;
      }
      if (
        this.stopped ||
        this.activeFile !== file ||
        this.notification !== frame ||
        readDownlink(current)?.equals(frame)
      ) {
        return;
      }
      // The game owns the uplink lane. Pause control writes while a multi-frame
      // message is in flight, avoiding replacement of its next fragment.
      const incoming = readUplink(current);
      const parsed = incoming && decodeFrame(incoming);
      if (parsed?.kind === UPLINK_KIND && !(parsed.flags & LAST)) {
        return;
      }
      const temporary = file + '.wisp-control.tmp';
      await writeFile(temporary, replaceDownlink(current, frame), 'utf8');
      let replaced = false;
      try {
        if (this.stopped || this.activeFile !== file || this.notification !== frame) {
          return;
        }
        const latest = await this.sharedFile(() => readFile(file, 'utf8'));
        // Preserve concurrent game packets and unrelated user addon settings.
        // A changed file is retried from a fresh snapshot by the watchdog.
        if (latest !== current) {
          return;
        }
        await this.sharedFile(() => rename(temporary, file));
        replaced = true;
      } finally {
        // An abandoned write must not leave its copy beside the game's files.
        if (!replaced) {
          await rm(temporary, { force: true }).catch(() => {});
        }
      }
      this.lastControlWriteAt = Date.now();
      this.performance.controlWrites++;
      this.performance.wireBytes += frame.length;
      if (this.downlink && this.notification === frame) {
        this.downlink.sentAt ??= this.lastControlWriteAt;
        this.downlink.writes++;
      }
    })();
    this.controlWriting = work;
    void work
      .finally(() => {
        if (this.controlWriting === work) {
          this.controlWriting = undefined;
        }
      })
      .catch(() => {});
    return work;
  }
  private async writePayload(json: string) {
    const file = path.join(this.wow, 'Interface', 'AddOns', 'WispAI_Payload', 'Payload.lua');
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await writeFile(tmp, luaJson(json), 'utf8');
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, file);
        break;
      } catch (error) {
        if (attempt >= 5) {
          throw error;
        }
        await delay(30);
      }
    }
  }
  private clearDownlink() {
    this.downlink = undefined;
    this.latestSnapshot = undefined;
    this.acknowledgedSnapshot = undefined;
    this.publicationEpoch++;
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
    transfer.lastProgressAt = Date.now();
    transfer.sentAt = undefined;
    transfer.writes = 0;
    if (transfer.bulk) {
      this.performance.bulkStarts++;
    } else {
      this.performance.mailboxStarts++;
    }
    this.notification = transfer.frames[0];
  }
  private async startDownlink() {
    const record = this.latestSnapshot;
    if (
      this.stopped ||
      !this.mailboxVersion ||
      !this.activeFile ||
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
      lastProgressAt: Date.now(),
      writes: 0,
    };
    this.downlink = transfer;
    if (transfer.bulk) {
      try {
        await this.writePayload(record.json);
      } catch {
        // Bulk files are an acceleration, never a prerequisite for progress.
        transfer.bulk = false;
      }
    }
    if (this.downlink !== transfer || this.stopped) {
      return;
    }
    this.frameTransfer(transfer);
    await this.writeControl();
  }
  private queueDownlink() {
    const epoch = this.publicationEpoch;
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        if (epoch === this.publicationEpoch) {
          await this.startDownlink();
        }
      });
    void this.writing.catch(this.onError);
  }
  private finishDownlink(revision: number) {
    const transfer = this.downlink;
    if (!transfer || revision < transfer.snapshot.revision) {
      return;
    }
    const record =
      transfer.snapshot.revision === revision
        ? transfer.snapshot
        : this.latestSnapshot?.revision === revision
          ? this.latestSnapshot
          : undefined;
    if (!record) {
      return;
    }
    if (transfer.bulk && transfer.bulkSlot !== undefined) {
      // Raw transport ACKs do not carry an application cursor. Account for a
      // confirmed bulk read here so scarcity estimates do not wait for the
      // next user message; max also avoids counting a newer app cursor twice.
      this.nextSlot = Math.max(this.nextSlot, Math.min(1024, transfer.bulkSlot + 1));
    }
    this.peerRevision = Math.max(this.peerRevision, revision);
    this.acknowledgedSnapshot = record;
    this.downlink = undefined;
    this.notification = undefined;
    this.queueDownlink();
  }
  private async acknowledgeDownlink(
    ack: NonNullable<ReturnType<typeof parseDownlinkAck>>,
    compact = false,
  ) {
    const transfer = this.downlink;
    const frame = this.notification && decodeFrame(this.notification);
    if (!transfer || !frame || ack.a[0] !== frame.generation || ack.a[1] !== frame.sequence) {
      return;
    }
    this.performance.acknowledgments++;
    if (compact) {
      this.performance.compactAcknowledgments++;
    }
    const sample = transfer.sentAt === undefined ? undefined : Date.now() - transfer.sentAt;
    if (!ack.n && transfer.writes === 1 && sample !== undefined && sample >= 1 && sample <= 2000) {
      const key = transfer.bulk ? 'bulkRttMs' : 'fragmentRttMs';
      const previous = this.performance[key];
      this.performance[key] = previous === undefined ? sample : previous * 0.8 + sample * 0.2;
    }
    this.bulkAvailable &&= ack.b;
    transfer.lastProgressAt = Date.now();
    if (ack.n) {
      this.acknowledgedSnapshot = undefined;
      this.downlink = undefined;
      this.notification = undefined;
      this.queueDownlink();
    } else if (transfer.bulk) {
      if (ack.a[2] >= transfer.snapshot.revision) {
        this.finishDownlink(ack.a[2]);
      } else if (!ack.b) {
        transfer.bulk = false;
        this.frameTransfer(transfer);
        await this.writeControl();
      }
    } else if (transfer.index + 1 < transfer.frames.length) {
      transfer.index++;
      transfer.sentAt = undefined;
      transfer.writes = 0;
      this.notification = transfer.frames[transfer.index];
      await this.writeControl();
    } else if (ack.a[2] === transfer.snapshot.revision) {
      this.finishDownlink(ack.a[2]);
    } else {
      // A decoder/base mismatch needs a full snapshot, not a repeated patch.
      this.acknowledgedSnapshot = undefined;
      this.downlink = undefined;
      this.notification = undefined;
      this.queueDownlink();
    }
  }
  publish(snapshot: unknown) {
    const json = JSON.stringify(snapshot);
    const revision = (snapshot as { rev?: unknown } | null)?.rev;
    if (json === this.published) {
      return this.writing;
    }
    this.published = json;
    const epoch = this.publicationEpoch;
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        if (this.stopped || epoch !== this.publicationEpoch) {
          return;
        }
        if (this.mailboxVersion && Number.isSafeInteger(revision) && Number(revision) > 0) {
          this.publishedRevision = Number(revision);
          this.latestSnapshot = {
            revision: Number(revision),
            json,
            snapshot: JSON.parse(json),
          };
          await this.startDownlink();
          return;
        }
        await this.writePayload(json);
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
          await this.writeControl();
        }
      })
      .catch((error) => {
        if (this.published === json) {
          this.published = '';
        }
        throw error;
      });
    return this.writing;
  }
  setCursor(slot: number, receivedRevision: number) {
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
      receivedRevision === this.downlink.snapshot.revision
    ) {
      this.finishDownlink(receivedRevision);
    }
  }
  resetSession() {
    this.nextSlot = 1;
    this.peerRevision = 0;
    this.published = '';
    this.publishedRevision = 0;
    this.notification = undefined;
    this.clearDownlink();
    this.generation = randomBytes(4).readUInt32BE() || 1;
    this.notificationSequence = 0;
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.controlTimer);
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    await Promise.allSettled([this.scans, ...this.reads.values()]);
    await Promise.allSettled([this.writing, this.controlWriting]);
  }
}
