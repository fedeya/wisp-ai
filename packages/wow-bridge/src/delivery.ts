// @effect-migrated
import { Effect, Predicate, Schema } from 'effect';
import type { AddonFiles } from './addon-files.ts';
import { logTransportError } from './logging.ts';
import { prepareDownlink } from './wire/downlink.ts';
import {
  COMPACT_DOWNLINK_KIND,
  DOWNLINK_KIND,
  encodeFrame,
  encodeMessage,
  FIRST,
  LAST,
  readDownlink,
} from './wire/mailbox.ts';
import type { DownlinkAck, Packet } from './wire/protocol.ts';
import type { makeWriter } from './writer.ts';

/** Assign a revision only when the actual addon view changes. */
export class SnapshotGate {
  private previous = '';
  revision: number;

  constructor(revision = Date.now()) {
    this.revision = revision;
  }

  invalidate() {
    this.previous = '';
  }

  next<T extends object>(view: T): (T & { rev: number }) | null {
    const signature = JSON.stringify(view);
    if (signature === this.previous) return null;
    this.previous = signature;
    return { ...view, rev: ++this.revision };
  }
}

interface Snapshot {
  revision: number;
  json: string;
  value: unknown;
}

const parseJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

interface Frame {
  generation: number;
  sequence: number;
  bytes: Buffer;
}

interface Transfer {
  snapshot: Snapshot;
  body: Buffer;
  startedAt: number;
  progressedAt: number;
  restarts: number;
  stallReported: boolean;
}

type Route = { kind: 'fragment' } | { kind: 'bulk'; slot: number };
type InFlight = Transfer & { sentAt?: number; writes: number } & (
    | { kind: 'fragment'; frames: Frame[]; index: number }
    | { kind: 'bulk'; slot: number; frame: Frame }
  );

type Delivery = { kind: 'idle' } | { kind: 'legacy'; revision: number; frame: Frame } | InFlight;

function inFlight(delivery: Delivery): delivery is InFlight {
  return delivery.kind === 'bulk' || delivery.kind === 'fragment';
}

function isFinal(transfer: InFlight) {
  return transfer.kind === 'bulk' || transfer.index + 1 === transfer.frames.length;
}

function afterAck(transfer: InFlight, ack: DownlinkAck) {
  const revision = ack.a[2];
  const finalFragment = transfer.kind === 'fragment' && isFinal(transfer);
  if (ack.n || (finalFragment && revision !== transfer.snapshot.revision)) return 'sendFull';
  if (transfer.kind === 'fragment') return finalFragment ? 'confirm' : 'advance';
  if (revision >= transfer.snapshot.revision) return 'confirm';
  return ack.b ? 'wait' : 'useFragments';
}

export const SLOW_DOWNLINK_MS = 10_000;

export interface DownlinkCosts {
  fragmentMs: number;
  bulkMs: number;
  slotsRemaining: number;
}

/** Spend a one-use helper only when its expected latency saving pays for that slot. */
export function preferBulkDelivery(bytes: number, costs: DownlinkCosts) {
  if (costs.slotsRemaining <= 0 || bytes <= 32) return false;
  const fragments = Math.ceil(bytes / 32);
  const remaining = Math.min(1024, Math.max(0, costs.slotsRemaining));
  const slotCostMs = 200 + 800 * (1 - remaining / 1024) ** 2;
  return fragments * costs.fragmentMs - costs.bulkMs >= slotCostMs;
}

interface DeliveryOptions {
  files: AddonFiles;
  writer: Effect.Success<ReturnType<typeof makeWriter>>;
  activeFile: () => string | undefined;
  stopped: () => boolean;
  uplinkBusy: (file: string) => boolean | undefined;
  uplinkObservedAt: (file: string) => number | undefined;
  now: () => number;
  nextGeneration: () => number;
}

