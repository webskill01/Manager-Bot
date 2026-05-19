import pino from 'pino';

const _istFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

function istTimestamp() {
  const p = Object.fromEntries(_istFmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return `,"time":"${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} IST"`;
}

const transport = pino.transport({
  target: 'pino-pretty',
  options: { translateTime: false, colorize: true },
});

export function createLogger(botId) {
  const prefix = `[${botId}]`;
  const pinoInstance = pino({ level: 'info', timestamp: istTimestamp }, transport);
  return {
    info:  (...args) => pinoInstance.info(`${prefix} ${args[0]}`, ...args.slice(1)),
    warn:  (...args) => pinoInstance.warn(`${prefix} ${args[0]}`, ...args.slice(1)),
    error: (...args) => pinoInstance.error(`${prefix} ${args[0]}`, ...args.slice(1)),
  };
}

export function panic(err, context = 'fatal-error') {
  console.error(`[PANIC] ${context} —`, err);
  process.exit(1);
}
