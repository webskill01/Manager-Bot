import pino from 'pino';

const transport = pino.transport({
  target: 'pino-pretty',
  options: { translateTime: true, colorize: true },
});

export function createLogger(botId) {
  const prefix = `[${botId}]`;
  const pinoInstance = pino({ level: 'info' }, transport);
  return {
    info: (...args) => pinoInstance.info(`${prefix} ${args[0]}`, ...args.slice(1)),
    warn: (...args) => pinoInstance.warn(`${prefix} ${args[0]}`, ...args.slice(1)),
    error: (...args) => pinoInstance.error(`${prefix} ${args[0]}`, ...args.slice(1)),
  };
}

export function panic(err, context = 'fatal-error') {
  console.error(`[PANIC] ${context} —`, err);
  process.exit(1);
}
