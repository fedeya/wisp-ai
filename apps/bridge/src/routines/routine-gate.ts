import type { RoutineRun } from '@wisp/protocol/routines';

const USAGE_PAUSE_MS = 30 * 60_000;
const MAX_USAGE_PAUSE_MS = 4 * 60 * 60_000;
// Conditions outside the fingerprint (timers, cooldowns) still get a fresh
// check at least this often while the snapshot stays the same.
const QUIET_RECHECK_MS = 30 * 60_000;

// The parts of a routine tick that a read-only routine can react to. Map
// coordinates are left out: walking alone should not trigger another run.
export function routineFingerprint(context: unknown, questRevision: number | undefined) {
  const sections = (context as { sections?: Record<string, { status?: string; data?: any }> })
    ?.sections;
  const character = sections?.character?.status === 'available' && sections.character.data;
  const location = sections?.location?.status === 'available' && sections.location.data;
  if (!character || !location || questRevision === undefined) {
    return undefined;
  }
  return JSON.stringify([
    character.level,
    character.xp,
    character.xpMax,
    character.moneyCopper,
    location.zone,
    location.subzone,
    location.mapId,
    questRevision,
  ]);
}

// Keeps routines from spending model quota when they cannot help: a usage
// limit pauses every routine with growing backoff, and an interval run whose
// game state is unchanged since a run that had nothing to say is skipped.
export function createRoutineGate() {
  let pausedUntil = 0;
  let usagePause = 0;
  // Keyed by character, routine and definition version, so an edited routine
  // or another character's routine is always evaluated on its own.
  const quiet = new Map<string, { fingerprint: string; at: number }>();
  return {
    paused(now = Date.now()) {
      return now < pausedUntil;
    },
    unchanged(key: string, event: string, fingerprint: string | undefined, now = Date.now()) {
      const last = quiet.get(key);
      return (
        event === 'interval' &&
        !!fingerprint &&
        last?.fingerprint === fingerprint &&
        now - last.at < QUIET_RECHECK_MS
      );
    },
    finished(
      key: string,
      status: RoutineRun['status'],
      fingerprint: string | undefined,
      usageLimited: boolean,
      now = Date.now(),
    ) {
      if (usageLimited) {
        usagePause = Math.min(usagePause ? usagePause * 2 : USAGE_PAUSE_MS, MAX_USAGE_PAUSE_MS);
        pausedUntil = now + usagePause;
      } else if (status === 'done' || status === 'no_tip') {
        usagePause = 0;
        pausedUntil = 0;
      }
      if (status === 'no_tip' && fingerprint) {
        quiet.set(key, { fingerprint, at: now });
      } else {
        quiet.delete(key);
      }
    },
  };
}
