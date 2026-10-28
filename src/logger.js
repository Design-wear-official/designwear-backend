import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Removes things that must never reach a log: tokens, passwords, emails. */
// key=value / "key": "value" pairs whose key names a secret.
const SECRET_ASSIGNMENT =
  /("?(?:password|token|secret|code|authorization)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,&}]+)/gi;

export function redact(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[jwt]')
    .replace(SECRET_ASSIGNMENT, '$1[redacted]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]');
}

const LEVELS = ['debug', 'info', 'warning', 'error'];
export const isLevel = (l) => LEVELS.includes(l);

/** One JSON line per event. `sink` is any (line) => void; stdout by default. */
export function createLogger({
  sink = (line) => process.stdout.write(line + '\n'),
  now = () => Date.now(),
} = {}) {
  const emit = (event) => sink(JSON.stringify({ ts: new Date(now()).toISOString(), ...event }));
  return {
    request: (e) => emit({ type: 'request', ...e }),
    error: (message, err) =>
      emit({
        type: 'server_error',
        level: 'error',
        message: redact(message),
        stack: redact(err?.stack ?? '').slice(0, 2000),
      }),
    client: (entries, meta) => {
      for (const e of entries) emit({ type: 'client', ...meta, ...e });
    },
  };
}

/** Appends lines to a file, rotating to `<file>.1` at maxBytes. */
export class FileSink {
  constructor(file, maxBytes = 5_000_000) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.chain = Promise.resolve();
  }
  write = (line) => {
    this.chain = this.chain
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const size = await stat(this.file).then((s) => s.size, () => 0);
        if (size > this.maxBytes) await rename(this.file, `${this.file}.1`);
        await appendFile(this.file, line + '\n', { mode: 0o600 });
      })
      .catch((e) => console.error('log write failed:', e.message));
  };
}
