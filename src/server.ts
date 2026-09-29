import 'dotenv/config';
import crypto from 'node:crypto';
import { execFile as execFileCb, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response as ExpressResponse } from 'express';
import session from 'express-session';
import mime from 'mime-types';
import { PersistentSessionStore } from './session-store';
import { byteRange, requestedSeasons, changeSubscription } from './media-rules';
import { registerWatchalong } from './watchalong';
import { registerCasting, castState, mediaOwner } from './casting';

const execFile = promisify(execFileCb);
const app = express();
const PORT = Number(process.env.PORT || 3001);
const CLIENT_ID = process.env.PLEX_CLIENT_IDENTIFIER || '4f10e17a-0aef-48ef-9c93-2b841792a109';
const SITE_NAME = (process.env.SITE_NAME || 'Media Home').trim().slice(0, 80) || 'Media Home';
const PRODUCT = SITE_NAME;
const VERSION = '0.1.0';
const PLEX_URL = (process.env.PLEX_SERVER_URL || '').replace(/\/$/, '');
const PLEX_MACHINE_ID = process.env.PLEX_MACHINE_ID || '';
const SEERR_URL = (process.env.SEERR_URL || '').replace(/\/$/, '');
const SEERR_API_KEY = process.env.SEERR_API_KEY || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'development-only-change-me';
const INVIDIOUS_URL = (process.env.INVIDIOUS_URL || '').replace(/\/$/, '');
const NAVIDROME_URL = (process.env.NAVIDROME_URL || '').replace(/\/$/, '');
const NAVIDROME_USERNAME = process.env.NAVIDROME_USERNAME || '';
const NAVIDROME_PASSWORD = process.env.NAVIDROME_PASSWORD || '';
const GENIUS_ACCESS_TOKEN = process.env.GENIUS_ACCESS_TOKEN || '';
const geniusCache = new Map<string, { expires: number; songs: { id: number; title: string; artist: string; url: string }[] }>();
const TVH_URL = (process.env.TVHEADEND_URL || '').replace(/\/$/, '');
const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || '/media/library');
const SESSION_DATA_ROOT = path.resolve(process.env.SESSION_DATA_ROOT || path.join(process.cwd(), '.data', 'sessions'));
const PROFILE_DATA_ROOT = path.resolve(process.env.PROFILE_DATA_ROOT || path.join(path.dirname(SESSION_DATA_ROOT), 'profiles'));
const HLS_ROOT = path.join(os.tmpdir(), 'home-cinema-hls');
const HLS_SEGMENT_SECONDS = 4;
type StreamSession = {
  directory: string;
  owner: string;
  process: ChildProcess | null;
  live: boolean;
  filePath?: string;
  durationSeconds?: number;
  createdAt: number;
  lastAccess: number;
  segmentJobs: Map<number, Promise<void>>;
  closed?: boolean;
};
const streamSessions = new Map<string, StreamSession>();
const youtubeMediaUrls = new Map<string, { owner: string; url: string; expiresAt: number }>();
const tvhIconPaths = new Map<string, string>();
let tvhGuideCache: { key: number; expiresAt: number; start: number; end: number; events: MediaItem[] } | null = null;

type PlexState = session.Session & {
  plexToken?: string;
  plexUser?: { id?: number; username?: string; title?: string; email?: string };
  plexPin?: { id: number; code: string; expiresAt: number };
};

type UserProfile = {
  subscriptions: Array<{ id: string; name: string }>;
  watchlist: Array<{ id: string; title: string; author: string; authorId: string | null; durationSeconds: number; thumbnail: string | null; publishedText: string; published: number; viewCountText: string }>;
  watchedVideoIds: string[];
  mediaProgress: Record<string, { seconds: number; duration: number; updatedAt: number }>;
};

const emptyUserProfile = (): UserProfile => ({ subscriptions: [], watchlist: [], watchedVideoIds: [], mediaProgress: {} });

