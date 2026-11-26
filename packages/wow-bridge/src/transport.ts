import {
  Cause,
  Clock,
  Effect,
  FiberSet,
  FileSystem,
  Path,
  Random,
  Schema,
  Schedule,
  Semaphore,
  Stream,
} from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { packetSchema, type Packet } from './protocol.ts';
import {
  MailboxDecoder,
  UPLINK_KIND,
  COMPACT_ACK_KIND,
  LAST,
  decodeFrame,
  inflateMessage,
  readUplink,
} from './mailbox.ts';
import { parseDownlinkAck } from './downlink.ts';
import { makeWriter } from './writer.ts';
import { addonFiles } from './addon-files.ts';
import { OutboundMailbox, type SlowDownlink } from './outbound-mailbox.ts';

const decodePacket = Schema.decodeUnknownSync(packetSchema);

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
  private mailboxDecoders = new Map<string, MailboxDecoder>();
  private activeFile?: string;
  private activeSession?: string;
  private activeAt = 0;
  /** Wall-clock time of the last message from the active window. */
  private activeSeenAt = 0;
  private uplinkBusy = new Map<string, boolean>();
  private uplinkObserved = new Map<string, { frame: Buffer; at: number }>();
  stopped = false;
  readonly watchers = new Set<string>();
  private readonly fs: FileSystem.FileSystem;
  private readonly files: ReturnType<typeof addonFiles>;
  private readonly path: Path.Path;
  private readonly clock: Clock.Clock;
  private readonly fibers: FiberSet.FiberSet;
  private readonly writer: Effect.Success<ReturnType<typeof makeWriter>>;
  private readonly runBackground: (effect: Effect.Effect<void>) => unknown;
  readonly wow: string;
  private readonly receive: (packet: Packet) => void | Effect.Effect<void>;
  private readonly onError: (error: unknown) => void;
  private readonly onHeldOff: (session: string) => void;
  private readonly outbound: OutboundMailbox;

  private constructor(options: {
    fs: FileSystem.FileSystem;
    path: Path.Path;
    clock: Clock.Clock;
    random: Random.Random;
    fibers: FiberSet.FiberSet;
    writer: Effect.Success<ReturnType<typeof makeWriter>>;
    runBackground: (effect: Effect.Effect<void>) => unknown;
    wow: string;
    receive: (packet: Packet) => void | Effect.Effect<void>;
    onError: (error: unknown) => void;
    onHeldOff: (session: string) => void;
    onSlowDownlink: (report: SlowDownlink) => void;
  }) {
    this.fs = options.fs;
    this.files = addonFiles(options.fs, options.path, options.wow);
    this.path = options.path;
    this.clock = options.clock;
    this.fibers = options.fibers;
    this.writer = options.writer;
    this.runBackground = options.runBackground;
    this.wow = options.wow;
    this.receive = options.receive;
    this.onError = options.onError;
    this.onHeldOff = options.onHeldOff;
    this.outbound = new OutboundMailbox({
      files: this.files,
      writer: options.writer,
      activeFile: () => this.activeFile,
      stopped: () => this.stopped,
      uplinkBusy: (file) => this.uplinkBusy.get(file),
      uplinkObservedAt: (file) => this.uplinkObserved.get(file)?.at,
      now: () => this.now(),
      nextGeneration: () => options.random.nextIntUnsafe() >>> 0 || 1,
      onError: options.onError,
      onSlowDownlink: options.onSlowDownlink,
    });
  }

  static readonly make = Effect.fnUntraced(function* (
    wow: string,
    receive: (packet: Packet) => void | Effect.Effect<void>,
    onError: (error: unknown) => void = console.error,
    onHeldOff: (session: string) => void = () => {},
    onSlowDownlink: (report: SlowDownlink) => void = () => {},
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const clock = yield* Clock.Clock;
    const random = yield* Random.Random;
    const fibers = yield* FiberSet.make();
    const writer = yield* makeWriter();
    const runBackground = yield* FiberSet.runtime(fibers)();
    const transport = new DiskTransport({
      fs,
      path,
      clock,
      random,
      fibers,
      writer,
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
      const control = Effect.gen({ self: this }, function* () {
        const active = this.activeFile;
        if (!active || !this.outbound.controlPending()) return;
        yield* this.outbound.restartStalledTransfer();
        yield* this.read(active, false);
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
      const text = yield* this.files.read(file).pipe(Effect.orElseSucceed(() => undefined));
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
        if (file === this.activeFile && this.outbound.reusable && this.outbound.compact) {
          this.uplinkBusy.set(file, false);
          if (!this.uplinkObserved.get(file)?.frame.equals(mailboxFrame!)) {
            this.uplinkObserved.set(file, { frame: mailboxFrame!, at: this.now() });
          }
          yield* this.outbound.acceptCompactAck(compact);
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
                if (file === this.activeFile && this.outbound.reusable) {
                  yield* this.outbound
                    .acceptAck(ack)
                    .pipe(Effect.catch((error) => Effect.sync(() => this.onError(error))));
                }
              } else {
                packet = decodePacket(value);
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
                  yield* this.outbound.resetSession(packet);
                }
              }
              if (packet && file === this.activeFile && packet.session === this.activeSession) {
                this.activeAt = Math.max(this.activeAt, packet.at);
                this.activeSeenAt = this.now();
                yield* this.outbound.observe(packet);
                if (file !== this.activeFile || packet.session !== this.activeSession) return;
                // Duplicates (application resends) are expected here: the packet
                // receiver dedupes by session and sequence and re-acknowledges them.
                const accept = this.receive(packet);
                if (accept) yield* accept;
              }
            }
          }
        }
      }
      if (file === this.activeFile) {
        yield* this.outbound.repairControl(text);
      }
    });
  }
  get peerRevision() {
    return this.outbound.peerRevision;
  }
  get nextSlot() {
    return this.outbound.nextSlot;
  }
  get performance() {
    return this.outbound.performance;
  }
  publish(snapshot: unknown) {
    return this.outbound.publish(snapshot);
  }
  setCursor(slot: number, receivedRevision: number) {
    return this.outbound.setCursor(slot, receivedRevision);
  }
  resetSession() {
    return this.outbound.resetSession();
  }
  waitForWrites() {
    return this.outbound.waitForWrites();
  }

  private stop() {
    return Effect.gen({ self: this }, function* () {
      this.stopped = true;
      yield* FiberSet.clear(this.fibers);
      yield* Effect.forEach(this.reads.values(), (lock) => lock.withPermit(Effect.void), {
        discard: true,
        concurrency: 'unbounded',
      });
      yield* this.writer.close;
    });
  }
}
