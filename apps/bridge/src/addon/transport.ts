import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Schedule,
  Schema,
  Scope,
  Semaphore,
} from 'effect';
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

/** A file operation on the game's folders failed; `cause` is the Node error. */
export class TransportFileError extends Schema.TaggedError<TransportFileError>()(
  'TransportFileError',
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const fileOperation = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new TransportFileError({ operation, cause }) });

// WoW, antivirus scanners and sync tools hold these files open for a moment.
const SHARED_FILE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOENT']);
const sharedFileBusy = (error: TransportFileError) =>
  SHARED_FILE_CODES.has((error.cause as NodeJS.ErrnoException | undefined)?.code ?? '');
/** Eight more tries, waiting 4 ms longer before each. */
const SHARED_FILE_RETRY = Schedule.recurs(8).pipe(
  Schedule.addDelay(({ attempt }) => Effect.succeed(Duration.millis(4 * attempt))),
);

/** The error a Promise caller sees: the Node error behind a file failure, or the defect. */
function rejection(cause: Cause.Cause<TransportFileError>) {
  const error = Cause.squash(cause);
  return error instanceof TransportFileError ? error.cause : error;
}

/**
 * The addon's disk transport: it reads the game's uplink frames from each
 * character's AddOns.txt and writes snapshots back through the downlink lane
 * and the payload file.
 *
 * Its background work runs as fibers in the transport's scope: the fallback
 * scan, the downlink watchdog, reads started by folder watchers and control
 * writes. `stop()` closes the scope, which interrupts the loops and reads,
 * waits for a control write in progress and closes the watchers. Publications
 * run one at a time, and so do reads of one file.
 */