type MediaItem = Record<string, any>;

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(session({
  name: 'home-cinema.sid',
  secret: SESSION_SECRET,
  store: new PersistentSessionStore(SESSION_DATA_ROOT),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

function asyncRoute(handler: (req: Request, res: ExpressResponse) => Promise<void>) {
  return (req: Request, res: ExpressResponse, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

function plexState(req: Request): PlexState {
  return castState(req) || req.session as PlexState;
}

function profileFile(req: Request) {
  const account = plexState(req).plexUser;
  const identity = String(account?.email || account?.username || account?.title || '').trim().toLocaleLowerCase();
  if (!identity) throw Object.assign(new Error('The signed-in Plex account has no profile identifier.'), { status: 401 });
  const accountId = crypto.createHash('sha256').update(`${PLEX_MACHINE_ID}:${identity}`).digest('hex');
  return path.join(PROFILE_DATA_ROOT, `${accountId}.json`);
}

async function readUserProfile(req: Request): Promise<UserProfile> {
  try {
    const value = JSON.parse(await fsp.readFile(profileFile(req), 'utf8')) as Partial<UserProfile>;
    return {
      ...emptyUserProfile(), ...value,
      subscriptions: Array.isArray(value.subscriptions) ? value.subscriptions : [],
      watchlist: Array.isArray(value.watchlist) ? value.watchlist : [],
      watchedVideoIds: Array.isArray(value.watchedVideoIds) ? value.watchedVideoIds : [],
      mediaProgress: value.mediaProgress && typeof value.mediaProgress === 'object' ? value.mediaProgress : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyUserProfile();
    throw error;
  }
}

async function writeUserProfile(req: Request, profile: UserProfile) {
  const file = profileFile(req);
  await fsp.mkdir(PROFILE_DATA_ROOT, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(profile), { mode: 0o600 });
  await fsp.rename(temporary, file);
}

const profileWrites = new Map<string, Promise<void>>();
async function updateUserProfile(req: Request, mutate: (profile: UserProfile) => void | Promise<void>) {
  const key = profileFile(req);
  const previous = profileWrites.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const profile = await readUserProfile(req);
    await mutate(profile);
    await writeUserProfile(req, profile);
  });
  profileWrites.set(key, current);
  try { await current; }
  finally { if (profileWrites.get(key) === current) profileWrites.delete(key); }
}

function seerrConfigured() {
  return Boolean(SEERR_URL && SEERR_API_KEY);
}

function seerrUrl(resourcePath: string) {
  if (!seerrConfigured()) throw Object.assign(new Error('Seerr is not configured. Set SEERR_URL and SEERR_API_KEY on the server.'), { status: 503 });
  return new URL(`/api/v1/${resourcePath.replace(/^\/+/, '')}`, `${SEERR_URL}/`);
}

async function seerrFetch(resourcePath: string, init: RequestInit = {}) {
  const response = await fetch(seerrUrl(resourcePath), {
    ...init,
    headers: { Accept: 'application/json', 'X-Api-Key': SEERR_API_KEY, ...(init.headers as Record<string, string> | undefined) },
    signal: init.signal || AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    let detail = '';
    try { const payload = await response.json() as { message?: string }; detail = payload.message || ''; } catch { /* use status only */ }
    const status = response.status === 401 || response.status === 403 ? 502 : response.status >= 500 ? 502 : response.status;
    throw Object.assign(new Error(detail || `Seerr returned HTTP ${response.status}.`), { status });
  }
  return response;
}

async function invidiousJson(resourcePath: string) {
  if (!INVIDIOUS_URL) throw Object.assign(new Error('Invidious is not configured. Set INVIDIOUS_URL in the server environment.'), { status: 503 });
  const response = await fetch(new URL(`/api/v1/${resourcePath.replace(/^\/+/, '')}`, `${INVIDIOUS_URL}/`), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw Object.assign(new Error(`Invidious returned HTTP ${response.status}.`), { status: 502 });
  return response.json() as Promise<any>;
}

function mediaCacheSignature(ratingKey: string) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(`plex-media:${PLEX_MACHINE_ID}:${ratingKey}`).digest('base64url');
}

function requirePlex(req: Request, res: ExpressResponse, next: NextFunction) {
  if (!plexState(req).plexToken) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(401).json({ error: 'Sign in with Plex to continue.' });
    return;
  }
  next();
}

function plexHeaders(token?: string): HeadersInit {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Plex-Product': PRODUCT,
    'X-Plex-Version': VERSION,
    'X-Plex-Client-Identifier': CLIENT_ID,
    'X-Plex-Platform': 'Web',
    'X-Plex-Device': 'Browser',
  };
  if (token) headers['X-Plex-Token'] = token;
  return headers;
}

function plexServerUrl() {
  if (!PLEX_URL || !PLEX_MACHINE_ID) throw Object.assign(new Error('Plex server configuration is missing.'), { status: 503 });
  return PLEX_URL;
}

async function plexFetch(token: string, resourcePath: string, init: RequestInit = {}) {
  const response = await fetch(new URL(resourcePath, `${plexServerUrl()}/`), {
    ...init,
    headers: { ...plexHeaders(token), ...(init.headers as Record<string, string> | undefined) },
    signal: init.signal || AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const error = new Error(response.status === 401 || response.status === 403
      ? 'Your Plex account cannot access this item.'
      : `Plex returned HTTP ${response.status}.`);
    throw Object.assign(error, { status: response.status === 401 || response.status === 403 ? 403 : 502 });
  }
  return response;
}

async function plexJson(token: string, resourcePath: string) {
  const response = await plexFetch(token, resourcePath);
  return response.json() as Promise<Record<string, any>>;
}

function mediaContainer(payload: Record<string, any>): Record<string, any> {
  return payload.MediaContainer || payload;
}

function metadataRows(payload: Record<string, any>): MediaItem[] {
  const container = mediaContainer(payload);
  return container.Metadata || container.Directory || [];
}

function safeItem(item: MediaItem) {
  return {
    ratingKey: String(item.ratingKey || ''),
    key: item.key,
    type: item.type,
    title: item.title,
    year: item.year,
    summary: item.summary,
    thumb: item.thumb ? `/api/plex/thumb/${encodeURIComponent(String(item.ratingKey))}` : null,
    art: item.art ? `/api/plex/thumb/${encodeURIComponent(String(item.ratingKey))}?art=1` : null,
    duration: item.duration,
    viewOffset: Number(item.viewOffset) || 0,
    index: item.index,
    parentIndex: item.parentIndex,
    parentTitle: item.parentTitle,
    grandparentTitle: item.grandparentTitle,
    leafCount: item.leafCount,
    viewedLeafCount: item.viewedLeafCount,
    originallyAvailableAt: item.originallyAvailableAt,
    contentRating: item.contentRating,
    audienceRating: item.audienceRating,
    rating: item.rating,
    ratings: (item.Rating || []).filter((rating: MediaItem) => String(rating.image || '').startsWith('rottentomatoes://')).map((rating: MediaItem) => ({ type: rating.type, value: Number(rating.value), source: 'Rotten Tomatoes' })),
    ratingImage: item.ratingImage,
    audienceRatingImage: item.audienceRatingImage,
    genres: (item.Genre || []).map((genre: MediaItem) => genre.tag),
    directors: (item.Director || []).map((director: MediaItem) => director.tag),
    cast: (item.Role || []).slice(0, 12).map((role: MediaItem) => role.tag),
    tagline: item.tagline,
  };
}

function tvhHeaders(): HeadersInit {
  const user = process.env.TVHEADEND_USERNAME || '';
  const password = process.env.TVHEADEND_PASSWORD || '';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (user || password) headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  return headers;
}

function navidromeConfigured() {
  return Boolean(NAVIDROME_URL && NAVIDROME_USERNAME && NAVIDROME_PASSWORD);
}

function navidromeEndpoint(pathname: string, params: Record<string, string> = {}) {
  if (!NAVIDROME_URL) throw Object.assign(new Error('Navidrome is not configured.'), { status: 503 });
  const url = new URL(`/rest/${pathname}.view`, `${NAVIDROME_URL}/`);
  const salt = crypto.randomBytes(12).toString('hex');
  const token = crypto.createHash('md5').update(`${NAVIDROME_PASSWORD}${salt}`).digest('hex');
  url.search = new URLSearchParams({ u: NAVIDROME_USERNAME, t: token, s: salt, v: '1.16.1', c: SITE_NAME, f: 'json', ...params }).toString();
  return url;
}

async function navidromeJson(pathname: string, params: Record<string, string> = {}) {
  if (!navidromeConfigured()) throw Object.assign(new Error('Navidrome is not configured. Set NAVIDROME_URL, NAVIDROME_USERNAME and NAVIDROME_PASSWORD on the server.'), { status: 503 });
  const response = await fetch(navidromeEndpoint(pathname, params), { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw Object.assign(new Error(`Navidrome returned HTTP ${response.status}.`), { status: 502 });
  const payload = await response.json() as any;
  const result = payload['subsonic-response'];
  if (!result || result.status !== 'ok') {
    const code = result?.error?.code;
    const message = code === 40 || code === 41 ? 'Navidrome rejected its configured login.' : 'Navidrome could not complete the request.';
    throw Object.assign(new Error(message), { status: code === 40 || code === 41 ? 502 : 502 });
  }
  return result;
}

function safeMusicAlbum(album: MediaItem) {
  return { id: String(album.id), name: album.name || 'Unknown album', artist: album.artist || 'Unknown artist', coverArt: album.coverArt ? String(album.coverArt) : undefined, songCount: Number(album.songCount) || 0, year: Number(album.year) || undefined };
}

function safeMusicTrack(track: MediaItem) {
  return { id: String(track.id), title: track.title || 'Unknown track', artist: track.artist || 'Unknown artist', album: track.album || '', coverArt: track.coverArt ? String(track.coverArt) : undefined, duration: Number(track.duration) || undefined, contentType: typeof track.contentType === 'string' ? track.contentType : undefined };
}

function navidromeStreamUrl(id: string) {
  const url = navidromeEndpoint('stream', { id });
  return url.pathname + url.search;
}

function tvhUrl(resourcePath: string) {
  if (!TVH_URL) throw Object.assign(new Error('TVHeadend URL is not configured.'), { status: 503 });
  return new URL(resourcePath.replace(/^\//, ''), `${TVH_URL}/`);
}

async function tvhFetch(resourcePath: string, signal?: AbortSignal, timeoutMs = 30_000) {
  const options: RequestInit = { headers: tvhHeaders() };
  if (signal) options.signal = signal;
  else if (timeoutMs > 0) options.signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(tvhUrl(resourcePath), options);
  if (!response.ok) {
    const error = new Error(response.status === 401
      ? 'TVHeadend rejected the configured credentials.'
      : response.status === 403
        ? 'TVHeadend denied access. Enable Web Interface access for channel and guide data, and Streaming access for playback.'
      : `TVHeadend returned HTTP ${response.status}.`);
    throw Object.assign(error, { status: response.status === 401 || response.status === 403 ? 502 : 502 });
  }
  return response;
}

async function tvhJson(resourcePath: string) {
  const response = await tvhFetch(resourcePath);
  return response.json() as Promise<Record<string, any>>;
}

async function tvhGuideWindow() {
  const now = Math.floor(Date.now() / 1000);
  const block = Math.floor(now / 1800);
  if (tvhGuideCache?.key === block && tvhGuideCache.expiresAt > Date.now()) return tvhGuideCache;
  const start = block * 1800;
  const end = start + 4 * 3600;
  const base = 'api/epg/events/grid';
  const first = await tvhJson(`${base}?start=0&limit=1&sort=start&dir=ASC`);
  const total = Math.max(0, Number(first.totalCount) || 0);
  let low = 0;
  let high = total;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const page = await tvhJson(`${base}?start=${middle}&limit=1&sort=start&dir=ASC`);
    const eventStart = Number(page.entries?.[0]?.start) || 0;
    if (eventStart < start) low = middle + 1;
    else high = middle;
  }
  const [scheduled, current] = await Promise.all([
    tvhJson(`${base}?start=${low}&limit=20000&sort=start&dir=ASC`),
    tvhJson(`${base}?mode=now&limit=20000`),
  ]);
  const unique = new Map<string, MediaItem>();
  for (const event of [...(scheduled.entries || []), ...(current.entries || [])]) {
    const eventStart = Number(event.start) || 0;
    const eventStop = Number(event.stop) || 0;
    if (eventStop <= start || eventStart >= end) continue;
    const id = String(event.eventId || `${event.channelUuid || event.channel || ''}:${eventStart}:${eventStop}`);
    unique.set(id, event);
  }
  tvhGuideCache = { key: block, expiresAt: Date.now() + 60_000, start, end, events: [...unique.values()] };
  return tvhGuideCache;
}

function getAllowedMediaPaths() {
  return [path.resolve(MEDIA_ROOT, 'movies'), path.resolve(MEDIA_ROOT, 'tv')];
}

function resolvePlexFile(sourceFile: string) {
  const mappings = JSON.parse(process.env.PLEX_PATH_MAPPINGS || '{}') as Record<string, string>;
  const normalizedSource = path.posix.normalize(sourceFile.replaceAll('\\', '/'));
  let candidate = normalizedSource;
  const mapping = Object.entries(mappings)
    .sort(([a], [b]) => b.length - a.length)
    .find(([from]) => normalizedSource === from || normalizedSource.startsWith(`${from.replace(/\/$/, '')}/`));
  if (mapping) {
    const relative = path.posix.relative(mapping[0], normalizedSource);
    candidate = path.join(mapping[1], ...relative.split('/'));
  }
  const absolute = path.resolve(candidate);
  const allowed = getAllowedMediaPaths();
  if (!allowed.some((base) => absolute === base || absolute.startsWith(`${base}${path.sep}`))) {
    throw Object.assign(new Error('This Plex item is outside the configured movies and TV mounts. Set PLEX_PATH_MAPPINGS to map Plex paths to /media/library/movies or /media/library/tv.'), { status: 409 });
  }
  return absolute;
}

async function itemFile(token: string, ratingKey: string) {
  if (!/^\d{1,20}$/.test(ratingKey)) throw Object.assign(new Error('Invalid Plex media identifier.'), { status: 400 });
  const metadata = await plexJson(token, `/library/metadata/${ratingKey}`);
  const item = metadataRows(metadata)[0];
  const part = item?.Media?.flatMap((media: MediaItem) => media.Part || [])[0];
  if (!part?.file) throw Object.assign(new Error('Plex did not provide a playable media file for this item.'), { status: 404 });
  const filePath = resolvePlexFile(String(part.file));
  let realPath: string;
  try {
    realPath = await fsp.realpath(filePath);
    const stats = await fsp.stat(realPath);
    if (!stats.isFile()) throw new Error('not a file');
  } catch {
    throw Object.assign(new Error('The file path from Plex is not present in the mounted media folders. Check PLEX_PATH_MAPPINGS.'), { status: 404 });
  }
  const allowed = getAllowedMediaPaths();
  if (!allowed.some((base) => realPath === base || realPath.startsWith(`${base}${path.sep}`))) {
    throw Object.assign(new Error('The resolved media path is outside the read-only media mounts.'), { status: 403 });
  }
  return { filePath: realPath, item };
}

async function inspectMedia(filePath: string) {
  try {
    const { stdout } = await execFile('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration:stream=index,codec_type,codec_name:stream_tags=language,title', '-of', 'json', filePath,
    ], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    const probe = JSON.parse(stdout);
    const streams: Array<{ codec_type: string; codec_name: string }> = probe.streams || [];
    const video = streams.find((stream) => stream.codec_type === 'video')?.codec_name;
    const audio = streams.find((stream) => stream.codec_type === 'audio')?.codec_name;
    const extension = path.extname(filePath).toLowerCase();
    const mp4 = ['.mp4', '.m4v', '.mov'].includes(extension) && video === 'h264' && (!audio || ['aac', 'mp3'].includes(audio));
    const webm = extension === '.webm' && ['vp8', 'vp9', 'av1'].includes(video || '') && (!audio || ['opus', 'vorbis'].includes(audio));
    const durationSeconds = Number(probe.format?.duration);
    const subtitles = streams.filter((stream: MediaItem) => stream.codec_type === 'subtitle' && ['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'].includes(stream.codec_name)).map((stream: MediaItem, index: number) => ({
      index: Number(stream.index), label: String(stream.tags?.title || stream.tags?.language || `Subtitle ${index + 1}`), language: String(stream.tags?.language || '').split('-')[0],
    }));
    return { direct: mp4 || webm, durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : undefined, subtitles };
  } catch {
    return { direct: false, durationSeconds: undefined, subtitles: [] };
  }
}

function startHls(owner: string, input: { filePath?: string; liveResponse?: globalThis.Response; durationSeconds?: number }) {
  const id = crypto.randomUUID();
  const directory = path.join(HLS_ROOT, id);
  fs.mkdirSync(directory, { recursive: true });
  const live = Boolean(input.liveResponse);
  if (!live) {
    streamSessions.set(id, {
      directory, owner, process: null, live: false, filePath: input.filePath,
      durationSeconds: input.durationSeconds, createdAt: Date.now(), lastAccess: Date.now(), segmentJobs: new Map(),
    });
    return id;
  }
  // VOD segments are transcoded only when the player asks for them, so timeline seeks are immediately addressable.
  const output = path.join(directory, 'index.m3u8');
  const args = [
    '-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts',
    '-i', input.liveResponse ? 'pipe:0' : String(input.filePath),
    '-map', '0:v:0?', '-map', '0:a:0?', '-sn',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-sc_threshold', '0', '-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-f', 'hls', '-hls_time', String(HLS_SEGMENT_SECONDS),
    '-hls_list_size', '8',
    '-hls_flags', 'delete_segments+append_list+independent_segments',
    '-hls_segment_filename', path.join(directory, 'segment%06d.ts'),
    output,
  ];
  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  child.stderr?.on('data', () => undefined);
  child.on('error', () => undefined);
  if (input.liveResponse?.body) {
    const stream = Readable.fromWeb(input.liveResponse.body as import('node:stream/web').ReadableStream);
    stream.on('error', () => child.kill('SIGTERM'));
    stream.pipe(child.stdin!);
  }
  streamSessions.set(id, { directory, owner, process: child, live, durationSeconds: input.durationSeconds, createdAt: Date.now(), lastAccess: Date.now(), segmentJobs: new Map() });
  return id;
}

async function generateVodSegment(stream: StreamSession, index: number) {
  if (stream.closed) throw Object.assign(new Error('Playback session closed.'), { status: 404 });
  if (!stream.filePath || !stream.durationSeconds) throw new Error('VOD source metadata is missing.');
  const offset = index * HLS_SEGMENT_SECONDS;
  const duration = Math.min(HLS_SEGMENT_SECONDS, stream.durationSeconds - offset);
  if (duration <= 0) throw Object.assign(new Error('The requested media segment is outside the video.'), { status: 404 });
  const finalPath = path.join(stream.directory, `segment${String(index).padStart(6, '0')}.ts`);
  if (fs.existsSync(finalPath)) return;
  const tempPath = `${finalPath}.${crypto.randomUUID()}.tmp`;
  try {
    await execFile('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-ss', String(offset), '-i', stream.filePath, '-t', String(duration),
      '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
      '-pix_fmt', 'yuv420p', '-sc_threshold', '0', '-force_key_frames', `expr:gte(t,${offset}+n_forced*${HLS_SEGMENT_SECONDS})`,
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-output_ts_offset', String(offset),
      '-mpegts_flags', '+resend_headers', '-f', 'mpegts', tempPath,
    ], { timeout: 180_000, maxBuffer: 1024 * 1024 });
    if (stream.closed) throw Object.assign(new Error('Playback session closed.'), { status: 404 });
    await fsp.rename(tempPath, finalPath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true });
    throw error;
  }
}

function vodPlaylist(streamId: string, durationSeconds: number) {
  const segmentCount = Math.ceil(durationSeconds / HLS_SEGMENT_SECONDS);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${HLS_SEGMENT_SECONDS + 1}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  for (let index = 0; index < segmentCount; index++) {
    const segmentDuration = Math.min(HLS_SEGMENT_SECONDS, durationSeconds - index * HLS_SEGMENT_SECONDS);
    lines.push(`#EXTINF:${segmentDuration.toFixed(3)},`, `segment${String(index).padStart(6, '0')}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

function closeStream(id: string) {
  const stream = streamSessions.get(id);
  if (!stream) return;
  stream.closed = true;
  streamSessions.delete(id);
  stream.process?.kill('SIGTERM');
  setTimeout(() => {
    stream.process?.kill('SIGKILL');
    void Promise.allSettled([...stream.segmentJobs.values()]).then(() => fsp.rm(stream.directory, { recursive: true, force: true })).catch(() => {});
  }, 2_000).unref();
}

setInterval(() => {
  const now = Date.now();
  for (const [id, stream] of streamSessions) {
    if (now - stream.lastAccess > 15 * 60_000 || now - stream.createdAt > 4 * 60 * 60_000) closeStream(id);
  }
}, 60_000).unref();

app.get('/api/status', asyncRoute(async (_req, res) => {
  const plexConfigured = Boolean(PLEX_URL && PLEX_MACHINE_ID);
  let plexReachable = false;
  let tvhReachable = false;
  if (plexConfigured) {
    try {
      const response = await fetch(new URL('/identity', plexServerUrl()), { signal: AbortSignal.timeout(2500) });
      plexReachable = response.ok;
    } catch { /* readiness below reports the connection state */ }
  }
  try {
    const response = await fetch(tvhUrl('api/channel/grid?limit=1'), { headers: tvhHeaders(), signal: AbortSignal.timeout(2500) });
    // A 401 or 403 proves the server is reachable, even when the account lacks access.
    tvhReachable = response.ok || response.status === 401 || response.status === 403;
  } catch { /* readiness below reports network connectivity */ }
  res.json({
    siteName: SITE_NAME,
    plex: { configured: plexConfigured, reachable: plexReachable, machineId: PLEX_MACHINE_ID || null },
    tvheadend: { configured: Boolean(TVH_URL), reachable: tvhReachable },
    seerr: { configured: seerrConfigured() },
    navidrome: { configured: navidromeConfigured() },
    authenticated: Boolean(plexState(_req).plexToken),
    user: plexState(_req).plexUser?.username || plexState(_req).plexUser?.title || null,
  });
}));

registerCasting(app, { auth: requirePlex, wrap: asyncRoute, state: plexState, validYoutubeMedia: (owner, url) => {
  const token = url.match(/^\/api\/youtube\/media\/([A-Za-z0-9_-]+)$/)?.[1];
  return Boolean(token && youtubeMediaUrls.get(token)?.owner === owner);
}, validate: async (req, url) => {
  const stream = url.match(/^\/api\/streams\/([A-Za-z0-9_-]+)\//)?.[1];
  if (stream) { if (streamSessions.get(stream)?.owner !== req.sessionID) throw Object.assign(new Error('Playback session expired.'), { status: 403 }); return; }
  const key = url.match(/^\/api\/plex\/(?:media|subtitles)\/(\d+)\//)?.[1];
  if (key) { await itemFile(plexState(req).plexToken!, key); return; }
  const token = url.match(/^\/api\/youtube\/media\/([A-Za-z0-9_-]+)$/)?.[1];
  if (token && youtubeMediaUrls.get(token)?.owner !== req.sessionID) throw Object.assign(new Error('YouTube playback expired.'), { status: 403 });
} });

app.get('/api/music/albums', requirePlex, asyncRoute(async (req, res) => {
  const start = Math.max(0, Math.floor(Number(req.query.start) || 0));
  const size = 100;
  const result = await navidromeJson('getAlbumList2', { type: 'alphabeticalByName', size: String(size + 1), offset: String(start) });
  const albums = result.albumList2?.album || [];
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ albums: albums.slice(0, size).map(safeMusicAlbum), start, nextStart: start + Math.min(size, albums.length), hasMore: albums.length > size });
}));

app.get('/api/music/search', requirePlex, asyncRoute(async (req, res) => {
  const query = String(req.query.query || '').trim();
  if (query.length < 2 || query.length > 120) throw Object.assign(new Error('Search for at least 2 characters.'), { status: 400 });
  const result = await navidromeJson('search3', { query, songCount: '50', albumCount: '30', artistCount: '0' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ albums: (result.searchResult3?.album || []).map(safeMusicAlbum), tracks: (result.searchResult3?.song || []).map(safeMusicTrack) });
}));

app.get('/api/music/album/:albumId', requirePlex, asyncRoute(async (req, res) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(req.params.albumId)) throw Object.assign(new Error('Invalid album identifier.'), { status: 400 });
  const result = await navidromeJson('getAlbum', { id: req.params.albumId });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ tracks: (result.album?.song || []).map(safeMusicTrack) });
}));

app.get('/api/music/lyrics/:trackId', requirePlex, asyncRoute(async (req, res) => {
  const id = req.params.trackId;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw Object.assign(new Error('Invalid track identifier.'), { status: 400 });
  if (!GENIUS_ACCESS_TOKEN) throw Object.assign(new Error('Genius is not configured.'), { status: 503 });
  res.setHeader('Cache-Control', 'private, no-store');
  const cached = geniusCache.get(id);
  if (cached && cached.expires > Date.now()) { res.json({ songs: cached.songs }); return; }
  const result = await navidromeJson('getSong', { id });
  const track = result.song;
  if (!track?.title) throw Object.assign(new Error('Track not found.'), { status: 404 });
  const query = `${track.title} ${track.artist || ''}`.slice(0, 250);
  const response = await fetch(`https://api.genius.com/search?q=${encodeURIComponent(query)}`, { headers: { Authorization: `Bearer ${GENIUS_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw Object.assign(new Error(response.status === 429 ? 'Genius is busy. Try again shortly.' : 'Could not load lyrics from Genius.'), { status: 502 });
  const data = await response.json() as any;
  const normalize = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]/gu, '').trim();
  const songs = (data.response?.hits || []).filter((hit: any) => hit.type === 'song').map((hit: any) => hit.result).filter((song: any) => Number.isSafeInteger(song.id) && song.id > 0 && /^https:\/\/genius\.com\/[A-Za-z0-9_%.-]+$/.test(song.url || '')).sort((a: any, b: any) => {
    const score = (song: any) => Number(normalize(song.title || '') === normalize(track.title)) * 2 + Number(normalize(song.primary_artist?.name || '') === normalize(track.artist || ''));
    return score(b) - score(a);
  }).slice(0, 5).map((song: any) => ({ id: song.id, title: String(song.title), artist: String(song.primary_artist?.name || ''), url: song.url }));
  if (geniusCache.size >= 500) geniusCache.delete(geniusCache.keys().next().value!);
  geniusCache.set(id, { expires: Date.now() + (songs.length ? 3_600_000 : 60_000), songs });
  res.json({ songs });
}));

app.get('/api/music/cover/:coverArtId', requirePlex, asyncRoute(async (req, res) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(req.params.coverArtId)) throw Object.assign(new Error('Invalid cover identifier.'), { status: 400 });
  const endpoint = navidromeEndpoint('getCoverArt', { id: req.params.coverArtId, size: '500' });
  const response = await fetch(new URL(endpoint.pathname + endpoint.search, NAVIDROME_URL), { signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body) { res.status(404).end(); return; }
  res.setHeader('Content-Type', response.headers.get('content-type') || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res);
}));

app.get('/api/music/stream/:trackId', requirePlex, asyncRoute(async (req, res) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(req.params.trackId)) throw Object.assign(new Error('Invalid track identifier.'), { status: 400 });
  const endpoint = navidromeEndpoint('stream', { id: req.params.trackId });
  const url = new URL(endpoint.pathname + endpoint.search, NAVIDROME_URL);
  const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw Object.assign(new Error(`Navidrome could not open this track (HTTP ${response.status}).`), { status: 502 });
  res.json({ url: `/api/music/media/${encodeURIComponent(req.params.trackId)}`, contentType: response.headers.get('content-type') || 'audio/mpeg' });
}));

