import pino from 'pino';

export function createLogger(name: string, level?: string) {
  return pino({
    name,
    level: level || process.env.ORCH_LOG_LEVEL || 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });
}

export const logger = createLogger('orchestrator');

export type Logger = pino.Logger;
