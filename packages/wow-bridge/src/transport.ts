import {
  Cause,
  Clock,
  Deferred,
  Effect,
  FiberSet,
  FileSystem,
  Path,
  Random,
  Schedule,
  Semaphore,
  Stream,
} from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { luaJson, packetSchema, type Packet } from './protocol.ts';
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
} from './mailbox.ts';
import { parseDownlinkAck, prepareDownlink } from './downlink.ts';

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

/**
 * A game window that sent anything this recently keeps the bridge: another window's
 * periodic heartbeat (every 60 seconds) cannot take it. Two windows otherwise steal
 * the session from each other on every heartbeat, interrupting turns each time.
 */
export const ACTIVE_SESSION_MS = 150_000;

/** How often the fallback tick walks every character folder once a session is active. */
export const FULL_SCAN_INTERVAL_MS = 5000;

export class DiskTransport {
  private reads = new Map<string, Semaphore.Semaphore>();
  private readonly writeLock = Semaphore.makeUnsafe(1);
  private mailboxDecoders = new Map<string, MailboxDecoder>();
  private activeFile?: string;
  private activeSession?: string;
  private activeAt = 0;
  /** Wall-clock time of the last message from the active window. */
  private activeSeenAt = 0;
  private uplinkBusy = new Map<string, boolean>();
  private uplinkObserved = new Map<string, { frame: Buffer; at: number }>();
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
  private controlWriting?: Deferred.Deferred<void, PlatformError>;
  private lastControlWriteAt = 0;
  stopped = false;
  published = '';
  nextSlot = 1;
  peerRevision = 0;
  readonly watchers = new Set<string>();
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
  private readonly fs: FileSystem.FileSystem;
  private readonly path: Path.Path;
  private readonly clock: Clock.Clock;
  private readonly random: Random.Random;
  private readonly fibers: FiberSet.FiberSet;
  private readonly runBackground: (effect: Effect.Effect<void>) => unknown;
  readonly wow: string;
  private readonly receive: (packet: Packet) => void;
  private readonly onError: (error: unknown) => void;
  private readonly onHeldOff: (session: string) => void;
  private readonly onSlowDownlink: (report: SlowDownlink) => void;

  private constructor(options: {
    fs: FileSystem.FileSystem;
    path: Path.Path;
    clock: Clock.Clock;
    random: Random.Random;
    fibers: FiberSet.FiberSet;
    runBackground: (effect: Effect.Effect<void>) => unknown;
    wow: string;
    receive: (packet: Packet) => void;
    onError: (error: unknown) => void;
    onHeldOff: (session: string) => void;
    onSlowDownlink: (report: SlowDownlink) => void;
  }) {
    this.fs = options.fs;
    this.path = options.path;
    this.clock = options.clock;
    this.random = options.random;
    this.fibers = options.fibers;
    this.runBackground = options.runBackground;
    this.wow = options.wow;
    this.receive = options.receive;
    this.onError = options.onError;
    this.onHeldOff = options.onHeldOff;
    this.onSlowDownlink = options.onSlowDownlink;
    this.generation = this.nextGeneration();
  }

  static readonly make = Effect.fnUntraced(function* (
    wow: string,
    receive: (packet: Packet) => void,
    onError: (error: unknown) => void = console.error,
    onHeldOff: (session: string) => void = () => {},
    onSlowDownlink: (report: SlowDownlink) => void = () => {},
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const clock = yield* Clock.Clock;
    const random = yield* Random.Random;
    const fibers = yield* FiberSet.make();
    const runBackground = yield* FiberSet.runtime(fibers)();
    const transport = new DiskTransport({
      fs,
      path,
      clock,
      random,
      fibers,
      runBackground,
      wow,
      receive,
      onError,
      onHeldOff,
      onSlowDownlink,
    });
    yield* Effect.addFinalizer(() => transport.stop());
    return transport;
  });

  private nextGeneration() {
    return this.random.nextIntUnsafe() >>> 0 || 1;
  }

  private now() {
    return this.clock.currentTimeMillisUnsafe();
  }