app.get('/api/music/media/:trackId', requirePlex, asyncRoute(async (req, res) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(req.params.trackId)) throw Object.assign(new Error('Invalid track identifier.'), { status: 400 });
  const endpoint = navidromeEndpoint('stream', { id: req.params.trackId });
  const headers = new Headers();
  const range = req.get('range');
  if (range) headers.set('Range', range);
  const upstream = await fetch(new URL(endpoint.pathname + endpoint.search, NAVIDROME_URL), { headers, signal: AbortSignal.timeout(120_000) });
  if (!upstream.ok && upstream.status !== 206) throw Object.assign(new Error(`Navidrome could not stream this track (HTTP ${upstream.status}).`), { status: 502 });
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(upstream.status);
  if (!upstream.body) { res.end(); return; }
  await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), res);
}));

app.get('/api/seerr/search', requirePlex, asyncRoute(async (req, res) => {
  const query = String(req.query.query || '').trim();
  const mediaType = String(req.query.type || 'tv');
  if (query.length < 2 || query.length > 120) throw Object.assign(new Error('Search for at least 2 characters.'), { status: 400 });
  if (mediaType !== 'tv' && mediaType !== 'movie') throw Object.assign(new Error('Search type must be tv or movie.'), { status: 400 });
  const response = await seerrFetch(`search?query=${encodeURIComponent(query)}&page=1`);
  const payload = await response.json() as { results?: MediaItem[] };
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ results: (payload.results || []).filter((item) => item.mediaType === mediaType).map((item) => ({
    id: Number(item.id), mediaType, title: item.name || item.title || (mediaType === 'tv' ? 'Untitled series' : 'Untitled movie'),
    year: String(item.firstAirDate || item.releaseDate || '').slice(0, 4) || null,
    overview: item.overview || '', posterPath: item.posterPath || null,
    status: item.mediaInfo?.status || null,
    requestStatus: item.mediaInfo?.requests?.find((entry: MediaItem) => !entry.is4k && [1, 2].includes(entry.status))?.status || null,
  })) });
}));