export function makeDelivery(options: DeliveryOptions) {
  const { files, writer, now } = options;
  const revisions = new SnapshotGate(now());
  let latest: Snapshot | undefined;
  let confirmed: Snapshot | undefined;
  let sending: Delivery = { kind: 'idle' };
  let readyRevision = 0;
  let publishedJson: string | undefined;
  let lastControlWriteAt = 0;

  let generation = options.nextGeneration();
  let sequence = 0;
  let epoch = 0;
  let peer = { reusable: false, compact: false, bulk: true, slot: 1, revision: 0 };
  const latency: { fragment?: number; bulk?: number } = {};
  const counters = {
    acknowledgments: 0,
    compactAcknowledgments: 0,
    mailboxStarts: 0,
    bulkStarts: 0,
  };

  const current = (version: number) => version === epoch && !options.stopped();

  // Serialize delivery work. A window change can invalidate it while I/O is in flight.
  const submit = (work: (version: number) => Parameters<typeof writer.submit>[0]) =>
    Effect.suspend(() => {
      const version = epoch;
      return writer.submit(Effect.suspend(() => (current(version) ? work(version) : Effect.void)));
    });

  function pendingFrame() {
    if (sending.kind === 'idle') return undefined;
    if (sending.kind === 'legacy' && peer.revision >= sending.revision) return undefined;
    return sending.kind === 'fragment' ? sending.frames[sending.index] : sending.frame;
  }

  function notification(
    revision: number,
    kind: typeof DOWNLINK_KIND | typeof COMPACT_DOWNLINK_KIND,
  ) {
    const frame = { kind, flags: FIRST | LAST, generation, sequence };
    sequence = (sequence + 1) & 65535;
    return {
      generation: frame.generation,
      sequence: frame.sequence,
      bytes: encodeFrame({ ...frame, payload: Buffer.from(JSON.stringify({ r: revision })) }),
    };
  }

  function begin(transfer: Transfer, route: Route) {
    const kind = peer.compact ? COMPACT_DOWNLINK_KIND : DOWNLINK_KIND;
    const progress = {
      snapshot: transfer.snapshot,
      body: transfer.body,
      startedAt: transfer.startedAt,
      restarts: transfer.restarts,
      stallReported: transfer.stallReported,
      progressedAt: now(),
      writes: 0,
    };
    if (route.kind === 'bulk') {
      counters.bulkStarts++;
      sending = { ...progress, ...route, frame: notification(transfer.snapshot.revision, kind) };
      return;
    }
    const frames = encodeMessage(transfer.body, kind, generation, sequence, true).map(
      (bytes, index) => ({
        bytes,
        generation,
        sequence: (sequence + index) & 65535,
      }),
    );
    sequence = (sequence + frames.length) & 65535;
    counters.mailboxStarts++;
    sending = { ...progress, kind: 'fragment', frames, index: 0 };
  }

  const writeFrame = Effect.fnUntraced(function* (version: number) {
    const file = options.activeFile();
    const frame = pendingFrame();
    if (!file || !frame || options.uplinkBusy(file)) return;
    const quietMs = 5 - (now() - (options.uplinkObservedAt(file) ?? 0));
    if (quietMs > 0) yield* Effect.sleep(quietMs);
    const replaced = yield* files.writeControl(
      file,
      frame.bytes,
      () => current(version) && options.activeFile() === file && pendingFrame() === frame,
    );
    if (!replaced || !current(version)) return;
    lastControlWriteAt = now();
    if (inFlight(sending)) {
      sending.sentAt ??= lastControlWriteAt;
      sending.writes++;
    }
  });

  const startLatest = Effect.fnUntraced(function* (version: number) {
    const snapshot = latest;
    if (
      !options.activeFile() ||
      inFlight(sending) ||
      !snapshot ||
      snapshot.revision <= peer.revision
    ) {
      return;
    }
    const prepared = yield* Effect.try(() =>
      prepareDownlink(snapshot.value, confirmed?.value),
    ).pipe(Effect.catch((error) => logTransportError(error.cause).pipe(Effect.as(undefined))));
    if (!current(version)) return;
    if (!prepared) {
      // Repeating an invalid or oversized snapshot cannot make it encodable.
      latest = undefined;
      return;
    }
    const { body } = prepared;
    const startedAt = now();
    let route: Route = { kind: 'fragment' };
    if (
      peer.bulk &&
      preferBulkDelivery(body.length, {
        fragmentMs: latency.fragment ?? (peer.compact ? 50 : 100),
        bulkMs: latency.bulk ?? 150,
        slotsRemaining: 1025 - peer.slot,
      })
    ) {
      // A bulk file accelerates delivery; it is never required by a reusable peer.
      const written = yield* files
        .writePayload(snapshot.json, () => version === epoch)
        .pipe(Effect.orElseSucceed(() => false));
      if (!current(version)) return;
      if (written) route = { kind: 'bulk', slot: peer.slot };
    }
    begin(
      { snapshot, body, startedAt, progressedAt: startedAt, restarts: 0, stallReported: false },
      route,
    );
    yield* writeFrame(version);
  });

  function report(phase: 'stalled' | 'delivered', transfer: InFlight) {
    const file = options.activeFile();
    const observed = file ? options.uplinkObservedAt(file) : undefined;
    return Effect.logInfo(
      phase === 'stalled'
        ? 'A reply is taking long to reach the game'
        : 'A slow reply reached the game',
    ).pipe(
      Effect.annotateLogs({
        event: `transport.downlink_${phase}`,
        phase,
        revision: transfer.snapshot.revision,
        ageMs: now() - transfer.startedAt,
        restarts: transfer.restarts,
        bulk: transfer.kind === 'bulk',
        frames: transfer.kind === 'fragment' ? transfer.frames.length : 1,
        frame: transfer.kind === 'fragment' ? transfer.index : 0,
        uplinkQuietMs: observed === undefined ? undefined : now() - observed,
        uplinkBusy: Boolean(file && options.uplinkBusy(file)),
      }),
    );
  }

  const confirm = Effect.fnUntraced(function* (transfer: InFlight, revision: number) {
    const applied = revision === transfer.snapshot.revision ? transfer.snapshot : latest;
    if (applied?.revision !== revision || revision < transfer.snapshot.revision) return false;
    if (transfer.kind === 'bulk') {
      peer.slot = Math.max(peer.slot, Math.min(1024, transfer.slot + 1));
    }
    peer.revision = Math.max(peer.revision, revision);
    confirmed = applied;
    sending = { kind: 'idle' };
    if (transfer.stallReported || now() - transfer.startedAt >= SLOW_DOWNLINK_MS) {
      yield* report('delivered', transfer);
    }
    return true;
  });

  const acknowledge = Effect.fnUntraced(function* (
    version: number,
    ack: DownlinkAck,
    compact = false,
  ) {
    const transfer = sending;
    const frame = pendingFrame();
    if (
      !inFlight(transfer) ||
      !frame ||
      ack.a[0] !== frame.generation ||
      ack.a[1] !== frame.sequence
    ) {
      return;
    }
    counters.acknowledgments++;
    if (compact) counters.compactAcknowledgments++;
    const receivedAt = now();
    if (!ack.n && transfer.writes === 1 && transfer.sentAt !== undefined) {
      const sample = receivedAt - transfer.sentAt;
      if (sample >= 1 && sample <= 2000) {
        const previous = latency[transfer.kind];
        latency[transfer.kind] = previous === undefined ? sample : previous * 0.8 + sample * 0.2;
      }
    }
    peer.bulk &&= ack.b;
    transfer.progressedAt = receivedAt;

    switch (afterAck(transfer, ack)) {
      case 'sendFull':
        confirmed = undefined;
        sending = { kind: 'idle' };
        yield* startLatest(version);
        break;
      case 'confirm':
        if ((yield* confirm(transfer, ack.a[2])) && current(version)) yield* startLatest(version);
        break;
      case 'useFragments':
        begin(transfer, { kind: 'fragment' });
        yield* writeFrame(version);
        break;
      case 'advance':
        if (transfer.kind !== 'fragment') break;
        sending = { ...transfer, index: transfer.index + 1, sentAt: undefined, writes: 0 };
        yield* writeFrame(version);
        break;
      case 'wait':
        break;
    }
  });

  const publish = Effect.fnUntraced(function* (version: number, value: unknown) {
    const json = JSON.stringify(value);
    if (json === publishedJson) return;
    const revision = Predicate.hasProperty(value, 'rev') ? value.rev : undefined;
    const hasRevision =
      typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0;
    if (peer.reusable && hasRevision) {
      // A copy of the value as the addon will read it; json came from
      // JSON.stringify, so it always parses.
      const copy = yield* Effect.orDie(parseJson(json));
      latest = { revision, json, value: copy };
      yield* startLatest(version);
    } else {
      const written = yield* files.writePayload(json, () => version === epoch);
      if (!written || !current(version)) return;
      if (hasRevision) {
        sending = {
          kind: 'legacy',
          revision,
          frame: notification(revision, DOWNLINK_KIND),
        };
        yield* writeFrame(version);
      }
    }
    if (current(version)) publishedJson = json;
  });

  function needsControlRepair(file: string, text: string) {
    const frame = pendingFrame();
    return (
      file === options.activeFile() &&
      frame &&
      now() - lastControlWriteAt >= 150 &&
      !readDownlink(text)?.equals(frame.bytes)
    );
  }

  return {
    reusable: () => peer.reusable,
    compact: () => peer.compact,
    cursor: () => ({ slot: peer.slot, revision: peer.revision }),
    readiness: () => ({
      readyPublished: readyRevision !== 0,
      ready: readyRevision !== 0 && peer.revision >= readyRevision,
    }),
    measurements: () => ({ ...counters, fragmentRttMs: latency.fragment, bulkRttMs: latency.bulk }),
    controlPending: () => pendingFrame() !== undefined,
    observe: (packet: Packet) =>
      Effect.suspend(() => {
        if (
          packet.mailboxVersion !== 1 ||
          (peer.reusable &&
            (!packet.compactAck || peer.compact) &&
            (packet.bulkAvailable !== false || !peer.bulk))
        ) {
          return Effect.void;
        }
        return submit(() =>
          Effect.sync(() => {
            peer.reusable = true;
            peer.compact ||= packet.compactAck === true;
            peer.bulk &&= packet.bulkAvailable !== false;
          }),
        );
      }),
    acceptAck: (ack: DownlinkAck) => submit((version) => acknowledge(version, ack)),
    acceptCompactAck: (frame: { generation: number; sequence: number; flags: number }) =>
      submit((version) =>
        Effect.suspend(() => {
          if (!inFlight(sending)) return Effect.void;
          const revision = isFinal(sending) ? sending.snapshot.revision : peer.revision;
          return acknowledge(
            version,
            {
              a: [frame.generation, frame.sequence, revision],
              b: Boolean(frame.flags & 2),
              n: Boolean(frame.flags & 1),
            },
            true,
          );
        }),
      ),
    restartStalledTransfer: () =>
      submit((version) =>
        Effect.gen(function* () {
          if (!inFlight(sending) || now() - sending.progressedAt <= 5000) return;
          sending.restarts++;
          if (!sending.stallReported && now() - sending.startedAt >= SLOW_DOWNLINK_MS) {
            sending.stallReported = true;
            yield* report('stalled', sending);
            if (!current(version) || !inFlight(sending)) return;
          }
          begin(
            sending,
            sending.kind === 'bulk' ? { kind: 'bulk', slot: sending.slot } : { kind: 'fragment' },
          );
        }),
      ),
    repairControl: (file: string, text: string) =>
      Effect.suspend(() =>
        needsControlRepair(file, text)
          ? submit((version) =>
              needsControlRepair(file, text) ? writeFrame(version) : Effect.void,
            )
          : Effect.void,
      ).pipe(Effect.catch(logTransportError)),
    publishSnapshot: (snapshot: unknown) => submit((version) => publish(version, snapshot)),
    publishView: (view: { connected: boolean }, force: boolean) =>
      submit((version) =>
        Effect.gen(function* () {
          if (force) revisions.invalidate();
          const snapshot = revisions.next(view);
          if (!snapshot) return;
          if (view.connected && !readyRevision) readyRevision = snapshot.rev;
          yield* publish(version, snapshot).pipe(
            Effect.tapCause(() =>
              Effect.sync(() => {
                if (current(version)) revisions.invalidate();
              }),
            ),
          );
        }),
      ),
    waitForWrites: () => writer.submit(Effect.void),
    setCursor: (slot: number, revision: number) =>
      submit((version) =>
        Effect.gen(function* () {
          peer.slot = Math.max(peer.slot, slot);
          if (
            !peer.reusable ||
            revision === peer.revision ||
            (inFlight(sending) && revision === sending.snapshot.revision) ||
            revision === latest?.revision ||
            revision === confirmed?.revision
          ) {
            peer.revision = Math.max(peer.revision, revision);
          }
          if (
            peer.reusable &&
            inFlight(sending) &&
            revision === sending.snapshot.revision &&
            (yield* confirm(sending, revision)) &&
            current(version)
          ) {
            yield* startLatest(version).pipe(Effect.catch(logTransportError));
          }
        }),
      ),
    reset: (hello?: Packet) => {
      // Invalidate the writer's old work before exposing the new window.
      ++epoch;
      readyRevision = 0;
      peer = hello
        ? {
            reusable: hello.mailboxVersion === 1,
            compact: hello.mailboxVersion === 1 && hello.compactAck === true,
            bulk: hello.bulkAvailable !== false,
            revision: 0,
            slot: 1,
          }
        : { ...peer, revision: 0, slot: 1 };
      latest = undefined;
      confirmed = undefined;
      sending = { kind: 'idle' };
      publishedJson = undefined;
      revisions.invalidate();
      generation = options.nextGeneration();
      sequence = 0;
    },
  };
}
