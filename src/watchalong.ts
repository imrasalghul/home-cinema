import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Express, Request, RequestHandler } from 'express';

type User = { id: string; name: string; keys: string[] };
type Member = User & { accepted: boolean; joined: boolean; ready: boolean; seen: number };
type Room = { id: string; itemKey: string; title: string; duration: number; created: number; ended: boolean; position: number; updated: number; playing: boolean; intent: boolean; revision: number; members: Member[] };
type Options = { root: string; sessions: string; machine: string; state: (req: Request) => { plexToken?: string; plexUser?: { id?: number; username?: string; title?: string; email?: string } }; headers: (token?: string) => HeadersInit; metadata: (req: Request, key: string) => Promise<any>; auth: RequestHandler; wrap: (fn: any) => RequestHandler };

export function registerWatchalong(app: Express, o: Options) {
  const rooms = new Map<string, Room>();
  const file = path.join(o.root, 'watchalong.json');
  let loaded: Promise<void> | undefined;
  let writes = Promise.resolve();
  let directory: { expires: number; users: User[] } | undefined;
  const hash = (value: string) => crypto.createHash('sha256').update(`${o.machine}:${value.trim().toLowerCase()}`).digest('hex');
  const user = (account: any): User => {
    const aliases = [account.email, account.username, account.id && `id:${account.id}`, !account.email && !account.username && account.title].filter(Boolean).map(String);
    return { id: hash(aliases[0] || ''), name: account.username || account.title || 'Plex user', keys: [...new Set(aliases.map(hash))] };
  };
  const actor = (req: Request) => user(o.state(req).plexUser);
  const matches = (a: User, b: User) => a.keys.some(key => b.keys.includes(key));
  const load = () => loaded ||= (async () => {
    try {
      for (const room of JSON.parse(await fs.readFile(file, 'utf8')) as Room[]) {
        if (room.created > Date.now() - 86_400_000 && !room.ended) {
          room.playing = false; room.intent = false;
          room.members.forEach(member => { member.joined = false; member.ready = false; member.seen = 0; });
          rooms.set(room.id, room);
        }
      }
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  })();
  const persist = () => {
    const snapshot = JSON.stringify([...rooms.values()].filter(room => room.created > Date.now() - 86_400_000));
    writes = writes.catch(() => {}).then(async () => {
      await fs.mkdir(o.root, { recursive: true, mode: 0o700 });
      await fs.writeFile(`${file}.tmp`, snapshot, { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
    });
    return writes;
  };
  const position = (room: Room) => Math.min(room.duration, room.position + (room.playing ? (Date.now() - room.updated) / 1000 : 0));
  const reconcile = (room: Room) => {
    const playing = room.intent && !room.ended && room.members.every(member => member.accepted && member.joined && member.ready && member.seen > Date.now() - 20_000);
    if (playing !== room.playing) { room.position = position(room); room.updated = Date.now(); room.playing = playing; room.revision++; }
  };
  const view = (room: Room) => { reconcile(room); return { id: room.id, itemKey: room.itemKey, title: room.title, ended: room.ended, position: position(room), playing: room.playing, intent: room.intent, revision: room.revision, serverTime: Date.now(), members: room.members.map(member => ({ name: member.name, accepted: member.accepted, connected: member.joined && member.seen > Date.now() - 20_000, ready: member.ready })) }; };
  const roomFor = async (req: Request) => {
    await load();
    const room = rooms.get(String(req.params.roomId));
    if (!room || room.created < Date.now() - 86_400_000 || !room.members.some(member => matches(member, actor(req)))) throw Object.assign(new Error('Watchalong invitation not found.'), { status: 404 });
    return room;
  };
  const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const attrs = (text: string) => Object.fromEntries([...text.matchAll(/([\w]+)="([^"]*)"/g)].map(match => [match[1], decode(match[2])]));
  async function users(req: Request) {
    if (directory && directory.expires > Date.now()) return directory.users;
    const tokens = new Set<string>();
    if (process.env.PLEX_OWNER_TOKEN) tokens.add(process.env.PLEX_OWNER_TOKEN);
    if (o.state(req).plexToken) tokens.add(o.state(req).plexToken!);
    for (const name of (await fs.readdir(o.sessions).catch(() => [])).slice(0, 100)) {
      try { const session = JSON.parse(await fs.readFile(path.join(o.sessions, name), 'utf8')); if (session.plexToken && session.cookie?.expires && Date.parse(session.cookie.expires) > Date.now()) tokens.add(session.plexToken); } catch {}
    }
    for (const token of tokens) {
      const response = await fetch('https://plex.tv/api/users', { headers: { ...o.headers(token), Accept: 'application/xml' }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) continue;
      const xml = await response.text();
      const found: User[] = [];
      for (const block of xml.matchAll(/<User\b([^>]*?)(?:\/>|>([\s\S]*?)<\/User>)/g)) {
        const data = attrs(block[1]);
        const servers = [...(block[2] || '').matchAll(/<Server\b([^>]*?)\/?\s*>/g)].map(match => attrs(match[1]));
        if (servers.some(server => server.machineIdentifier === o.machine && server.pending !== '1') && data.id) found.push(user(data));
      }
      if (!found.length) continue;
      const accountResponse = await fetch('https://plex.tv/api/v2/user', { headers: o.headers(token), signal: AbortSignal.timeout(10_000) });
      if (accountResponse.ok) found.push(user(await accountResponse.json()));
      directory = { expires: Date.now() + 300_000, users: [...new Map(found.map(value => [value.id, value])).values()] };
      return directory.users;
    }
    throw Object.assign(new Error('Could not load this server’s Plex users. Sign in with the server owner once to make the user directory available.'), { status: 503 });
  }
  app.get('/api/watchalong/users', o.auth, o.wrap(async (req: Request, res: any) => {
    const list = await users(req); res.setHeader('Cache-Control', 'private, no-store');
    res.json(list.filter(entry => !matches(entry, actor(req))).map(({ id, name }) => ({ id, name })));
  }));
  app.get('/api/watchalong/notifications', o.auth, o.wrap(async (req: Request, res: any) => {
    await load(); const me = actor(req);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json([...rooms.values()].filter(room => !room.ended && room.created > Date.now() - 86_400_000 && room.members.some(member => matches(member, me))).map(room => ({ ...view(room), inviter: room.members[0].name, accepted: room.members.find(member => matches(member, me))!.accepted })));
  }));
  app.post('/api/watchalong', o.auth, o.wrap(async (req: Request, res: any) => {
    await load(); const me = actor(req);
    const target = (await users(req)).find(entry => entry.id === req.body.userId && !matches(entry, me));
    if (!target) throw Object.assign(new Error('Choose an existing user on this Plex server.'), { status: 400 });
    const key = String(req.body.itemKey || '');
    if (!/^\d{1,20}$/.test(key)) throw Object.assign(new Error('Choose a movie or episode.'), { status: 400 });
    const item = await o.metadata(req, key);
    if (!item || !['movie', 'episode'].includes(item.type)) throw Object.assign(new Error('Choose a movie or episode.'), { status: 400 });
    const existing = [...rooms.values()].find(room => !room.ended && room.created > Date.now() - 86_400_000 && room.itemKey === key && room.members.some(member => matches(member, me)) && room.members.some(member => matches(member, target)));
    if (existing) { res.json(view(existing)); return; }
    if ([...rooms.values()].filter(room => !room.ended && room.created > Date.now() - 86_400_000 && matches(room.members[0], me)).length >= 10) throw Object.assign(new Error('Close an existing watchalong before creating another.'), { status: 400 });
    const duration = Number(item.duration) / 1000;
    const room: Room = { id: crypto.randomUUID(), itemKey: key, title: item.type === 'episode' ? `${item.grandparentTitle || ''} — ${item.title}` : item.title, duration: duration || 86400, created: Date.now(), ended: false, position: Math.max(0, Math.min(duration || 86400, Number(req.body.position) || 0)), updated: Date.now(), playing: false, intent: true, revision: 0, members: [{ ...me, accepted: true, joined: false, ready: false, seen: 0 }, { ...target, accepted: false, joined: false, ready: false, seen: 0 }] };
    rooms.set(room.id, room); await persist(); res.json(view(room));
  }));
  app.post('/api/watchalong/:roomId/join', o.auth, o.wrap(async (req: Request, res: any) => {
    const room = await roomFor(req); if (room.ended) throw Object.assign(new Error('This watchalong has ended.'), { status: 410 });
    await o.metadata(req, room.itemKey);
    const member = room.members.find(entry => matches(entry, actor(req)))!;
    member.accepted = true; member.joined = true; member.ready = false; member.seen = Date.now(); reconcile(room); await persist(); res.json(view(room));
  }));
  app.post('/api/watchalong/:roomId/sync', o.auth, o.wrap(async (req: Request, res: any) => {
    const room = await roomFor(req); const member = room.members.find(entry => matches(entry, actor(req)))!;
    if (!member.accepted || room.ended) { res.json(view(room)); return; }
    member.joined = true;
    reconcile(room); member.ready = req.body.ready === true; member.seen = Date.now();
    const command = req.body.command;
    if (['play', 'pause', 'seek'].includes(command)) {
      room.position = position(room); room.updated = Date.now();
      if (['seek', 'pause'].includes(command) && Number.isFinite(req.body.position)) room.position = Math.max(0, Math.min(room.duration, req.body.position));
      if (command === 'play') room.intent = true;
      if (command === 'pause') room.intent = false;
      room.revision++;
    }
    reconcile(room); res.json(view(room)); if (command) await persist();
  }));
  app.post('/api/watchalong/:roomId/leave', o.auth, o.wrap(async (req: Request, res: any) => {
    const room = await roomFor(req);
    if (req.body?.end !== true) { const member = room.members.find(entry => matches(entry, actor(req)))!; member.joined = false; member.ready = false; member.seen = 0; reconcile(room); await persist(); res.json({ disconnected: true }); return; }
    room.position = position(room); room.updated = Date.now(); room.playing = false; room.intent = false; room.ended = true; room.revision++; await persist(); res.json({ ended: true });
  }));
  app.post('/api/watchalong/:roomId/disconnect', o.auth, o.wrap(async (req: Request, res: any) => {
    const room = await roomFor(req);
    const member = room.members.find(entry => matches(entry, actor(req)))!;
    member.joined = false; member.ready = false; member.seen = 0; reconcile(room);
    await persist(); res.json({ disconnected: true });
  }));
  const expiry = setInterval(() => { for (const room of rooms.values()) reconcile(room); }, 500);
  expiry.unref();
}
