// ============================================================
// Simple structured logger
// ============================================================

type LogLevel = 'info' | 'warn' | 'error' | 'trade' | 'signal';

const COLORS: Record<LogLevel, string> = {
  info:   '\x1b[36m',   // cyan
  warn:   '\x1b[33m',   // yellow
  error:  '\x1b[31m',   // red
  trade:  '\x1b[32m',   // green
  signal: '\x1b[35m',   // magenta
};
const RESET = '\x1b[0m';

export function log(level: LogLevel, message: string, data?: any): void {
  const timestamp = new Date().toISOString();
  const color = COLORS[level] || '';
  const prefix = `${color}[${timestamp}] [${level.toUpperCase()}]${RESET}`;

  if (data) {
    console.log(`${prefix} ${message}`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}