export class DiskTransport {
  private readonly scope = Scope.makeUnsafe();
  private readonly publications = Semaphore.makeUnsafe(1);
  private readonly fileLocks = new Map<string, Semaphore.Semaphore>();
  private onError: (error: unknown) => void;
  private mailboxDecoders = new Map<string, MailboxDecoder>();
  private activeFile?: string;
  private activeSession?: string;
  private activeAt = 0;
  /** Wall-clock time of the last message from the active window. */
  private activeSeenAt = 0;
  private onHeldOff: (session: string) => void;
  private onSlowDownlink: (report: SlowDownlink) => void;
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
  /** The control write in progress; later writers wait for it instead of starting another. */
  private controlWriting?: Deferred.Deferred<void, TransportFileError>;
  private lastControlWriteAt = 0;
  stopped = false;
  published = '';
  nextSlot = 1;
  peerRevision = 0;
  /** Settles when the latest publication has been written. */
  writing: Promise<void> = Promise.resolve();
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
    onSlowDownlink: (report: SlowDownlink) => void = () => {},
  ) {
    this.wow = wow;
    this.receive = receive;
    this.onError = onError;
    this.onHeldOff = onHeldOff;
    this.onSlowDownlink = onSlowDownlink;
    Effect.runSync(
      Scope.addFinalizer(
        this.scope,
        Effect.sync(() => {
          for (const watcher of this.watchers.values()) {
            watcher.close();
          }
          this.watchers.clear();
        }),
      ),
    );
  }

  /** Runs `effect` at the Promise edge, rejecting with the underlying error. */
  private run<A>(effect: Effect.Effect<A, TransportFileError>): Promise<A> {
    return Effect.runPromiseExit(effect).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      throw rejection(exit.cause);
    });
  }

  private report = (cause: Cause.Cause<TransportFileError>) =>
    Effect.sync(() => this.onError(rejection(cause)));

  /** Runs `effect` as a fiber of this transport, reporting its failure. */
  private background(effect: Effect.Effect<unknown, TransportFileError>) {
    if (this.stopped) return;
    Effect.runSync(Effect.forkIn(effect.pipe(Effect.catchCause(this.report)), this.scope));
  }

  /** Runs `tick` every `interval` until the transport stops; a failed tick is reported. */
  private every(interval: Duration.Input, tick: Effect.Effect<void, TransportFileError>) {
    this.background(
      Effect.forever(
        Effect.sleep(interval).pipe(Effect.andThen(tick), Effect.catchCause(this.report)),
      ),
    );
  }

  async start() {
    await this.scan(true);
    if (this.stopped) return;
    let lastScanAt = Date.now();
    // Folder watchers deliver most changes; this tick is the fallback.
    // Walking every character folder and rereading every state file each
    // second costs I/O that grows with the number of characters, so once a
    // game session is active only its file is reread every second and the
    // full walk (new characters, character switches) runs less often.
    this.every(
      '1 second',
      Effect.suspend(() => {
        const active = this.activeFile;
        if (!active || Date.now() - lastScanAt >= FULL_SCAN_INTERVAL_MS) {
          lastScanAt = Date.now();
          return this.scanFolders(false);
        }
        return this.readState(active, false);
      }),
    );
    this.every(
      '150 millis',
      Effect.sync(() => {
        if (!this.activeFile || !this.controlPending()) return;
        const transfer = this.downlink;
        if (transfer && Date.now() - transfer.lastProgressAt > 5000) {
          // A lost final ACK or an interrupted receiver must not pin the lane
          // forever. A fresh FIRST frame also restarts partial reassembly.
          this.performance.restarts++;
          transfer.restarts++;
          if (!transfer.stallReported && Date.now() - transfer.startedAt >= SLOW_DOWNLINK_MS) {
            transfer.stallReported = true;
            this.reportSlowDownlink('stalled', transfer);
          }
          this.frameTransfer(transfer);
        }
        this.background(this.readState(this.activeFile, false));
      }),
    );
  }

  /** Walks every character folder once; `baseline` records frames without replaying them. */
  scan(baseline: boolean) {
    return this.run(this.scanFolders(baseline));
  }

  /** Reads one state file, after any read of it already in progress. */
  read(file: string, baseline: boolean) {
    return this.run(this.readState(file, baseline));
  }

  private scanFolders = Effect.fn('DiskTransport.scan')(function* (
    this: DiskTransport,
    baseline: boolean,
  ) {
    const walk = (dir: string, depth: number): Effect.Effect<void, TransportFileError> =>
      Effect.gen({ self: this }, function* () {
        if (this.stopped || depth > 4) {
          return;
        }
        const entries = yield* Effect.promise(() =>
          readdir(dir, { withFileTypes: true }).catch(() => []),
        );
        for (const entry of entries) {
          if (this.stopped) return;
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            yield* walk(file, depth + 1);
          } else if (entry.name.toLowerCase() === 'addons.txt') {
            if (!this.mailboxDecoders.has(file)) {
              this.mailboxDecoders.set(file, new MailboxDecoder(UPLINK_KIND));
            }
            this.watchDirectory(dir, file);
            yield* this.readState(file, baseline);
          }
        }
      });
    yield* walk(path.join(this.wow, 'WTF', 'Account'), 0);
  });

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
          this.background(this.readState(file, false));
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

  private fileLock(file: string) {
    let lock = this.fileLocks.get(file);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      this.fileLocks.set(file, lock);
    }
    return lock;
  }

  private readState = Effect.fn('DiskTransport.read')(function* (
    this: DiskTransport,
    file: string,
    baseline: boolean,
  ) {
    if (this.stopped) return;
    yield* this.fileLock(file).withPermits(1)(this.readCurrent(file, baseline));
  });

  private readCurrent = Effect.fn('DiskTransport.readCurrent')(function* (
    this: DiskTransport,
    file: string,
    baseline: boolean,
  ) {
    if (this.stopped) {
      return;
    }
    const text = yield* this.sharedFile('read state file', () => readFile(file, 'utf8')).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (text === undefined || this.stopped) return;
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
          this.uplinkObserved.set(file, { frame: mailboxFrame, at: Date.now() });
        }
        this.uplinkBusy.set(file, !(parsed.flags & LAST));
        const message = mailboxDecoder.add(mailboxFrame);
        if (message) {
          let value: unknown;
          let packet: Packet | undefined;
          let ack: ReturnType<typeof parseDownlinkAck> | false = false;
          try {
            value = JSON.parse(inflateMessage(message).toString('utf8'));
            ack = message.flags === 0 && parseDownlinkAck(value);
            if (!ack) {
              packet = packetSchema.parse(value);
            }
          } catch {
            // Corrupt, oversized or schema-invalid messages wait for the game's
            // existing application-level resend; never dispatch partial data.
          }
          if (ack && file === this.activeFile && this.mailboxVersion) {
            // A failed write here is retried by the downlink watchdog.
            yield* Effect.ignore(this.acknowledgeDownlink(ack));
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
  });

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
    this.background(this.writeControl());
  }

  private controlPending() {
    return Boolean(
      this.notification && (this.downlink || this.peerRevision < this.publishedRevision),
    );
  }

  /** A file operation the game may briefly block, retried while it is busy. */
  private sharedFile<A>(operation: string, run: () => Promise<A>) {
    return fileOperation(operation, run).pipe(
      Effect.retry({ schedule: SHARED_FILE_RETRY, while: sharedFileBusy }),
    );
  }

  /**
   * Writes the pending control frame. A write already in progress is shared,
   * not repeated; the write itself runs to the end even when the transport
   * stops, so it never leaves a temporary copy behind.
   */
  private writeControl(): Effect.Effect<void, TransportFileError> {
    return Effect.suspend(() => {
      if (this.stopped) return Effect.void;
      if (this.controlWriting) return Deferred.await(this.controlWriting);
      const done = Deferred.makeUnsafe<void, TransportFileError>();
      this.controlWriting = done;
      Effect.runSync(
        Effect.forkIn(
          this.replaceControl().pipe(
            Effect.exit,
            Effect.flatMap((exit) => {
              if (this.controlWriting === done) this.controlWriting = undefined;
              return Deferred.done(done, exit);
            }),
            Effect.uninterruptible,
          ),
          this.scope,
        ),
      );
      return Deferred.await(done);
    });
  }

  private replaceControl = Effect.fn('DiskTransport.writeControl')(function* (this: DiskTransport) {
    const file = this.activeFile;
    const frame = this.notification;
    if (this.stopped || !file || !frame || !this.controlPending() || this.uplinkBusy.get(file)) {
      return;
    }
    const quietMs = 5 - (Date.now() - (this.uplinkObserved.get(file)?.at || 0));
    if (quietMs > 0) {
      yield* Effect.sleep(quietMs);
    }
    const current = yield* this.sharedFile('read state file', () => readFile(file, 'utf8'));
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
    const replaced = yield* Effect.acquireUseRelease(
      fileOperation('write control copy', () =>
        writeFile(temporary, replaceDownlink(current, frame), 'utf8'),
      ),
      () =>
        Effect.gen({ self: this }, function* () {
          if (this.stopped || this.activeFile !== file || this.notification !== frame) {
            return false;
          }
          const latest = yield* this.sharedFile('read state file', () => readFile(file, 'utf8'));
          // Preserve concurrent game packets and unrelated user addon settings.
          // A changed file is retried from a fresh snapshot by the watchdog.
          if (latest !== current) {
            return false;
          }
          yield* this.sharedFile('replace state file', () => rename(temporary, file));
          return true;
        }),
      // An abandoned write must not leave its copy beside the game's files.
      (_, exit) =>
        Exit.isSuccess(exit) && exit.value
          ? Effect.void
          : Effect.promise(() => rm(temporary, { force: true }).catch(() => {})),
    );
    if (!replaced) {
      return;
    }
    this.lastControlWriteAt = Date.now();
    this.performance.controlWrites++;
    this.performance.wireBytes += frame.length;
    if (this.downlink && this.notification === frame) {
      this.downlink.sentAt ??= this.lastControlWriteAt;
      this.downlink.writes++;
    }
  });

  private writePayload = Effect.fn('DiskTransport.writePayload')(function* (
    this: DiskTransport,
    json: string,
  ) {
    const file = path.join(this.wow, 'Interface', 'AddOns', 'WispAI_Payload', 'Payload.lua');
    yield* fileOperation('create payload folder', () =>
      mkdir(path.dirname(file), { recursive: true }),
    );
    const tmp = file + '.tmp';
    yield* fileOperation('write payload copy', () => writeFile(tmp, luaJson(json), 'utf8'));
    yield* fileOperation('replace payload', () => rename(tmp, file)).pipe(
      Effect.retry({ times: 5, schedule: Schedule.spaced('30 millis') }),
    );
  });

  private reportSlowDownlink(phase: SlowDownlink['phase'], transfer: DownlinkTransfer) {
    const file = this.activeFile;
    const observed = file ? this.uplinkObserved.get(file) : undefined;
    try {
      this.onSlowDownlink({
        phase,
        revision: transfer.snapshot.revision,
        ageMs: Date.now() - transfer.startedAt,
        restarts: transfer.restarts,
        bulk: transfer.bulk,
        frames: transfer.frames.length,
        frame: transfer.index,
        uplinkQuietMs: observed ? Date.now() - observed.at : undefined,
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

  private startDownlink = Effect.fn('DiskTransport.startDownlink')(function* (this: DiskTransport) {
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
      startedAt: Date.now(),
      restarts: 0,
      stallReported: false,
    };
    this.downlink = transfer;
    if (transfer.bulk) {
      // Bulk files are an acceleration, never a prerequisite for progress.
      yield* this.writePayload(record.json).pipe(
        Effect.catch(() => Effect.sync(() => void (transfer.bulk = false))),
      );
    }
    if (this.downlink !== transfer || this.stopped) {
      return;
    }
    this.frameTransfer(transfer);
    yield* this.writeControl();
  });

  /** Runs `work` after every earlier publication, recording it as the latest one. */
  private enqueue(work: Effect.Effect<void, TransportFileError>) {
    this.writing = this.run(this.publications.withPermits(1)(work));
    return this.writing;
  }

  private queueDownlink() {
    const epoch = this.publicationEpoch;
    void this.enqueue(
      Effect.suspend(() => (epoch === this.publicationEpoch ? this.startDownlink() : Effect.void)),
    ).catch(this.onError);
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
    if (transfer.stallReported || Date.now() - transfer.startedAt >= SLOW_DOWNLINK_MS) {
      this.reportSlowDownlink('delivered', transfer);
    }
    this.peerRevision = Math.max(this.peerRevision, revision);
    this.acknowledgedSnapshot = record;
    this.downlink = undefined;
    this.notification = undefined;
    this.queueDownlink();
  }

  private acknowledgeDownlink = Effect.fn('DiskTransport.acknowledgeDownlink')(function* (
    this: DiskTransport,
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

  publish(snapshot: unknown) {
    const json = JSON.stringify(snapshot);
    const revision = (snapshot as { rev?: unknown } | null)?.rev;
    if (json === this.published) {
      return this.writing;
    }
    this.published = json;
    const epoch = this.publicationEpoch;
    return this.enqueue(
      Effect.gen({ self: this }, function* () {
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
          yield* this.startDownlink();
          return;
        }
        yield* this.writePayload(json);
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
        Effect.tapError(() =>
          Effect.sync(() => {
            if (this.published === json) {
              this.published = '';
            }
          }),
        ),
      ),
    );
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

  /** Stops the loops and watchers, then waits for the control write and publications in flight. */
  async stop() {
    this.stopped = true;
    await Effect.runPromise(Scope.close(this.scope, Exit.void));
    await Effect.runPromise(this.publications.withPermits(1)(Effect.void));
  }
}
