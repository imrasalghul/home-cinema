import crypto from 'node:crypto';
import type { Express, Request, RequestHandler } from 'express';

type Grant = { owner: string; state: any; expires: number; paths: Set<string>; streamPrefix?: string };
const requests = new WeakMap<Request, Grant>();
export const castState = (req: Request) => requests.get(req)?.state;
export const mediaOwner = (req: Request) => requests.get(req)?.owner || req.sessionID;

export function registerCasting(app: Express, options: { auth: RequestHandler; wrap: (fn: any) => RequestHandler; state: (req: Request) => any; validate: (req: Request, url: string) => Promise<void>; validYoutubeMedia: (owner: string, url: string) => boolean }) {
  const grants = new Map<string, Grant>();
  const validPath = (value: string) => /^\/api\/(?:streams\/[A-Za-z0-9_-]+\/(?:index\.m3u8|segment\d{6}\.ts)|plex\/media\/\d+\/[A-Za-z0-9_.-]+|plex\/subtitles\/\d+\/\d+|youtube\/(?:manifest\/[A-Za-z0-9_-]{11}|media\/[A-Za-z0-9_-]+|captions\/[A-Za-z0-9_-]{11}\/\d+))$/.test(value);
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/cast-media/')) { next(); return; }
    const match = req.path.match(/^\/api\/cast-media\/([A-Za-z0-9_-]+)(\/api\/.*)$/);
    const grant = match && grants.get(match[1]);
    if (!match || !grant || grant.expires < Date.now() || !validPath(match[2]) || !(grant.paths.has(match[2]) || (grant.streamPrefix && match[2].startsWith(grant.streamPrefix)))) { res.status(403).json({ error: 'Cast playback URL expired or is invalid.' }); return; }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    const setHeader = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: any) => {
      if (name.toLowerCase() === 'cache-control' && typeof value === 'string') {
        const seconds = Math.max(0, Math.floor((grant.expires - Date.now()) / 1000));
        value = value.replace(/((?:s-)?max-age=)(\d+)/g, (_match: string, prefix: string, age: string) => `${prefix}${Math.min(Number(age), seconds)}`);
      }
      return setHeader(name, value);
    }) as typeof res.setHeader;
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.status(405).end(); return; }
    requests.set(req, grant);
    const prefix = `/api/cast-media/${match[1]}`;
    const send = res.send.bind(res);
    res.send = ((body: any) => {
      if (typeof body === 'string' && /(?:mpegurl|dash\+xml)/i.test(String(res.getHeader('Content-Type') || ''))) {
        body = body.replace(/\/api\/(?:streams|youtube)\/[^\s<>"']+/g, url => {
          if (options.validYoutubeMedia(grant.owner, url)) grant.paths.add(url);
          return grant.paths.has(url) || grant.streamPrefix && url.startsWith(grant.streamPrefix) ? `${prefix}${url}` : url;
        });
      }
      return send(body);
    }) as typeof res.send;
    req.url = match[2]; next();
  });
  app.post('/api/cast', options.auth, options.wrap(async (req: Request, res: any) => {
    const url = String(req.body.url || '');
    if (!validPath(url) || url.includes('/subtitles/') || url.includes('/captions/')) throw Object.assign(new Error('Invalid cast source.'), { status: 400 });
    await options.validate(req, url);
    const paths = new Set([url]);
    const subtitles: Array<{ src: string; label: string; language: string }> = [];
    for (const track of (Array.isArray(req.body.subtitles) ? req.body.subtitles.slice(0, 30) : [])) {
      const src = String(track.src || '');
      if (validPath(src) && /\/api\/(?:plex\/subtitles|youtube\/captions)\//.test(src)) {
        await options.validate(req, src);
        paths.add(src); subtitles.push({ src, label: String(track.label || ''), language: String(track.language || '') });
      }
    }
    const token = crypto.randomBytes(24).toString('base64url');
    const state = options.state(req);
    const grant: Grant = { owner: req.sessionID, state: { plexToken: state.plexToken, plexUser: state.plexUser }, expires: Date.now() + 12 * 3600_000, paths, streamPrefix: url.startsWith('/api/streams/') ? url.slice(0, url.lastIndexOf('/') + 1) : undefined };
    grants.set(token, grant);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ url: `/api/cast-media/${token}${url}`, subtitles: subtitles.map(track => ({ ...track, src: `/api/cast-media/${token}${track.src}` })) });
  }));
  const expiry = setInterval(() => { for (const [key, grant] of grants) if (grant.expires < Date.now()) grants.delete(key); }, 60_000); expiry.unref();
}
