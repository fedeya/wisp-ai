import pino from 'pino';

const rootLogger = pino({
  base: null,
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: { level: (label) => ({ level: label.toUpperCase() }) },
  redact: {
    paths: ['authorization', 'apiKey', 'token', 'password', 'headers.authorization'],
    remove: true,
  },
});

export const bridgeLogger = rootLogger.child({ component: 'bridge' });
