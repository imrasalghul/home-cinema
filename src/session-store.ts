import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import session from 'express-session';

// Readers see either the old complete session or the new complete session.
// Touches update only the cookie so an older request cannot undo a login.
export class PersistentSessionStore extends session.Store {
  private writes = new Map<string, Promise<void>>();
  private destroyed = new Set<string>();
  constructor(private root: string) { super(); }
  private fileFor(sid: string) {
    return path.join(this.root, `${crypto.createHash('sha256').update(sid).digest('hex')}.json`);
  }
  private enqueue(sid: string, action: () => Promise<void>, callback?: (error?: any) => void) {
    const job = (this.writes.get(sid) || Promise.resolve()).catch(() => {}).then(action);
    this.writes.set(sid, job);
    void job.then(() => callback?.(), error => callback?.(error)).finally(() => {
      if (this.writes.get(sid) === job) this.writes.delete(sid);
    });
  }
  private async write(sid: string, value: session.SessionData) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = this.fileFor(sid);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  get(sid: string, callback: (error: any, value?: session.SessionData | null) => void) {
    void fs.readFile(this.fileFor(sid), 'utf8').then(text => {
      const value = JSON.parse(text) as session.SessionData;
      callback(null, this.destroyed.has(sid) || (value.cookie?.expires && new Date(value.cookie.expires).getTime() <= Date.now()) ? null : value);
    }).catch(error => callback(error.code === 'ENOENT' ? null : error, null));
  }
  set(sid: string, value: session.SessionData, callback?: (error?: any) => void) {
    const snapshot = JSON.parse(JSON.stringify(value));
    this.enqueue(sid, async () => { if (!this.destroyed.has(sid)) await this.write(sid, snapshot); }, callback);
  }
  touch(sid: string, value: session.SessionData, callback?: (error?: any) => void) {
    const cookie = JSON.parse(JSON.stringify(value.cookie));
    this.enqueue(sid, async () => {
      if (this.destroyed.has(sid)) return;
      let current: session.SessionData;
      try { current = JSON.parse(await fs.readFile(this.fileFor(sid), 'utf8')); }
      catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
      if (Date.parse(cookie.expires) < Date.parse(String(current.cookie.expires))) cookie.expires = current.cookie.expires;
      current.cookie = cookie;
      await this.write(sid, current);
    }, callback);
  }
  destroy(sid: string, callback?: (error?: any) => void) {
    this.destroyed.add(sid);
    // In-flight requests time out well before this; keep tombstones bounded.
    setTimeout(() => this.destroyed.delete(sid), 10 * 60_000).unref();
    this.enqueue(sid, () => fs.rm(this.fileFor(sid), { force: true }), callback);
  }
}
