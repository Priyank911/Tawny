import { EventEmitter } from 'node:events';

/** The subset of a child process that the helpers need; lets tests substitute a fake. */
export interface ChildLike {
  stdin: { write(data: string): unknown } | null;
  stdout: { setEncoding?(encoding: string): unknown; on(event: 'data', listener: (chunk: string | Buffer) => void): unknown } | null;
  stderr?: { on(event: 'data', listener: (chunk: string | Buffer) => void): unknown } | null;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(): unknown;
}

export type Spawner = () => ChildLike;

/**
 * Newline-delimited text protocol over a child process's stdio. Emits 'line',
 * 'exit' and 'error'. Never throws on write: a dead helper is reported, not
 * crashed on.
 */
export class LineProcess extends EventEmitter {
  private child: ChildLike | undefined;
  private buffer = '';

  constructor(private readonly spawner: Spawner) {
    super();
  }

  get alive(): boolean {
    return this.child !== undefined;
  }

  start(): void {
    if (this.child) return;
    let child: ChildLike;
    try {
      child = this.spawner();
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.child = child;
    this.buffer = '';
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, '');
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 0) this.emit('line', line);
        newline = this.buffer.indexOf('\n');
      }
    });
    child.stderr?.on('data', () => undefined);
    child.on('error', (error) => {
      if (this.child === child) this.child = undefined;
      this.emit('error', error);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = undefined;
      this.emit('exit', code);
    });
  }

  send(line: string): boolean {
    if (!this.child?.stdin) return false;
    try {
      this.child.stdin.write(`${line}\n`);
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    try {
      child.stdin?.write('exit\n');
    } catch {
      // the pipe is already closed
    }
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
}