app.get('/api/seerr/tv/:tvId', requirePlex, asyncRoute(async (req, res) => {
  if (!/^\d{1,12}$/.test(req.params.tvId)) throw Object.assign(new Error('Invalid Seerr series identifier.'), { status: 400 });
  const payload = await (await seerrFetch(`tv/${req.params.tvId}?language=en`)).json() as MediaItem;
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    id: Number(payload.id), title: payload.name || payload.title || 'Untitled series', overview: payload.overview || '',
    posterPath: payload.posterPath || null, backdropPath: payload.backdropPath || null,
    requestedSeasons: requestedSeasons(payload.mediaInfo),
    firstAirDate: payload.firstAirDate || '', seasons: (payload.seasons || []).map((season: MediaItem) => ({
      seasonNumber: Number(season.seasonNumber), name: season.name || `Season ${season.seasonNumber}`,
      episodeCount: Number(season.episodeCount) || 0, overview: season.overview || '',
      posterPath: season.posterPath || null, airDate: season.airDate || null,
    })),
  });
}));

app.get('/api/seerr/tv/:tvId/season/:seasonNumber', requirePlex, asyncRoute(async (req, res) => {
  if (!/^\d{1,12}$/.test(req.params.tvId) || !/^\d{1,3}$/.test(req.params.seasonNumber)) throw Object.assign(new Error('Invalid Seerr season.'), { status: 400 });
  const payload = await (await seerrFetch(`tv/${req.params.tvId}/season/${req.params.seasonNumber}?language=en`)).json() as MediaItem;
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    seasonNumber: Number(payload.seasonNumber), name: payload.name || `Season ${req.params.seasonNumber}`,
    episodes: (payload.episodes || []).map((episode: MediaItem) => ({
      episodeNumber: Number(episode.episodeNumber), title: episode.name || episode.title || 'Untitled episode',
      overview: episode.overview || '', airDate: episode.airDate || '', runtime: Number(episode.runtime) || null,
    })),
  });
}));

app.post('/api/seerr/tv/:tvId/season/:seasonNumber/episode/:episodeNumber/request', requirePlex, asyncRoute(async (req, res) => {
  const { tvId, seasonNumber, episodeNumber } = req.params;
  if (!/^\d{1,12}$/.test(tvId) || !/^\d{1,3}$/.test(seasonNumber) || !/^\d{1,3}$/.test(episodeNumber) || Number(episodeNumber) < 1) {
    throw Object.assign(new Error('Invalid series, season, or episode.'), { status: 400 });
  }

  const series = await (await seerrFetch(`tv/${tvId}?language=en`)).json() as MediaItem;
  const tvdbId = Number(series.externalIds?.tvdbId || series.tvdbId);
  if (!Number.isSafeInteger(tvdbId) || tvdbId <= 0) throw Object.assign(new Error('Seerr did not provide a TVDB id for this series.'), { status: 422 });

  const sonarrPayload = await (await seerrFetch('settings/sonarr')).json() as MediaItem[] | { results?: MediaItem[] };
  const instances = Array.isArray(sonarrPayload) ? sonarrPayload : sonarrPayload.results || [];
  const sonarr = instances.find((instance) => instance.isDefault && instance.isActive !== false) || instances.find((instance) => instance.isActive !== false);
  if (!sonarr || !sonarr.hostname || !sonarr.apiKey) throw Object.assign(new Error('No active Sonarr instance is configured in Seerr.'), { status: 503 });
  const sonarrInstance = sonarr;

  let sonarrBase: URL;
  try {
    const configuredHost = String(sonarrInstance.hostname);
    const protocol = sonarrInstance.useSsl ? 'https:' : 'http:';
    const host = configuredHost.includes('://') ? new URL(configuredHost) : new URL(`${protocol}//${configuredHost}`);
    if (sonarrInstance.port) host.port = String(sonarrInstance.port);
    const basePath = String(sonarrInstance.baseUrl || '').replace(/^\/+|\/+$/g, '');
    sonarrBase = new URL(`${basePath ? `${basePath}/` : ''}api/v3/`, host.href.endsWith('/') ? host : `${host.href}/`);
  } catch {
    throw Object.assign(new Error('The Sonarr connection configured in Seerr is invalid.'), { status: 502 });
  }

  async function sonarrRequest(resource: string, init: RequestInit = {}) {
    const response = await fetch(new URL(resource.replace(/^\/+/, ''), sonarrBase), {
      ...init,
      headers: { Accept: 'application/json', 'X-Api-Key': String(sonarrInstance.apiKey), ...(init.headers as Record<string, string> | undefined) },
      signal: init.signal || AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw Object.assign(new Error(`Sonarr returned HTTP ${response.status}.`), { status: 502 });
    return response;
  }

  const sonarrSeries = await (await sonarrRequest(`series?tvdbId=${tvdbId}`)).json() as MediaItem[];
  const matchedSeries = sonarrSeries.find((entry) => Number(entry.tvdbId) === tvdbId);
  if (!matchedSeries?.id) throw Object.assign(new Error('This series is not in Sonarr yet. Request the season through Seerr first.'), { status: 409 });

  const episodeList = await (await sonarrRequest(`episode?seriesId=${encodeURIComponent(String(matchedSeries.id))}`)).json() as MediaItem[];
  const episode = episodeList.find((entry) => Number(entry.seasonNumber) === Number(seasonNumber) && Number(entry.episodeNumber) === Number(episodeNumber));
  if (!episode?.id) throw Object.assign(new Error('Sonarr does not list that episode for this series.'), { status: 404 });
  if (episode.hasFile) throw Object.assign(new Error('Sonarr already has this episode.'), { status: 409 });

  await sonarrRequest('episode/monitor', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episodeIds: [episode.id], monitored: true }),
  });
  await sonarrRequest('command', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'EpisodeSearch', episodeIds: [episode.id] }),
  });
  res.json({ requested: true });
}));

