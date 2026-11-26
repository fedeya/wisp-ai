import { Cause, Clock, Effect, FiberSet, Random, Schedule, Semaphore, Stream } from 'effect';
import { decodeUplink, type Packet } from './wire/protocol.ts';
import {
  MailboxDecoder,
  UPLINK_KIND,
  COMPACT_ACK_KIND,
  LAST,
  decodeFrame,
  readUplink,
} from './wire/mailbox.ts';
import { makeWriter } from './writer.ts';
import * as AddonFiles from './addon-files.ts';
import { makeDelivery } from './delivery.ts';
import { logTransportError } from './logging.ts';

/**
 * A game window that sent anything this recently keeps the bridge: another window's
 * periodic heartbeat (every 60 seconds) cannot take it. Two windows otherwise steal
 * the session from each other on every heartbeat, interrupting turns each time.
 */
export const ACTIVE_SESSION_MS = 150_000;

/** How often the fallback tick walks every character folder once a session is active. */
export const FULL_SCAN_INTERVAL_MS = 5000;

interface Uplink {
  lock: Semaphore.Semaphore;
  decoder: MailboxDecoder;
  baselinePending: boolean;
  busy: boolean;
  observed?: { frame: Buffer; at: number };
}

export class DiskConnection {
  private readonly uplinks = new Map<string, Uplink>();
  private window?: { file: string; session: string };
  private activeAt = 0;
  /** Wall-clock time of the last message from the active window. */
  private activeSeenAt = 0;
  stopped = false;
  readonly watchers = new Set<string>();
  private readonly files: AddonFiles.AddonFiles;
  private readonly clock: Clock.Clock;
  private readonly fibers: FiberSet.FiberSet;
  private readonly writer: Effect.Success<ReturnType<typeof makeWriter>>;
  private readonly runBackground: (effect: Effect.Effect<void>) => unknown;
  private readonly receive: (packet: Packet) => void | Effect.Effect<void>;
  private readonly heldOff = new Set<string>();
  private readonly onSessionChanged: () => void;
  private readonly delivery: ReturnType<typeof makeDelivery>;
  private readonly packets = Semaphore.makeUnsafe(1);

  private constructor(options: {
    files: AddonFiles.AddonFiles;
    clock: Clock.Clock;
    random: Random.Random;
    fibers: FiberSet.FiberSet;
    writer: Effect.Success<ReturnType<typeof makeWriter>>;
    runBackground: (effect: Effect.Effect<void>) => unknown;
    receive: (packet: Packet) => void | Effect.Effect<void>;
    onSessionChanged: () => void;
  }) {
    this.files = options.files;
    this.clock = options.clock;
    this.fibers = options.fibers;
    this.writer = options.writer;
    this.runBackground = options.runBackground;
    this.receive = options.receive;
    this.onSessionChanged = options.onSessionChanged;
    this.delivery = makeDelivery({
      files: this.files,
      writer: options.writer,
      activeFile: () => this.window?.file,
      stopped: () => this.stopped,
      uplinkBusy: (file) => this.uplinks.get(file)?.busy,
      uplinkObservedAt: (file) => this.uplinks.get(file)?.observed?.at,
      now: () => this.now(),
      nextGeneration: () => options.random.nextIntUnsafe() >>> 0 || 1,
    });
  }

