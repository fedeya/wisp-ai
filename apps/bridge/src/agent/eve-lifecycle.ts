import type { ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import type { Client } from 'eve/client';
import type { Logger } from 'pino';
import { startEveProcess, stopEveProcess } from './agent-process.ts';
import { prepareEngine } from '../app-paths.ts';
import { errorMessage } from '../errors.ts';

/** How often a running Eve is probed for readiness. */
export const EVE_HEALTH_INTERVAL_MS = 3000;

export interface EveLifecycleOptions {
  /** Authored agent sources and the folder Eve runs from (see `prepareEngine`). */
  agentRoot: string;
  engineRoot: string;
  logPath: string;
  /** Environment for each spawn; read at spawn time so a model change applies. */
  environment: () => NodeJS.ProcessEnv;
  client: Pick<Client, 'health' | 'info'>;
  startAgent?: typeof startEveProcess;
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

  function spawn() {
    if (logFile === undefined) throw Error('Eve log is not open.');
    return (options.startAgent || startEveProcess)({
      root: options.engineRoot,
      logFile,
      environment: options.environment(),
      onError: (error) =>
        logger.error(
          { event: 'eve.spawn_failed', error: errorMessage(error) },
          'Could not start Eve',
        ),
      onExit: (code) => {
        ready = false;
        changed();
        logger.info({ event: 'eve.exited', code }, 'Eve exited');
      },
    });
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
    }
  }

  async function stop() {
    if (eve) {
      await stopEveProcess(eve);
      eve = undefined;
    }
    ready = false;
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