app.post('/api/seerr/request', requirePlex, asyncRoute(async (req, res) => {
  const mediaId = Number(req.body?.mediaId);
  const mediaType = req.body?.mediaType || 'tv';
  if (!Number.isSafeInteger(mediaId) || mediaId <= 0 || !['tv', 'movie'].includes(mediaType)) throw Object.assign(new Error('Invalid Seerr media request.'), { status: 400 });
  let seasons: 'all' | number[] = 'all';
  if (mediaType === 'tv' && req.body?.seasons !== undefined) {
    if (req.body.seasons === 'all') seasons = 'all';
    else if (Array.isArray(req.body.seasons) && req.body.seasons.length > 0 && req.body.seasons.length <= 100 && req.body.seasons.every((season: unknown) => Number.isInteger(season) && Number(season) >= 0)) seasons = [...new Set(req.body.seasons as number[])];
    else throw Object.assign(new Error('Select one or more valid seasons.'), { status: 400 });
  }
  const response = await seerrFetch('request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mediaType === 'tv' ? { mediaType, mediaId, seasons } : { mediaType, mediaId }),
  });
  const created = await response.json() as MediaItem;
  if (!created.id) throw Object.assign(new Error(created.message || 'Seerr did not create a request. Check existing requests for this title.'), { status: 409 });
  res.status(response.status).json({ requested: true });
}));

app.get('/api/youtube/search', requirePlex, asyncRoute(async (req, res) => {
  const query = String(req.query.query || '').trim();
  if (query.length < 2 || query.length > 120) throw Object.assign(new Error('Search for at least 2 characters.'), { status: 400 });
  const rows = await invidiousJson(`search?q=${encodeURIComponent(query)}&type=video&hl=en-US`);
  res.setHeader('Cache-Control', 'private, no-store');
  const videos = Array.isArray(rows) ? rows : rows.videos || rows.results || [];
  res.json({ results: safeYouTubeRows(videos).slice(0, 30) });
}));

function safeYouTubeRows(rows: MediaItem[]) {
  return rows.filter((item) => (!item.type || item.type === 'video') && /^[A-Za-z0-9_-]{11}$/.test(String(item.videoId || ''))).map((item) => ({
    id: item.videoId, title: item.title || 'Untitled video', author: item.author || '', authorId: item.authorId || null,
    durationSeconds: Number(item.lengthSeconds) || 0,
    thumbnail: item.videoThumbnails?.find((thumbnail: MediaItem) => thumbnail.quality === 'high')?.url || item.videoThumbnails?.[0]?.url || null,
    publishedText: item.publishedText || '', published: Number(item.published) || 0, viewCountText: item.viewCountText || '',
  }));
}

function registerYouTubeMedia(owner: string, rawUrl: string) {
  const instance = new URL(INVIDIOUS_URL);
  const url = new URL(rawUrl, `${instance}/`);
  const googleVideo = url.hostname.endsWith('.googlevideo.com');
  const invidious = url.host === instance.host && url.pathname.includes('videoplayback');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (!googleVideo && !invidious)) {
    throw Object.assign(new Error('Invidious returned an invalid media stream address.'), { status: 502 });
  }
  for (const [token, entry] of youtubeMediaUrls) if (entry.expiresAt <= Date.now()) youtubeMediaUrls.delete(token);
  const token = crypto.randomUUID();
  youtubeMediaUrls.set(token, { owner, url: url.href, expiresAt: Date.now() + 3 * 60 * 60 * 1000 });
  return `/api/youtube/media/${token}`;
}

function invidiousDashUrl(video: MediaItem, videoId: string) {
  const instance = new URL(INVIDIOUS_URL);
  try {
    const candidate = new URL(String(video.dashUrl || ''), `${instance}/`);
    if (candidate.protocol === 'https:' && candidate.host === instance.host && candidate.pathname.includes(`/api/manifest/dash/id/${videoId}`)) return candidate;
  } catch { /* no DASH manifest available */ }
  return null;
}

app.get('/api/youtube/video/:videoId', requirePlex, asyncRoute(async (req, res) => {
  const videoId = req.params.videoId;
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw Object.assign(new Error('Invalid video identifier.'), { status: 400 });
  const video = await invidiousJson(`videos/${encodeURIComponent(videoId)}?local=true&hl=en-US`);
  const instance = new URL(INVIDIOUS_URL);
  const dashUrl = invidiousDashUrl(video, videoId);
  const formats = (video.formatStreams || [])
    .filter((format: MediaItem) => String(format.type || '').toLowerCase().startsWith('video/mp4') && typeof format.url === 'string')
    .filter((format: MediaItem) => {
      try { const url = new URL(format.url); return url.protocol === 'https:' && (url.host === instance.host || url.hostname.endsWith('.googlevideo.com')); } catch { return false; }
    })
    .sort((a: MediaItem, b: MediaItem) => (Number.parseInt(b.qualityLabel || '0', 10) || 0) - (Number.parseInt(a.qualityLabel || '0', 10) || 0));
  if (!dashUrl && !formats.length) throw Object.assign(new Error('Invidious did not return a playable stream for this video.'), { status: 502 });
  const captions = (video.captions || []).flatMap((caption: MediaItem, index: number) => {
    try {
      const captionUrl = new URL(String(caption.url || ''), `${instance}/`);
      if (captionUrl.protocol !== 'https:' || captionUrl.host !== instance.host || !captionUrl.pathname.startsWith('/api/v1/captions/')) return [];
      return [{ label: String(caption.label || caption.language_code || `Subtitle ${index + 1}`), language: String(caption.language_code || '').split('-')[0], src: `/api/youtube/captions/${videoId}/${index}` }];
    } catch { return []; }
  });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    id: videoId, title: video.title || 'YouTube video', author: video.author || '', authorId: video.authorId || null,
    description: video.description || '', durationSeconds: Number(video.lengthSeconds) || undefined,
    streamUrl: dashUrl ? `/api/youtube/manifest/${videoId}` : registerYouTubeMedia(req.sessionID, formats[0].url), mode: dashUrl ? 'dash' : 'direct', contentType: dashUrl ? 'application/dash+xml' : 'video/mp4', captions,
    related: safeYouTubeRows(video.recommendedVideos || []).slice(0, 24),
  });
}));

app.get('/api/youtube/manifest/:videoId', requirePlex, asyncRoute(async (req, res) => {
  const videoId = req.params.videoId;
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw Object.assign(new Error('Invalid video identifier.'), { status: 400 });
  const video = await invidiousJson(`videos/${encodeURIComponent(videoId)}?local=true&hl=en-US`);
  const manifestUrl = invidiousDashUrl(video, videoId);
  if (!manifestUrl) throw Object.assign(new Error('Invidious no longer has a DASH manifest for this video.'), { status: 404 });
  const upstream = await fetch(manifestUrl, { signal: AbortSignal.timeout(30_000) });
  if (!upstream.ok) throw Object.assign(new Error(`Invidious returned HTTP ${upstream.status} for the DASH manifest.`), { status: 502 });
  const instance = new URL(INVIDIOUS_URL);
  if (new URL(upstream.url).host !== instance.host) throw Object.assign(new Error('Invidious redirected the DASH manifest to an untrusted host.'), { status: 502 });
  let manifest = await upstream.text();
  let replacements = 0;
  manifest = manifest.replace(/(<BaseURL(?:\s[^>]*)?>)([\s\S]*?)(<\/BaseURL>)/gi, (_match, open: string, raw: string, close: string) => {
    const originalUrl = raw.trim().replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const proxyPath = registerYouTubeMedia(mediaOwner(req), originalUrl);
    replacements++;
    return `${open}${proxyPath}${close}`;
  });
  if (!replacements) throw Object.assign(new Error('The DASH manifest did not contain any playable media streams.'), { status: 502 });
  res.setHeader('Content-Type', 'application/dash+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(manifest);
}));

app.get('/api/youtube/media/:mediaToken', requirePlex, asyncRoute(async (req, res) => {
  const entry = youtubeMediaUrls.get(req.params.mediaToken);
  if (!entry || entry.expiresAt <= Date.now() || entry.owner !== mediaOwner(req)) {
    if (entry && entry.expiresAt <= Date.now()) youtubeMediaUrls.delete(req.params.mediaToken);
    throw Object.assign(new Error('That YouTube media stream expired. Reload the video.'), { status: 404 });
  }
  const url = new URL(entry.url);
  const headers = new Headers();
  for (const header of ['range', 'if-range']) {
    const value = req.get(header);
    if (value) headers.set(header, value);
  }
  const upstream = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
  if (!upstream.ok && upstream.status !== 206) throw Object.assign(new Error(`The YouTube media source returned HTTP ${upstream.status}.`), { status: 502 });
  for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.status(upstream.status);
  if (!upstream.body) { res.end(); return; }
  try { await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), res); }
  catch (error) { if (!res.destroyed) res.destroy(error as Error); }
}));

