import fs from 'node:fs';
import path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_VALUE: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  private name: string;
  private minLevel: number;
  private logDir: string | null;
  private currentDate = '';
  private stream: fs.WriteStream | null = null;

  constructor(name: string, opts?: { level?: Level; logDir?: string | null }) {
    this.name = name;
    this.minLevel = LEVEL_VALUE[(opts?.level ?? (process.env['LOG_LEVEL'] as Level) ?? 'info') as Level] ?? LEVEL_VALUE['info'];
    this.logDir = opts?.logDir ?? process.env['LOG_DIR'] ?? null;
  }

  debug(msg: string, data?: Record<string, unknown>) { this.write('debug', msg, data); }
  info(msg: string, data?: Record<string, unknown>)  { this.write('info', msg, data); }
  warn(msg: string, data?: Record<string, unknown>)  { this.write('warn', msg, data); }
  error(msg: string, data?: Record<string, unknown>) { this.write('error', msg, data); }

  private write(level: Level, msg: string, data?: Record<string, unknown>) {
    if (LEVEL_VALUE[level] < this.minLevel) return;
    const entry = { time: new Date().toISOString(), level, name: this.name, msg, ...data };
    const line = JSON.stringify(entry);

    if (level === 'debug') console.debug(line);
    else if (level === 'warn') console.warn(line);
    else if (level === 'error') console.error(line);
    else console.log(line);

    this.ensureStream()?.write(line + '\n');
  }

  private ensureStream(): fs.WriteStream | null {
    if (!this.logDir) return null;
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.currentDate) {
      this.stream?.end();
      this.currentDate = today;
      fs.mkdirSync(this.logDir, { recursive: true });
      this.stream = fs.createWriteStream(path.join(this.logDir, `${today}.log`), { flags: 'a' });
    }
    return this.stream;
  }
}

export function createLogger(name: string, opts?: { level?: Level; logDir?: string | null }): Logger {
  return new Logger(name, opts);
}

export type { Level as LogLevel };
