import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { PersistentSessionStore } from '../src/session-store';
import { byteRange, requestedSeasons, changeSubscription } from '../src/media-rules';
import { registerWatchalong } from '../src/watchalong';

test('parallel session reads see complete JSON; stale touches cannot erase login or resurrect logout', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agplay-session-'));
  const store = new PersistentSessionStore(root);
  const invoke = (method: 'set' | 'touch' | 'destroy', value?: any) => new Promise<void>((resolve, reject) => {
    const done = (error?: any) => error ? reject(error) : resolve();
    if (method === 'destroy') store.destroy('sid', done); else store[method]('sid', value, done);
  });
  const read = () => new Promise<any>((resolve, reject) => store.get('sid', (error, value) => error ? reject(error) : resolve(value)));
  const base = { cookie: { expires: new Date(Date.now() + 86400000) } };
  try {
    await invoke('set', base);
    const login = { ...base, plexToken: 'test-token', payload: 'x'.repeat(50000) };
    const writer = invoke('set', login);
    await Promise.all(Array.from({ length: 100 }, () => read()));
    await writer;
    await invoke('touch', base);
    assert.equal((await read()).plexToken, 'test-token');
    await Promise.all([invoke('set', login), invoke('destroy'), invoke('touch', base), invoke('set', login)]);
    assert.equal(await read(), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('suffix, open-ended, clamped and invalid HTTP byte ranges', () => {
  assert.deepEqual(byteRange('bytes=-500', 1000), { start: 500, end: 999 });
  assert.deepEqual(byteRange('bytes=-2000', 1000), { start: 0, end: 999 });
  assert.deepEqual(byteRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(byteRange('bytes=900-2000', 1000), { start: 900, end: 999 });
  for (const header of ['bytes=-', 'bytes=-0', 'bytes=1000-', 'bytes=100-50', 'bytes=0-1,3-4', 'bytes=99999999999999999999-']) assert.equal(byteRange(header, 1000), null);
});

test('requests for one season do not block another; declined and 4K-only requests do not block standard requests', () => {
  const seasons = requestedSeasons({ requests: [
    { status: 2, seasons: [{ seasonNumber: 1, status: 2 }] },
    { status: 3, seasons: [{ seasonNumber: 2, status: 3 }] },
    { status: 1, is4k: true, seasons: [{ seasonNumber: 3 }] },
    { status: 1, seasons: [{ seasonNumber: 4 }] },
  ] });
  assert.deepEqual(seasons, [1, 4]);
  assert.equal(seasons.includes(2), false);
});

test('subscription deltas preserve changes from other tabs and enforce the limit', () => {
  const a = { id: 'UC' + 'a'.repeat(22), name: 'A' };
  const b = { id: 'UC' + 'b'.repeat(22), name: 'B' };
  let subscriptions = changeSubscription([], { subscriptionAdd: a });
  subscriptions = changeSubscription(subscriptions, { subscriptionAdd: b });
  assert.deepEqual(changeSubscription(subscriptions, { subscriptionRemove: a.id }), [b]);
  assert.throws(() => changeSubscription(Array.from({ length: 30 }, (_, i) => ({ id: String(i).padStart(24, 'x'), name: String(i) })), { subscriptionAdd: a }), /30 creators/);
});

test('two-user Watchalong reuses invitations, synchronizes pause and seek, pauses for buffering, and reconnects', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agplay-watchalong-'));
  const app = express(); app.use(express.json());
  const alice = { id: 1, username: 'alice', email: 'alice@example.test' };
  const bob = { id: 2, username: 'bob', email: 'bob@example.test' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://plex.tv/api/users') return new Response('<MediaContainer><User id="2" username="bob" email="bob@example.test"><Server machineIdentifier="test-machine" pending="0" /></User></MediaContainer>');
    if (url === 'https://plex.tv/api/v2/user') return Response.json(alice);
    return originalFetch(input, init);
  };
  registerWatchalong(app, { root, sessions: root, machine: 'test-machine', state: req => ({ plexToken: 'fixture-token', plexUser: req.get('x-user') === 'bob' ? bob : alice }), headers: () => ({}), metadata: async () => ({ type: 'movie', title: 'Fixture movie', duration: 600000 }), auth: (_req, _res, next) => next(), wrap: fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next) });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (url: string, user = 'alice', body?: any) => {
    const response = await originalFetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-user': user, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  };
  try {
    const users = await api('/api/watchalong/users');
    const invite = { itemKey: '123', userId: users[0].id, position: 30 };
    const room = await api('/api/watchalong', 'alice', invite);
    assert.equal((await api('/api/watchalong', 'alice', invite)).id, room.id);
    const route = `/api/watchalong/${room.id}`;
    await api(route + '/join', 'alice', {}); await api(route + '/join', 'bob', {});
    await api(route + '/sync', 'alice', { ready: true, command: 'play', position: 30 });
    assert.equal((await api(route + '/sync', 'bob', { ready: true, position: 30 })).playing, true);
    assert.equal((await api(route + '/sync', 'bob', { ready: false, position: 30 })).playing, false);
    assert.equal((await api(route + '/sync', 'bob', { ready: true, position: 30 })).playing, true);
    assert.equal((await api(route + '/sync', 'alice', { ready: true, command: 'pause', position: 50 })).intent, false);
    assert.equal((await api(route + '/sync', 'bob', { ready: true, command: 'seek', position: 120 })).position, 120);
    await api(route + '/disconnect', 'bob', {});
    assert.equal((await api('/api/watchalong/notifications'))[0].members[1].connected, false);
    const reconnected = await api(route + '/sync', 'bob', { ready: true, position: 120 });
    assert.equal(reconnected.members[1].connected, true);
    assert.equal(reconnected.ended, false);
    await api(route + '/leave', 'alice', { end: true });
    assert.deepEqual(await api('/api/watchalong/notifications'), []);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
