export interface AccountOperationsOptions {
  isStopping: () => boolean;
  /** Whether a chat turn is running; account changes wait for it. */
  hasActiveTurn: () => boolean;
  /** Runs after each operation unless the bridge is stopping. */
  afterOperation: () => void;
}

export interface AccountOperations {
  /** Whether an account operation is running; turns wait for it. */
  busy(): boolean;
  /**
   * Run one account change (sign-in, connection or model list) at a time.
   * Rejects at once while another operation or a chat turn is running.
   */
  run<T>(operation: () => Promise<T>): Promise<T>;
  /** Wait for the running operation, if any, to settle. */
  drain(): Promise<void>;
}

export function createAccountOperations(options: AccountOperationsOptions): AccountOperations {
  let busy = false;
  let work: Promise<unknown> | undefined;
  return {
    busy: () => busy,
    async run<T>(operation: () => Promise<T>) {
      if (options.isStopping() || busy || options.hasActiveTurn()) {
        throw Error('Wait for the active operation to finish.');
      }
      busy = true;
      try {
        const current = operation();
        work = current;
        return await current;
      } finally {
        busy = false;
        work = undefined;
        if (!options.isStopping()) {
          options.afterOperation();
        }
      }
    },
    async drain() {
      await work;
    },
  };
}