app.get('/api/youtube/captions/:videoId/:captionIndex', requirePlex, asyncRoute(async (req, res) => {
  const videoId = req.params.videoId;
  const captionIndex = Number(req.params.captionIndex);
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !Number.isSafeInteger(captionIndex) || captionIndex < 0 || captionIndex > 100) throw Object.assign(new Error('Invalid YouTube caption track.'), { status: 400 });
  const video = await invidiousJson(`videos/${encodeURIComponent(videoId)}?local=true&hl=en-US`);
  const caption = (video.captions || [])[captionIndex];
  if (!caption?.url) throw Object.assign(new Error('That caption track is unavailable.'), { status: 404 });
  const instance = new URL(INVIDIOUS_URL);
  const captionUrl = new URL(String(caption.url), `${instance}/`);
  if (captionUrl.protocol !== 'https:' || captionUrl.host !== instance.host || !captionUrl.pathname.startsWith('/api/v1/captions/')) throw Object.assign(new Error('Invalid Invidious caption URL.'), { status: 502 });
  const response = await fetch(captionUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw Object.assign(new Error(`Invidious captions returned HTTP ${response.status}.`), { status: 502 });
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(await response.text());
}));

app.get('/api/youtube/channel/:channelId', requirePlex, asyncRoute(async (req, res) => {
  const channelId = req.params.channelId;
  if (!/^[A-Za-z0-9_-]{24}$/.test(channelId)) throw Object.assign(new Error('Invalid channel identifier.'), { status: 400 });
  const payload = await invidiousJson(`channels/${encodeURIComponent(channelId)}/videos?page=1&sort_by=newest&hl=en-US`);
  res.setHeader('Cache-Control', 'private, no-store');
  const rows = Array.isArray(payload) ? payload : payload.videos || payload.results || [];
  res.json({ results: safeYouTubeRows(rows).slice(0, 30) });
}));

app.get('/api/youtube/comments/:videoId', requirePlex, asyncRoute(async (req, res) => {
  const videoId = req.params.videoId;
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw Object.assign(new Error('Invalid video identifier.'), { status: 400 });
  const continuation = typeof req.query.continuation === 'string' ? req.query.continuation : '';
  if (continuation.length > 16000) throw Object.assign(new Error('Invalid comment continuation.'), { status: 400 });
  const params = new URLSearchParams({ source: 'youtube', hl: 'en-US' });
  if (continuation) params.set('continuation', continuation);
  const payload = await invidiousJson(`comments/${encodeURIComponent(videoId)}?${params}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ count: Number(payload.commentCount) || 0, continuation: payload.continuation || null, comments: (payload.comments || []).map((item: MediaItem) => ({
    id: String(item.commentId || ''), author: item.author || 'YouTube user', authorThumbnail: item.authorThumbnail || item.authorThumbnails?.[0]?.url || null,
    publishedText: item.publishedText || '', likeCount: Number(item.likeCount) || 0,
    content: item.content || '', replies: Number(item.replies?.replyCount) || 0, replyContinuation: item.replies?.continuation || null,
  })) });
}));

app.post('/api/auth/plex/pin', asyncRoute(async (req, res) => {
  const pinUrl = new URL('https://plex.tv/api/v2/pins');
  pinUrl.searchParams.set('strong', 'true');
  const response = await fetch(pinUrl, {
    method: 'POST',
    headers: {
      ...Object.fromEntries(Object.entries(plexHeaders()) as Array<[string, string]>),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ strong: 'true' }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw Object.assign(new Error(`Plex sign-in could not start (HTTP ${response.status}).`), { status: 502 });
  const pin = await response.json() as { id: number; code: string; expiresIn?: number };
  if (!pin.id || !pin.code) throw Object.assign(new Error('Plex returned an incomplete sign-in code.'), { status: 502 });
  plexState(req).plexPin = { id: pin.id, code: pin.code, expiresAt: Date.now() + (pin.expiresIn || 600) * 1000 };
  const authUrl = new URL('https://app.plex.tv/auth');
  const hash = new URLSearchParams();
  hash.set('clientID', CLIENT_ID);
  hash.set('code', pin.code);
  // Plex expects nested query fields, not a JSON-encoded `context` string.
  hash.set('context[device][product]', PRODUCT);
  hash.set('context[device][version]', VERSION);
  hash.set('context[device][platform]', 'Web');
  hash.set('context[device][device]', 'Browser');
  res.json({ code: pin.code, authUrl: `${authUrl.toString()}#?${hash.toString()}`, expiresIn: pin.expiresIn || 600 });
}));

app.get('/api/auth/plex/poll', asyncRoute(async (req, res) => {
  const state = plexState(req);
  const pinState = state.plexPin;
  if (!pinState || Date.now() > pinState.expiresAt) {
    state.plexPin = undefined;
    res.status(410).json({ error: 'That Plex sign-in code expired. Start again.' });
    return;
  }
  const pollUrl = new URL(`https://plex.tv/api/v2/pins/${pinState.id}`);
  pollUrl.searchParams.set('code', pinState.code);
  const pinResponse = await fetch(pollUrl, { headers: plexHeaders(), signal: AbortSignal.timeout(10_000) });
  if (!pinResponse.ok) throw Object.assign(new Error(`Plex sign-in check failed (HTTP ${pinResponse.status}).`), { status: 502 });
  const pin = await pinResponse.json() as { authToken?: string };
  if (!pin.authToken) {
    res.json({ authenticated: false });
    return;
  }
  // Plex PINs can be approved for a different logged-in account in the same browser.
  // Only continue after verifying that the session cookie is still present.
  const accountResponse = await fetch('https://plex.tv/api/v2/user', { headers: plexHeaders(pin.authToken), signal: AbortSignal.timeout(15_000) });
  if (!accountResponse.ok) throw Object.assign(new Error('Plex accepted the code but did not return the account.'), { status: 502 });
  const account = await accountResponse.json() as { id?: number; username?: string; title?: string; email?: string };
  const resourceResponse = await fetch('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=0', { headers: plexHeaders(pin.authToken), signal: AbortSignal.timeout(15_000) });
  if (!resourceResponse.ok) throw Object.assign(new Error('Could not verify access to your Plex server.'), { status: 502 });
  const resources = await resourceResponse.json() as Array<Record<string, any>>;
  const server = resources.find((resource) => {
    const provides = Array.isArray(resource.provides) ? resource.provides : String(resource.provides || '').split(',');
    return provides.includes('server') &&
      (resource.clientIdentifier === PLEX_MACHINE_ID || resource.machineIdentifier === PLEX_MACHINE_ID);
  });
  if (!server) {
    state.plexPin = undefined;
    res.status(403).json({ error: 'Signed in to Plex, but this account cannot access the configured Plex server. Sign out of Plex in the approval tab and retry with the server owner account.' });
    return;
  }
  const serverToken = String(server.accessToken || pin.authToken);
  const identity = await plexFetch(serverToken, '/identity');
  const identityPayload = await identity.json() as Record<string, any>;
  const identityContainer = mediaContainer(identityPayload);
  if (String(identityContainer.machineIdentifier || '') !== PLEX_MACHINE_ID) {
    res.status(403).json({ error: 'Plex server identity did not match the configured server.' });
    return;
  }
  state.plexToken = serverToken;
  state.plexUser = { id: account.id, username: account.username, title: account.title, email: account.email };
  state.plexPin = undefined;
  res.json({ authenticated: true, user: account.username || account.title || 'Plex user' });
}));

app.get('/api/auth/me', (req, res) => {
  const state = plexState(req);
  res.json({ authenticated: Boolean(state.plexToken), user: state.plexUser?.username || state.plexUser?.title || null });
});

app.get('/api/profile', requirePlex, asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(await readUserProfile(req));
}));

