import type { ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import type { Client } from 'eve/client';
import type { Logger } from 'pino';
import { startEveProcess, stopEveProcess } from './agent-process.ts';
import { prepareEngine } from '../app-paths.ts';
import { errorMessage } from '../errors.ts';

/** How often a running Eve is probed for readiness. */
export const EVE_HEALTH_INTERVAL_MS = 3000;
/**
 * Waits before starting Eve again after it exits on its own. The step grows
 * with each crash until Eve becomes ready again; the last step repeats.
 */
export const EVE_RESTART_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000];

export interface EveLifecycleOptions {
  /** Authored agent sources and the folder Eve runs from (see `prepareEngine`). */
  agentRoot: string;
  engineRoot: string;
  /** Loopback port Eve listens on; `client` must point at the same port. */
  port: number;
  logPath: string;
  /** Environment for each spawn; read at spawn time so a model change applies. */
  environment: () => NodeJS.ProcessEnv;
  client: Pick<Client, 'health' | 'info'>;
  startAgent?: typeof startEveProcess;
  /** Backoff after unexpected exits; defaults to `EVE_RESTART_DELAYS_MS`. */
  restartDelaysMs?: readonly number[];
  changed: () => void;
  isStopping: () => boolean;
  logger: Pick<Logger, 'info' | 'error'>;
}

export interface EveLifecycle {
  /** Whether the running Eve passed its last health check. */
  isReady(): boolean;
  /** Context window Eve reported when it became ready, if it reported one. */
  contextWindowTokens(): number | undefined;
  /** Open Eve's append-only log file; Eve cannot start before this. */
  openLog(): void;
  closeLog(): void;
  /**
   * Prepare the engine folder, then start Eve unless the bridge is stopping.
   * Never rejects: a failure is logged and Eve stays down.
   */
  prepare(): Promise<void>;
  /** Stop Eve, then start it again with a fresh environment. */
  restart(): Promise<void>;
  /** Stop Eve and wait for its process tree to exit. */
  stop(): Promise<void>;
  /** Begin polling Eve's health; returns the function that stops polling. */
  startHealthChecks(): () => void;
}

/** Owns the Eve child process: engine preparation, spawn, stop and readiness. */
export function createEveLifecycle(options: EveLifecycleOptions): EveLifecycle {
  const { client, changed, logger } = options;
  let logFile: number | undefined;
  let eve: ChildProcess | undefined;
  let enginePrepared = false;
  let ready = false;
  let contextWindowTokens: number | undefined;
  const restartDelaysMs = options.restartDelaysMs ?? EVE_RESTART_DELAYS_MS;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  /** Unexpected exits since Eve last became ready; picks the next backoff step. */
  let crashes = 0;

  /**
   * Start Eve again after it ended without being asked to. Each crash before
   * Eve becomes ready again waits longer, so a broken engine is retried slowly
   * instead of in a tight loop.
   */
  function scheduleRestart() {
    if (restartTimer || options.isStopping()) return;
    const delayMs = restartDelaysMs[Math.min(crashes, restartDelaysMs.length - 1)]!;
    crashes++;
    logger.info({ event: 'eve.restart_scheduled', attempt: crashes, delayMs }, 'Restarting Eve');
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (eve || options.isStopping()) return;
      start();
      changed();
    }, delayMs);
    restartTimer.unref?.();
  }

  function cancelRestart() {
    clearTimeout(restartTimer);
    restartTimer = undefined;
  }

  function spawn() {
    if (logFile === undefined) throw Error('Eve log is not open.');
    let child: ChildProcess | undefined;
    // Only the current child may report a crash: one stopped by stop() or
    // replaced by restart() is no longer `eve` when its exit arrives.
    const ended = () => {
      if (!child || eve !== child) return false;
      eve = undefined;
      ready = false;
      changed();
      scheduleRestart();
      return true;
    };
    child = (options.startAgent || startEveProcess)({
      root: options.engineRoot,
      port: options.port,
      logFile,
      environment: options.environment(),
      onError: (error) => {
        logger.error(
          { event: 'eve.spawn_failed', error: errorMessage(error) },
          'Could not start Eve',
        );
        // A process that never started emits 'error' without 'exit'.
        if (child && child.pid === undefined) ended();
      },
      onExit: (code) => {
        logger.info({ event: 'eve.exited', code, unexpected: child === eve }, 'Eve exited');
        ended();
      },
    });
    return child;
  }

  function start() {
    if (!enginePrepared) return;
    try {
      eve = spawn();
    } catch (error) {
      logger.error(
        { event: 'eve.spawn_failed', error: errorMessage(error) },
        'Could not start Eve',
      );
      scheduleRestart();
    }
  }

  async function stop() {
    cancelRestart();
    const current = eve;
    eve = undefined;
    ready = false;
    if (current) {
      await stopEveProcess(current);
    }
  }

  function checkHealth() {
    if (!eve) return;
    const current = eve;
    void client
      .health()
      .then(async () => {
        if (eve === current && !ready) {
          let windowTokens: number | undefined;
          try {
            const info = await client.info();
            const window = info.agent.model?.contextWindowTokens;
            if (typeof window === 'number' && Number.isSafeInteger(window) && window > 0) {
              windowTokens = window;
            }
          } catch {
            // Unknown capacity is displayed as unknown, never a made-up limit.
          }
          if (eve !== current || current.exitCode !== null || current.signalCode !== null) return;
          contextWindowTokens = windowTokens;
          ready = true;
          crashes = 0;
          changed();
          logger.info({ event: 'eve.ready' }, 'Eve ready');
        }
      })
      .catch(() => {
        if (eve === current && ready) {
          ready = false;
          changed();
        }
      });
  }

  return {
    isReady: () => ready,
    contextWindowTokens: () => contextWindowTokens,
    openLog() {
      logFile = openSync(options.logPath, 'a');
    },
    closeLog() {
      if (logFile !== undefined) closeSync(logFile);
    },
    prepare: () =>
      prepareEngine(options.agentRoot, options.engineRoot)
        .then(() => {
          enginePrepared = true;
          if (!options.isStopping()) start();
        })
        .catch((error) => {
          logger.error(
            { event: 'eve.prepare_failed', error: errorMessage(error) },
            'Could not prepare Eve',
          );
        }),
    async restart() {
      if (!enginePrepared) return;
      await stop();
      if (options.isStopping()) return;
      start();
      changed();
    },
    stop,
    startHealthChecks() {
      const health = setInterval(checkHealth, EVE_HEALTH_INTERVAL_MS);
      return () => clearInterval(health);
    },
  };
}
