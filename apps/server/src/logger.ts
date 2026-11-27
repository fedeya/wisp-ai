// @effect-migrated
import { Formatter, Logger, Predicate, Record } from 'effect';

// Keep the existing bridge.log format and redact credentials from structured fields.
export const bridgeLogging = Logger.layer([
  Logger.withConsoleLog(
    Logger.map(
      Logger.formatStructured,
      ({ annotations, level, timestamp, message, cause, spans }) => {
        const fields = { ...annotations };
        for (const key of ['authorization', 'apiKey', 'token', 'password']) {
          delete fields[key];
        }
        if (Predicate.isObject(fields.headers) && Object.hasOwn(fields.headers, 'authorization')) {
          fields.headers = Record.remove(fields.headers, 'authorization');
        }
        return Formatter.formatJson({
          ...fields,
          level,
          timestamp,
          component: 'bridge',
          msg: message,
          cause,
          spans: Object.keys(spans).length > 0 ? spans : undefined,
        });
      },
    ),
  ),
]);
