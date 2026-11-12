import pino from 'pino';

export type BridgeLog = (
  message: string,
  fields?: { event: string; [key: string]: unknown },
  level?: 'info' | 'warn' | 'error',
) => void;

const logger = pino({
  base: { component: 'bridge' },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: { level: (label) => ({ level: label.toUpperCase() }) },
  redact: {
    paths: ['authorization', 'apiKey', 'token', 'password', 'headers.authorization'],
    remove: true,
  },
});

export const log: BridgeLog = (message, fields, level = 'info') => {
  logger[level](fields ?? {}, message);
};
