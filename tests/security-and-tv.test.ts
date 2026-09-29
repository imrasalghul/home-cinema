import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { isTvBrowser, remoteKey, nextInDirection } from '../src/tv-navigation';
import { fetchValidated, protectWrites, requireSessionSecret, WorkPool } from '../src/security';
import { registerCasting } from '../src/casting';

test('TV detection covers common vendors without enabling on desktop or phones', () => {
  for (const ua of ['Hisense VIDAA', 'Sony BRAVIA', 'SMART-TV Tizen', 'Web0S LG TV', 'Android TV', 'Google TV', 'Android SHIELD', 'AFTMM', 'HbbTV', 'Viera', 'NetTV', 'AppleTV']) assert.equal(isTvBrowser(ua), true, ua);
  for (const ua of ['Mozilla Windows Chrome', 'iPhone Mobile Safari', 'Android 14 Pixel 8 Mobile', 'Macintosh Safari', 'Tizen Mobile']) assert.equal(isTvBrowser(ua), false, ua);
  assert.equal(remoteKey('Unidentified', 10009), 'Escape');
  assert.equal(remoteKey('Unidentified', 461), 'Escape');
  assert.equal(remoteKey('Unidentified', 39), 'ArrowRight');
  assert.equal(remoteKey('Select', 0), 'Enter');
});

test('spatial focus follows rows, columns and offscreen carousel cards; edges stay put', () => {
  const box = { left: 100, right: 200, top: 100, bottom: 200 };
  const choices = [
    { item: 'right', box: { left: 230, right: 330, top: 100, bottom: 200 } },
    { item: 'diagonal', box: { left: 150, right: 220, top: 220, bottom: 280 } },
    { item: 'below', box: { left: 100, right: 200, top: 290, bottom: 390 } },
  ];
  assert.equal(nextInDirection(box, choices, 'ArrowRight'), 'right');
  assert.equal(nextInDirection(box, choices.slice(0, 1), 'ArrowLeft'), undefined);
  assert.equal(nextInDirection(box, [{ item: 'offscreen', box: { left: 2000, right: 2100, top: 100, bottom: 200 } }], 'ArrowRight'), 'offscreen');
  assert.equal(nextInDirection(box, [choices[0], choices[2]], 'ArrowDown'), 'below');
});

test('media redirects are checked before any request to an untrusted destination', async () => {
  const calls: string[] = [];
  const fetcher = (async (url: any) => { calls.push(String(url)); return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }); }) as typeof fetch;
  await assert.rejects(fetchValidated(new URL('https://media.example.test/video'), {}, url => url.origin === 'https://media.example.test', fetcher), /Untrusted/);
  assert.deepEqual(calls, ['https://media.example.test/video']);
});

test('work queue caps active jobs, rejects overload and releases slots after failure', async () => {
  const pool = new WorkPool(1, 1);
  let unblock!: () => void;
  const first = pool.run(() => new Promise<void>(resolve => { unblock = resolve; }));
  const second = pool.run(async () => { throw new Error('fixture failure'); });
  const rejection = assert.rejects(second, /fixture failure/);
  await assert.rejects(pool.run(async () => 3), /busy/);
  unblock(); await first; await rejection;
  assert.equal(await pool.run(async () => 4), 4);
});

test('production rejects missing/default secrets', () => {
  for (const secret of [undefined, 'short', 'development-only-change-me', 'replace-with-a-random-value-at-least-32-characters']) assert.throws(() => requireSessionSecret(secret, true));
  assert.doesNotThrow(() => requireSessionSecret('a9c8b7d6e5f40123456789abcdef01234', true));
  assert.doesNotThrow(() => requireSessionSecret(undefined, false));
});

test('cross-site writes are denied and cast grants stop working after logout revocation', async () => {
  const app = express();
  app.use(protectWrites('https://media.example.test'));
  app.use(express.json());
  app.use((req, _res, next) => { req.sessionID = 'owner'; next(); });
  const casting = registerCasting(app, { auth: (_req, _res, next) => next(), wrap: fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next), state: () => ({ plexToken: 'fixture' }), validate: async () => {}, validYoutubeMedia: () => false });
  app.get('/api/streams/fixture/index.m3u8', (_req, res) => res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'private, max-age=86400').send('#EXTM3U'));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cast = (origin: string) => fetch(base + '/api/cast', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ url: '/api/streams/fixture/index.m3u8' }) });
  try {
    assert.equal((await cast('https://attacker.example.test')).status, 403);
    const response = await cast('https://media.example.test'); assert.equal(response.status, 200);
    const grant = await response.json();
    const media = await fetch(base + grant.url); assert.equal(media.status, 200);
    assert.equal(media.headers.get('cache-control'), 'private, no-store');
    casting.revokeOwner('owner');
    assert.equal((await fetch(base + grant.url)).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