app.patch('/api/profile', requirePlex, asyncRoute(async (req, res) => {
  await updateUserProfile(req, async (profile) => {
  if (req.body?.subscriptionAdd !== undefined || req.body?.subscriptionRemove !== undefined) {
    profile.subscriptions = changeSubscription(profile.subscriptions, req.body);
  }
  if (req.body?.subscriptions !== undefined) {
    if (!Array.isArray(req.body.subscriptions) || req.body.subscriptions.length > 30 || req.body.subscriptions.some((entry: MediaItem) => typeof entry?.id !== 'string' || entry.id.length > 200 || typeof entry.name !== 'string' || entry.name.length > 120)) {
      throw Object.assign(new Error('Invalid YouTube subscriptions.'), { status: 400 });
    }
    profile.subscriptions = [...new Map<string, { id: string; name: string }>(req.body.subscriptions.map((entry: MediaItem) => [String(entry.id), { id: String(entry.id), name: String(entry.name) }])).values()];
  }
  if (req.body?.watchlist !== undefined) {
    if (!Array.isArray(req.body.watchlist) || req.body.watchlist.length > 300 || req.body.watchlist.some((entry: MediaItem) => !/^[A-Za-z0-9_-]{11}$/.test(String(entry?.id || '')) || typeof entry.title !== 'string' || entry.title.length > 500)) {
      throw Object.assign(new Error('Invalid YouTube watchlist.'), { status: 400 });
    }
    profile.watchlist = [...new Map<string, UserProfile['watchlist'][number]>(req.body.watchlist.map((entry: MediaItem) => [String(entry.id), {
      id: String(entry.id), title: entry.title.slice(0, 500), author: String(entry.author || '').slice(0, 200), authorId: typeof entry.authorId === 'string' ? entry.authorId.slice(0, 200) : null,
      durationSeconds: Math.min(86_400, Math.max(0, Number(entry.durationSeconds) || 0)), thumbnail: typeof entry.thumbnail === 'string' ? entry.thumbnail.slice(0, 2000) : null,
      publishedText: String(entry.publishedText || '').slice(0, 120), published: Math.max(0, Number(entry.published) || 0), viewCountText: String(entry.viewCountText || '').slice(0, 120),
    }])).values()];
  }
  if (req.body?.watchlistRemove !== undefined) {
    if (typeof req.body.watchlistRemove !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(req.body.watchlistRemove)) throw Object.assign(new Error('Invalid watchlist video.'), { status: 400 });
    profile.watchlist = profile.watchlist.filter((entry) => entry.id !== req.body.watchlistRemove);
  }
  if (req.body?.watchlistAdd !== undefined) {
    const entry = req.body.watchlistAdd;
    if (!entry || !/^[A-Za-z0-9_-]{11}$/.test(String(entry.id || '')) || typeof entry.title !== 'string' || entry.title.length > 500) throw Object.assign(new Error('Invalid watchlist video.'), { status: 400 });
    if (profile.watchlist.length >= 300 && !profile.watchlist.some((video) => video.id === entry.id)) throw Object.assign(new Error('Your watchlist is full (300 videos).'), { status: 409 });
    profile.watchlist = [...profile.watchlist.filter((video) => video.id !== entry.id), {
      id: entry.id, title: entry.title, author: String(entry.author || '').slice(0, 200), authorId: typeof entry.authorId === 'string' ? entry.authorId.slice(0, 200) : null,
      durationSeconds: Math.min(86_400, Math.max(0, Number(entry.durationSeconds) || 0)), thumbnail: typeof entry.thumbnail === 'string' ? entry.thumbnail.slice(0, 2000) : null,
      publishedText: String(entry.publishedText || '').slice(0, 120), published: Math.max(0, Number(entry.published) || 0), viewCountText: String(entry.viewCountText || '').slice(0, 120),
    }];
  }
  if (req.body?.watchedVideoIds !== undefined) {
    if (!Array.isArray(req.body.watchedVideoIds) || req.body.watchedVideoIds.length > 2000 || req.body.watchedVideoIds.some((id: unknown) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(id))) {
      throw Object.assign(new Error('Invalid YouTube watch history.'), { status: 400 });
    }
    profile.watchedVideoIds = [...new Set<string>([...profile.watchedVideoIds, ...req.body.watchedVideoIds as string[]])].slice(-2000);
  }
  });
  res.json({ saved: true });
}));

app.put('/api/profile/progress/:ratingKey', requirePlex, asyncRoute(async (req, res) => {
  if (!/^\d{1,20}$/.test(req.params.ratingKey)) throw Object.assign(new Error('Invalid Plex media identifier.'), { status: 400 });
  const seconds = Math.max(0, Number(req.body?.seconds) || 0);
  const duration = Math.max(0, Number(req.body?.duration) || 0);
  if (!Number.isFinite(seconds) || !Number.isFinite(duration) || seconds > 86_400 || duration > 86_400) throw Object.assign(new Error('Invalid playback position.'), { status: 400 });
  await updateUserProfile(req, async (profile) => {
  profile.mediaProgress[req.params.ratingKey] = { seconds: duration > 0 && seconds / duration >= 0.95 ? 0 : seconds, duration, updatedAt: Date.now() };
  const entries = Object.entries(profile.mediaProgress).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 500);
  profile.mediaProgress = Object.fromEntries(entries);
  });
  res.json({ saved: true });
}));

app.put('/api/profile/watched/:videoId', requirePlex, asyncRoute(async (req, res) => {
  const videoId = req.params.videoId;
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw Object.assign(new Error('Invalid YouTube video identifier.'), { status: 400 });
  await updateUserProfile(req, (profile) => {
    profile.watchedVideoIds = [...new Set([...profile.watchedVideoIds, videoId])].slice(-2000);
  });
  res.json({ saved: true });
}));

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('home-cinema.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    res.status(204).end();
  });
});

app.get('/api/plex/sections', requirePlex, asyncRoute(async (req, res) => {
  const token = plexState(req).plexToken!;
  const payload = await plexJson(token, '/library/sections');
  const sections = mediaContainer(payload).Directory || [];
  res.json(sections.filter((section: MediaItem) => ['movie', 'show'].includes(section.type)).map((section: MediaItem) => ({
    key: String(section.key), title: section.title, type: section.type,
  })));
}));

app.get('/api/plex/libraries/:sectionId', requirePlex, asyncRoute(async (req, res) => {
  if (!/^\d+$/.test(req.params.sectionId)) throw Object.assign(new Error('Invalid library.'), { status: 400 });
  const start = Math.max(0, Number(req.query.start) || 0);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 60));
  const payload = await plexJson(plexState(req).plexToken!, `/library/sections/${req.params.sectionId}/all?X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}&sort=titleSort:asc`);
  const container = mediaContainer(payload);
  res.json({ items: metadataRows(payload).map(safeItem), total: Number(container.totalSize ?? container.size ?? 0), start, size });
}));

app.get('/api/plex/search', requirePlex, asyncRoute(async (req, res) => {
  const query = String(req.query.query || '').trim();
  const mediaType = String(req.query.type || 'show');
  if (query.length < 2 || query.length > 120) throw Object.assign(new Error('Search for at least 2 characters.'), { status: 400 });
  if (mediaType !== 'show' && mediaType !== 'movie') throw Object.assign(new Error('Search type must be show or movie.'), { status: 400 });
  const payload = mediaContainer(await plexJson(plexState(req).plexToken!, `/hubs/search?query=${encodeURIComponent(query)}&limit=100`));
  const rows: MediaItem[] = (payload.Hub || []).flatMap((hub: MediaItem) => hub.Metadata || []).filter((item: MediaItem) => item.type === mediaType);
  const unique = [...new Map(rows.map((item: MediaItem) => [String(item.ratingKey), item])).values()];
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(unique.map(safeItem));
}));

registerWatchalong(app, { root: path.dirname(PROFILE_DATA_ROOT), sessions: SESSION_DATA_ROOT, machine: PLEX_MACHINE_ID, state: plexState, headers: plexHeaders, auth: requirePlex, wrap: asyncRoute, metadata: async (req, key) => {
  const item = metadataRows(await plexJson(plexState(req).plexToken!, `/library/metadata/${encodeURIComponent(key)}`))[0];
  if (!item) throw Object.assign(new Error('This title is not available to your Plex account.'), { status: 403 });
  return item;
} });

app.get('/api/plex/metadata/:ratingKey', requirePlex, asyncRoute(async (req, res) => {
  const item = metadataRows(await plexJson(plexState(req).plexToken!, `/library/metadata/${encodeURIComponent(req.params.ratingKey)}`))[0];
  if (!item) throw Object.assign(new Error('Movie details not found.'), { status: 404 });
  res.json(safeItem(item));
}));

app.get('/api/plex/metadata/:ratingKey/children', requirePlex, asyncRoute(async (req, res) => {
  const payload = await plexJson(plexState(req).plexToken!, `/library/metadata/${encodeURIComponent(req.params.ratingKey)}/children`);
  res.json(metadataRows(payload).map(safeItem));
}));