  static readonly make = Effect.fnUntraced(function* (
    wow: string,
    receive: (packet: Packet) => void | Effect.Effect<void>,
    onSessionChanged: () => void = () => {},
  ) {
    const files = yield* AddonFiles.make(wow);
    const clock = yield* Clock.Clock;
    const random = yield* Random.Random;
    const fibers = yield* FiberSet.make();
    const writer = yield* makeWriter();
    const runBackground = yield* FiberSet.runtime(fibers)();
    const connection = new DiskConnection({
      files,
      clock,
      random,
      fibers,
      writer,
      runBackground,
      receive,
      onSessionChanged,
    });
    yield* Effect.addFinalizer(() => connection.stop());
    return connection;
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
        const active = this.window?.file;
        const now = this.now();
        if (active && now - lastScanAt < FULL_SCAN_INTERVAL_MS) return this.read(active, false);
        lastScanAt = now;
        return this.scan(false);
      });
      const control = Effect.gen({ self: this }, function* () {
        const active = this.window?.file;
        if (!active || !this.delivery.controlPending()) return;
        yield* this.delivery.restartStalledTransfer();
        yield* this.read(active, false);
      });
      this.runBackground(
        poll.pipe(
          Effect.catch(logTransportError),
          Effect.schedule(Schedule.fixed(1000)),
          Effect.asVoid,
        ),
      );
      this.runBackground(
        control.pipe(
          Effect.catch(logTransportError),
          Effect.schedule(Schedule.fixed(150)),
          Effect.asVoid,
        ),
      );
    });
  }
  scan(baseline: boolean) {
    return this.files.scan((file, directory) =>
      Effect.gen({ self: this }, function* () {
        if (this.stopped) return;
        // An early watch event must not dispatch the persisted startup frame.
        yield* this.read(file, baseline).pipe(Effect.catch(logTransportError));
        this.watchDirectory(directory, file);
      }),
    );
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
    const watch = this.files.watch(dir).pipe(
      Stream.runForEach(() => this.read(file, false).pipe(Effect.catch(logTransportError))),
      Effect.catchCause((cause) =>
        !this.stopped && !Cause.hasInterruptsOnly(cause)
          ? logTransportError(Cause.squash(cause))
          : Effect.void,
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
      let uplink = this.uplinks.get(file);
      if (!uplink) {
        uplink = {
          lock: Semaphore.makeUnsafe(1),
          decoder: new MailboxDecoder(UPLINK_KIND),
          baselinePending: baseline,
          busy: false,
        };
        this.uplinks.set(file, uplink);
      }
      return uplink.lock.withPermit(this.readCurrent(file, uplink));
    });
  }
  private readCurrent(file: string, uplink: Uplink) {
    return Effect.gen({ self: this }, function* () {
      if (this.stopped) {
        return;
      }
      const text = yield* this.files
        .read(file)
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === 'NotFound' ? Effect.succeed(undefined) : Effect.fail(error),
          ),
        );
      if (this.stopped) return;
      const mailboxFrame = text === undefined ? null : readUplink(text);
      if (uplink.baselinePending) {
        // State files persist across host restarts and addon downgrades. Never
        // replay an on-disk operation merely because it fits in a single frame.
        if (mailboxFrame) uplink.decoder.baseline(mailboxFrame);
        uplink.baselinePending = false;
        return;
      }
      if (text === undefined) return;
      const compact = mailboxFrame && decodeFrame(mailboxFrame.subarray(0, 16));
      if (mailboxFrame && compact?.kind === COMPACT_ACK_KIND) {
        if (file === this.window?.file && this.delivery.reusable() && this.delivery.compact()) {
          uplink.busy = false;
          if (!uplink.observed?.frame.equals(mailboxFrame)) {
            uplink.observed = { frame: mailboxFrame, at: this.now() };
          }
          yield* this.delivery.acceptCompactAck(compact);
        }
      } else if (mailboxFrame) {
        const parsed = decodeFrame(mailboxFrame);
        if (parsed?.kind === UPLINK_KIND) {
          if (!uplink.observed?.frame.equals(mailboxFrame)) {
            uplink.observed = { frame: mailboxFrame, at: this.now() };
          }
          uplink.busy = !(parsed.flags & LAST);
          const message = uplink.decoder.add(mailboxFrame);
          if (message) {
            const incoming = decodeUplink(message);
            if (incoming?.kind === 'ack') {
              if (file === this.window?.file && this.delivery.reusable()) {
                yield* this.delivery.acceptAck(incoming.ack);
              }
            } else if (incoming?.kind === 'packet' && incoming.packet.transportVersion === 2) {
              yield* this.packets.withPermit(this.receivePacket(file, incoming.packet));
            }
          }
        }
      }
      if (file === this.window?.file) {
        yield* this.delivery.repairControl(file, text);
      }
    });
  }

  private receivePacket(file: string, packet: Packet) {
    return Effect.gen({ self: this }, function* () {
      if (this.stopped) return;
      if (packet.type === 'hello' && this.window?.session !== packet.session) {
        if (this.window && packet.at < this.activeAt) return;
        if (
          this.window &&
          packet.heartbeat &&
          !packet.takeover &&
          this.now() - this.activeSeenAt < ACTIVE_SESSION_MS
        ) {
          // Report each waiting window once, not on every heartbeat.
          if (!this.heldOff.has(packet.session) && this.heldOff.size < 32) {
            this.heldOff.add(packet.session);
            yield* Effect.logInfo(
              'Another game window is connected; its heartbeat did not take the bridge',
            ).pipe(Effect.annotateLogs({ event: 'transport.heartbeat_held_off' }));
          }
          return;
        }
        // Change the session seen by request() before waiting on disk I/O.
        this.delivery.reset(packet);
        this.window = { file, session: packet.session };
        this.onSessionChanged();
      }
      if (this.window?.file !== file || this.window.session !== packet.session) return;
      this.activeAt = Math.max(this.activeAt, packet.at);
      this.activeSeenAt = this.now();
      yield* this.delivery.observe(packet);
      // Application resends still reach the server, which deduplicates and re-acknowledges.
      const accept = this.receive(packet);
      if (accept) yield* accept;
    });
  }

  get session() {
    return this.window?.session;
  }
  get peerRevision() {
    return this.delivery.cursor().revision;
  }
  get nextSlot() {
    return this.delivery.cursor().slot;
  }
  get performance() {
    return this.delivery.measurements();
  }
  get readiness() {
    return this.delivery.readiness();
  }
  publishView<View extends { session: string; connected: boolean }>(view: View, force: boolean) {
    return Effect.suspend(() =>
      this.session === view.session ? this.delivery.publishView(view, force) : Effect.void,
    );
  }
  publish(snapshot: unknown) {
    return this.delivery.publishSnapshot(snapshot);
  }
  setCursor(slot: number, receivedRevision: number) {
    return this.delivery.setCursor(slot, receivedRevision);
  }
  resetSession() {
    return Effect.sync(() => this.delivery.reset());
  }
  waitForWrites() {
    return this.delivery.waitForWrites();
  }

  private stop() {
    return Effect.gen({ self: this }, function* () {
      this.stopped = true;
      yield* FiberSet.clear(this.fibers);
      yield* Effect.forEach(this.uplinks.values(), ({ lock }) => lock.withPermit(Effect.void), {
        discard: true,
        concurrency: 'unbounded',
      });
      yield* this.writer.close;
    });
  }
}