  start() {
    return Effect.gen({ self: this }, function* () {
      yield* this.scan(true);
      if (this.stopped) return;
      let lastScanAt = this.now();
      // Watchers deliver most changes. The fallback polls the active file more
      // frequently than it walks all character directories.
      const poll = Effect.suspend(() => {
        const active = this.activeFile;
        const now = this.now();
        if (active && now - lastScanAt < FULL_SCAN_INTERVAL_MS) return this.read(active, false);
        lastScanAt = now;
        return this.scan(false);
      });
      const control = Effect.suspend(() => {
        if (!this.activeFile || !this.controlPending()) return Effect.void;
        const transfer = this.downlink;
        const now = this.now();
        if (transfer && now - transfer.lastProgressAt > 5000) {
          // A lost final ACK or an interrupted receiver must not pin the lane
          // forever. A fresh FIRST frame also restarts partial reassembly.
          this.performance.restarts++;
          transfer.restarts++;
          if (!transfer.stallReported && now - transfer.startedAt >= SLOW_DOWNLINK_MS) {
            transfer.stallReported = true;
            this.reportSlowDownlink('stalled', transfer);
          }
          this.frameTransfer(transfer);
        }
        return this.read(this.activeFile, false);
      });
      this.runBackground(
        poll.pipe(
          Effect.catch((error) => Effect.sync(() => this.onError(error))),
          Effect.schedule(Schedule.fixed(1000)),
          Effect.asVoid,
        ),
      );
      this.runBackground(
        control.pipe(
          Effect.catch((error) => Effect.sync(() => this.onError(error))),
          Effect.schedule(Schedule.fixed(150)),
          Effect.asVoid,
        ),
      );
    });
  }
  scan(baseline: boolean) {
    const account = this.path.join(this.wow, 'WTF', 'Account');
    const walk = (dir: string, depth: number): Effect.Effect<void, PlatformError> =>
      Effect.gen({ self: this }, function* () {
        if (this.stopped || depth > 4) {
          return;
        }
        const entries = yield* this.fs
          .readDirectoryEntries(dir)
          .pipe(Effect.orElseSucceed(() => []));
        for (const entry of entries) {
          if (this.stopped) return;
          const file = this.path.join(dir, entry.name);
          if (entry.type === 'Directory') {
            yield* walk(file, depth + 1);
          } else if (entry.name.toLowerCase() === 'addons.txt') {
            if (!this.mailboxDecoders.has(file)) {
              this.mailboxDecoders.set(file, new MailboxDecoder(UPLINK_KIND));
            }
            this.watchDirectory(dir, file);
            yield* this.read(file, baseline);
          }
        }
      });
    return walk(account, 0);
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
    this.watchers.add(dir);
    const watch = this.fs.watch(dir).pipe(
      Stream.filter((event) => this.path.basename(event.path).toLowerCase() === 'addons.txt'),
      Stream.runForEach(() =>
        this.read(file, false).pipe(
          Effect.catch((error) => Effect.sync(() => this.onError(error))),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (!this.stopped && !Cause.hasInterruptsOnly(cause)) this.onError(Cause.squash(cause));
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          this.watchers.delete(dir);
        }),
      ),
    );
    this.runBackground(watch);
  }
  read(file: string, baseline: boolean) {
    return Effect.suspend(() => {
      if (this.stopped) return Effect.void;
      let lock = this.reads.get(file);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        this.reads.set(file, lock);
      }
      return lock.withPermit(this.readCurrent(file, baseline));
    });
  }
  private readCurrent(file: string, baseline: boolean) {
    return Effect.gen({ self: this }, function* () {
      if (this.stopped) {
        return;
      }
      const text = yield* this.sharedFile(this.fs.readFileString(file)).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (this.stopped || text === undefined) return;
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
            this.uplinkObserved.set(file, { frame: mailboxFrame!, at: this.now() });
          }
          const transfer = this.downlink;
          const applied =
            transfer && (transfer.bulk || transfer.index + 1 === transfer.frames.length);
          yield* this.acknowledgeDownlink(
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
            this.uplinkObserved.set(file, { frame: mailboxFrame, at: this.now() });
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
                  yield* this.acknowledgeDownlink(ack).pipe(Effect.ignore);
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
                  this.now() - this.activeSeenAt < ACTIVE_SESSION_MS
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
                this.activeSeenAt = this.now();
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
    });
  }
  private repairControl(text: string) {
    if (
      !this.notification ||
      !this.controlPending() ||
      readDownlink(text)?.equals(this.notification) ||
      !this.activeFile ||
      this.uplinkBusy.get(this.activeFile) ||
      this.now() - this.lastControlWriteAt < 150
    ) {
      return;
    }
    this.runBackground(
      this.writeControl().pipe(Effect.catch((error) => Effect.sync(() => this.onError(error)))),
    );
  }
  private controlPending() {
    return Boolean(
      this.notification && (this.downlink || this.peerRevision < this.publishedRevision),
    );
  }
  private sharedFile<T>(operation: Effect.Effect<T, PlatformError>) {
    return operation.pipe(
      Effect.retry({
        schedule: Schedule.recurs(8).pipe(
          Schedule.addDelay(({ attempt }) => Effect.succeed(4 * attempt)),
        ),
        while: (error) => ['Busy', 'PermissionDenied', 'NotFound'].includes(error.reason._tag),
      }),
    );
  }
  private writeControl() {
    return Effect.gen({ self: this }, function* () {
      // Claim the slot before yielding; concurrent callers share this write's result.
      const current = this.controlWriting;
      if (current) return yield* Deferred.await(current);
      const reply = Deferred.makeUnsafe<void, PlatformError>();
      this.controlWriting = reply;
      yield* this.writeControlFrame().pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            this.controlWriting = undefined;
            Deferred.doneUnsafe(reply, exit);
          }),
        ),
      );
    }).pipe(Effect.uninterruptible);
  }
  private writeControlFrame() {
    return Effect.gen({ self: this }, function* () {
      const file = this.activeFile;
      const frame = this.notification;
      if (this.stopped || !file || !frame || !this.controlPending() || this.uplinkBusy.get(file)) {
        return;
      }
      const quietMs = 5 - (this.now() - (this.uplinkObserved.get(file)?.at || 0));
      if (quietMs > 0) {
        yield* Effect.sleep(quietMs);
      }
      const current = yield* this.sharedFile(this.fs.readFileString(file));
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
      const replaced = yield* Effect.gen({ self: this }, function* () {
        yield* this.fs.writeFileString(temporary, replaceDownlink(current, frame));
        if (this.stopped || this.activeFile !== file || this.notification !== frame) {
          return false;
        }
        const latest = yield* this.sharedFile(this.fs.readFileString(file));
        // Preserve concurrent game packets and unrelated user addon settings.
        // A changed file is retried from a fresh snapshot by the watchdog.
        if (
          latest !== current ||
          this.stopped ||
          this.activeFile !== file ||
          this.notification !== frame
        ) {
          return false;
        }
        yield* this.sharedFile(this.fs.rename(temporary, file));
        return true;
      }).pipe(
        Effect.onExit((exit) =>
          exit._tag === 'Success' && exit.value
            ? Effect.void
            : Effect.ignore(this.fs.remove(temporary, { force: true })),
        ),
      );
      if (!replaced) return;
      this.lastControlWriteAt = this.now();
      this.performance.controlWrites++;
      this.performance.wireBytes += frame.length;
      if (this.downlink && this.notification === frame) {
        this.downlink.sentAt ??= this.lastControlWriteAt;
        this.downlink.writes++;
      }
    });
  }
  private writePayload(json: string) {
    const file = this.path.join(this.wow, 'Interface', 'AddOns', 'WispAI_Payload', 'Payload.lua');
    const temporary = file + '.tmp';
    return this.fs.makeDirectory(this.path.dirname(file), { recursive: true }).pipe(
      Effect.andThen(this.fs.writeFileString(temporary, luaJson(json))),
      Effect.andThen(
        this.fs
          .rename(temporary, file)
          .pipe(Effect.retry({ times: 5, schedule: Schedule.spaced(30) })),
      ),
      Effect.tapError(() => Effect.ignore(this.fs.remove(temporary, { force: true }))),
    );
  }
  private reportSlowDownlink(phase: SlowDownlink['phase'], transfer: DownlinkTransfer) {
    const file = this.activeFile;
    const observed = file ? this.uplinkObserved.get(file) : undefined;
    try {
      this.onSlowDownlink({
        phase,
        revision: transfer.snapshot.revision,
        ageMs: this.now() - transfer.startedAt,
        restarts: transfer.restarts,
        bulk: transfer.bulk,
        frames: transfer.frames.length,
        frame: transfer.index,
        uplinkQuietMs: observed ? this.now() - observed.at : undefined,
        uplinkBusy: Boolean(file && this.uplinkBusy.get(file)),
      });
    } catch (error) {
      this.onError(error);
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
    transfer.lastProgressAt = this.now();
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
        lastProgressAt: this.now(),
        writes: 0,
        startedAt: this.now(),
        restarts: 0,
        stallReported: false,
      };
      this.downlink = transfer;
      if (transfer.bulk) {
        // Bulk files are an acceleration, never a prerequisite for progress.
        transfer.bulk = yield* this.writePayload(record.json).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      }
      if (this.downlink !== transfer || this.stopped) {
        return;
      }
      this.frameTransfer(transfer);
      yield* this.writeControl();
    });
  }
  private queueDownlink() {
    if (this.stopped) return;
    const epoch = this.publicationEpoch;
    this.runBackground(
      this.writeLock
        .withPermit(
          Effect.suspend(() =>
            epoch === this.publicationEpoch ? this.startDownlink() : Effect.void,
          ).pipe(Effect.uninterruptible),
        )
        .pipe(Effect.catch((error) => Effect.sync(() => this.onError(error)))),
    );
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
    if (transfer.stallReported || this.now() - transfer.startedAt >= SLOW_DOWNLINK_MS) {
      this.reportSlowDownlink('delivered', transfer);
    }
    this.peerRevision = Math.max(this.peerRevision, revision);
    this.acknowledgedSnapshot = record;
    this.downlink = undefined;
    this.notification = undefined;
    this.queueDownlink();
  }
  private acknowledgeDownlink(
    ack: NonNullable<ReturnType<typeof parseDownlinkAck>>,
    compact = false,
  ) {
    return Effect.gen({ self: this }, function* () {
      const transfer = this.downlink;
      const frame = this.notification && decodeFrame(this.notification);
      if (!transfer || !frame || ack.a[0] !== frame.generation || ack.a[1] !== frame.sequence) {
        return;
      }
      this.performance.acknowledgments++;
      if (compact) {
        this.performance.compactAcknowledgments++;
      }
      const sample = transfer.sentAt === undefined ? undefined : this.now() - transfer.sentAt;
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
      transfer.lastProgressAt = this.now();
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
          yield* this.writeControl();
        }
      } else if (transfer.index + 1 < transfer.frames.length) {
        transfer.index++;
        transfer.sentAt = undefined;
        transfer.writes = 0;
        this.notification = transfer.frames[transfer.index];
        yield* this.writeControl();
      } else if (ack.a[2] === transfer.snapshot.revision) {
        this.finishDownlink(ack.a[2]);
      } else {
        // A decoder/base mismatch needs a full snapshot, not a repeated patch.
        this.acknowledgedSnapshot = undefined;
        this.downlink = undefined;
        this.notification = undefined;
        this.queueDownlink();
      }
    });
  }
  publish(snapshot: unknown) {
    return Effect.suspend(() => {
      const json = JSON.stringify(snapshot);
      const revision = (snapshot as { rev?: unknown } | null)?.rev;
      const epoch = this.publicationEpoch;
      return this.writeLock.withPermit(
        Effect.gen({ self: this }, function* () {
          if (this.stopped || epoch !== this.publicationEpoch || json === this.published) {
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
          yield* this.writePayload(json);
          if (this.stopped || epoch !== this.publicationEpoch) return;
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
            yield* this.writeControl();
          }
        }).pipe(
          Effect.tapCause(() =>
            Effect.sync(() => {
              if (this.published === json) this.published = '';
            }),
          ),
          Effect.uninterruptible,
        ),
      );
    });
  }
  waitForWrites() {
    return this.writeLock.withPermit(Effect.void);
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
    this.generation = this.nextGeneration();
    this.notificationSequence = 0;
  }
  private stop() {
    return Effect.gen({ self: this }, function* () {
      this.stopped = true;
      yield* FiberSet.clear(this.fibers);
      yield* Effect.forEach(this.reads.values(), (lock) => lock.withPermit(Effect.void), {
        discard: true,
        concurrency: 'unbounded',
      });
      yield* this.waitForWrites();
    });
  }
}