app.get('/api/plex/thumb/:ratingKey', requirePlex, asyncRoute(async (req, res) => {
  const payload = await plexJson(plexState(req).plexToken!, `/library/metadata/${encodeURIComponent(req.params.ratingKey)}`);
  const item = metadataRows(payload)[0];
  const imageKey = req.query.art === '1' ? item?.art : item?.thumb;
  if (!imageKey || typeof imageKey !== 'string' || !imageKey.startsWith('/')) {
    res.status(404).end();
    return;
  }
  const imageUrl = new URL('/photo/:/transcode', plexServerUrl());
  imageUrl.searchParams.set('url', imageKey);
  imageUrl.searchParams.set('width', req.query.art === '1' ? '1600' : '520');
  imageUrl.searchParams.set('height', req.query.art === '1' ? '900' : '780');
  imageUrl.searchParams.set('minSize', '1');
  imageUrl.searchParams.set('upscale', '1');
  const response = await fetch(imageUrl, { headers: plexHeaders(plexState(req).plexToken), signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body) {
    res.status(502).end();
    return;
  }
  res.setHeader('Content-Type', response.headers.get('content-type') || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=21600');
  Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(res);
}));

app.post('/api/plex/play/:ratingKey', requirePlex, asyncRoute(async (req, res) => {
  const token = plexState(req).plexToken!;
  const { filePath, item } = await itemFile(token, req.params.ratingKey);
  const probe = await inspectMedia(filePath);
  const subtitles = probe.subtitles.map((track) => ({ ...track, src: `/api/plex/subtitles/${encodeURIComponent(req.params.ratingKey)}/${track.index}` }));
  const plexDurationSeconds = Number(item.duration) / 1000;
  const durationSeconds = probe.durationSeconds || (Number.isFinite(plexDurationSeconds) && plexDurationSeconds > 0 ? plexDurationSeconds : undefined);
  if (probe.direct) {
    const signature = mediaCacheSignature(req.params.ratingKey);
    res.json({ mode: 'direct', durationSeconds, subtitles, url: `/api/plex/media/${encodeURIComponent(req.params.ratingKey)}/${signature}.mp4` });
    return;
  }
  const id = startHls(req.sessionID, { filePath, durationSeconds });
  res.json({ mode: 'hls', durationSeconds, subtitles, streamId: id, url: `/api/streams/${id}/index.m3u8` });
}));

app.get('/api/plex/subtitles/:ratingKey/:streamIndex', requirePlex, asyncRoute(async (req, res) => {
  if (!/^\d{1,20}$/.test(req.params.ratingKey) || !/^\d{1,4}$/.test(req.params.streamIndex)) throw Object.assign(new Error('Invalid subtitle track.'), { status: 400 });
  const { filePath } = await itemFile(plexState(req).plexToken!, req.params.ratingKey);
  const stat = await fsp.stat(filePath);
  const cacheKey = crypto.createHash('sha256').update(`${filePath}:${stat.size}:${stat.mtimeMs}:${req.params.streamIndex}`).digest('hex');
  const cacheDirectory = path.join(os.tmpdir(), 'home-cinema-subtitles');
  const cacheFile = path.join(cacheDirectory, `${cacheKey}.vtt`);
  await fsp.mkdir(cacheDirectory, { recursive: true });
  try { await fsp.access(cacheFile); }
  catch {
    try {
      const { stdout } = await execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-map', `0:${req.params.streamIndex}`, '-f', 'webvtt', '-'], { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
      if (!stdout.startsWith('WEBVTT')) throw new Error('The selected subtitle track could not be converted to WebVTT.');
      await fsp.writeFile(cacheFile, stdout, { mode: 0o600 });
    } catch (error) { throw Object.assign(new Error(error instanceof Error ? error.message : 'Could not convert this subtitle track.'), { status: 422 }); }
  }
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(cacheFile);
}));

app.get('/api/plex/media/:ratingKey/:cacheToken', requirePlex, asyncRoute(async (req, res) => {
  const supplied = req.params.cacheToken.replace(/\.mp4$/, '');
  const expected = mediaCacheSignature(req.params.ratingKey);
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (!req.params.cacheToken.endsWith('.mp4') || suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    res.status(404).end();
    return;
  }
  const { filePath } = await itemFile(plexState(req).plexToken!, req.params.ratingKey);
  const stat = await fsp.stat(filePath);
  const range = req.headers.range;
  const contentType = String(mime.lookup(filePath) || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, no-store');
  if (range) {
    const parsed = byteRange(range, stat.size);
    if (!parsed) { res.setHeader('Content-Range', `bytes */${stat.size}`); res.status(416).end(); return; }
    const { start, end } = parsed;
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') { res.end(); return; }
    await pipeline(fs.createReadStream(filePath, { start, end }), res);
    return;
  }
  res.setHeader('Content-Length', stat.size);
  if (req.method === 'HEAD') { res.end(); return; }
  await pipeline(fs.createReadStream(filePath), res);
}));

app.get('/api/tv/channels', requirePlex, asyncRoute(async (req, res) => {
  const start = Math.max(0, Number(req.query.start) || 0);
  const size = Math.min(250, Math.max(1, Number(req.query.size) || 100));
  const query = String(req.query.query || '').trim().toLocaleLowerCase().slice(0, 200);
  const [channelsResponse, guide] = await Promise.all([
    tvhJson(query ? 'api/channel/grid?start=0&limit=100000&sort=number&dir=ASC' : `api/channel/grid?start=${start}&limit=${size}&sort=number&dir=ASC`),
    tvhGuideWindow(),
  ]);
  const eventsByChannel = new Map<string, MediaItem[]>();
  for (const event of guide.events) {
    const uuid = String(event.channelUuid || event.channel || '');
    if (!uuid) continue;
    const list = eventsByChannel.get(uuid) || [];
    list.push(event);
    eventsByChannel.set(uuid, list);
  }
  const matchingChannels = (channelsResponse.entries || []).filter((channel: MediaItem) => !query || `${channel.number || channel.channelNumber || ''} ${channel.name || channel.channelName || ''}`.toLocaleLowerCase().includes(query));
  const channelPage = query ? matchingChannels.slice(start, start + size) : matchingChannels;
  const channels = channelPage.map((channel: MediaItem) => {
    const uuid = String(channel.uuid);
    const events = (eventsByChannel.get(uuid) || []).sort((a, b) => Number(a.start) - Number(b.start));
    const current = events.find((event) => Number(event.start) <= Math.floor(Date.now() / 1000) && Number(event.stop) > Math.floor(Date.now() / 1000)) || null;
    const icon = String(channel.icon_public_url || '');
    if (icon.startsWith('imagecache/')) tvhIconPaths.set(uuid, icon);
    return {
      uuid, name: channel.name || channel.channelName || 'TV channel',
      number: channel.number || channel.channelNumber || null,
      logo: icon.startsWith('imagecache/') ? `/api/tv/channel-icon/${encodeURIComponent(uuid)}` : null,
      current: current ? {
        title: current.title, subtitle: current.subtitle, description: current.description || current.summary,
        start: Number(current.start), stop: Number(current.stop), progress: Math.max(0, Math.min(100, (Date.now() / 1000 - Number(current.start)) / (Number(current.stop) - Number(current.start)) * 100)),
      } : null,
      programmes: events.map((event) => ({
        eventId: Number(event.eventId) || null, title: event.title || 'Programme', subtitle: event.subtitle || '',
        description: event.description || event.summary || '', start: Number(event.start), stop: Number(event.stop),
      })),
    };
  });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ items: channels, total: query ? matchingChannels.length : Number(channelsResponse.total) || Number(channelsResponse.totalCount) || channels.length, start, size, guideStart: guide.start, guideEnd: guide.end });
}));

app.get('/api/tv/channel-icon/:channelId', requirePlex, asyncRoute(async (req, res) => {
  const icon = tvhIconPaths.get(req.params.channelId);
  if (!icon || !/^imagecache\/[A-Za-z0-9_-]+$/.test(icon)) { res.status(404).end(); return; }
  const response = await tvhFetch(icon);
  if (!response.body) { res.status(404).end(); return; }
  res.setHeader('Content-Type', response.headers.get('content-type') || 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(res);
}));

app.post('/api/tv/play/:channelId', requirePlex, asyncRoute(async (req, res) => {
  const channelId = req.params.channelId;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(channelId)) throw Object.assign(new Error('Invalid TVHeadend channel.'), { status: 400 });
  const upstream = await tvhFetch(`stream/channel/${encodeURIComponent(channelId)}?profile=pass`, undefined, 0);
  if (!upstream.body) throw Object.assign(new Error('TVHeadend did not return a stream.'), { status: 502 });
  const id = startHls(req.sessionID, { liveResponse: upstream });
  res.json({ mode: 'hls', live: true, streamId: id, url: `/api/streams/${id}/index.m3u8`, title: 'Live TV' });
}));

app.get('/api/streams/:streamId/:filename', requirePlex, asyncRoute(async (req, res) => {
  const stream = streamSessions.get(req.params.streamId);
  if (!stream || stream.owner !== mediaOwner(req)) {
    res.status(404).json({ error: 'Playback session expired.' });
    return;
  }
  if (!/^(index\.m3u8|segment\d{6}\.ts|segment\d{6}\.ts\.tmp)$/.test(req.params.filename)) {
    res.status(404).end();
    return;
  }
  stream.lastAccess = Date.now();
  if (req.params.filename === 'index.m3u8' && !stream.live && stream.durationSeconds) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(vodPlaylist(req.params.streamId, stream.durationSeconds));
    return;
  }
  const fullPath = path.join(stream.directory, req.params.filename);
  if (!stream.live && req.params.filename.startsWith('segment')) {
    const segmentIndex = Number(req.params.filename.match(/^segment(\d{6})\.ts$/)?.[1]);
    if (!Number.isSafeInteger(segmentIndex)) { res.status(404).end(); return; }
    let job = stream.segmentJobs.get(segmentIndex);
    if (!job) {
      job = generateVodSegment(stream, segmentIndex).finally(() => stream.segmentJobs.delete(segmentIndex));
      stream.segmentJobs.set(segmentIndex, job);
    }
    try { await job; }
    catch (error) {
      if ((error as { status?: number }).status === 404) { res.status(404).end(); return; }
      throw error;
    }
  }
  const waitUntil = Date.now() + 120_000;
  while (!fs.existsSync(fullPath) && Date.now() < waitUntil && stream.process?.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!fs.existsSync(fullPath)) {
    res.status(503).json({ error: 'The stream is starting. Try again in a moment.' });
    return;
  }
  res.setHeader('Content-Type', req.params.filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(fullPath).pipe(res);
}));

app.delete('/api/streams/:streamId', requirePlex, (req, res) => {
  const stream = streamSessions.get(req.params.streamId);
  if (stream && stream.owner === req.sessionID) closeStream(req.params.streamId);
  res.status(204).end();
});

const publicDir = path.resolve('dist/public');
if (process.env.NODE_ENV === 'production' && fs.existsSync(publicDir)) {
  app.use(express.static(publicDir, { index: false, maxAge: '1h' }));
  app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
}

app.use((err: Error & { status?: number }, _req: Request, res: ExpressResponse, _next: NextFunction) => {
  if (_req.aborted || res.destroyed) return;
  if (res.headersSent) { _next(err); return; }
  const status = err.status || 500;
  if (status >= 500) console.error('[home-cinema]', _req.route?.path || 'request', err.message);
  res.status(status).json({ error: status >= 500 ? 'The media service could not complete that request.' : err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${SITE_NAME} API listening on ${PORT}`);
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'development-only-change-me') {
    console.warn('SESSION_SECRET is unset; configure a unique secret before public use.');
  }
});
