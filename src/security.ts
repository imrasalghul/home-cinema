import type { RequestHandler } from 'express';

export const protectWrites = (publicUrl = ''): RequestHandler => (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }
  const origin = req.get('origin');
  const allowed = new Set([`${req.protocol}://${req.get('host')}`]);
  if (publicUrl) { try { allowed.add(new URL(publicUrl).origin); } catch { /* Invalid configuration cannot authorize an origin. */ } }
  if (req.get('sec-fetch-site') === 'cross-site' || origin && !allowed.has(origin)) {
    res.status(403).json({ error: 'This action must be made from the app.' }); return;
  }
  next();
};

export function requireSessionSecret(secret: string | undefined, production: boolean) {
  if (production && (!secret || secret.length < 32 || /development-only|change-me|replace-with/i.test(secret))) {
    throw new Error('Set SESSION_SECRET to a unique random value of at least 32 characters before starting production.');
  }
}

export function rateLimit(limit: number, windowMs: number): RequestHandler {
  const entries = new Map<string, { expires: number; count: number }>();
  const timer = setInterval(() => { for (const [key, entry] of entries) if (entry.expires < Date.now()) entries.delete(key); }, windowMs);
  timer.unref();
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = entries.get(key);
    if (!entry || entry.expires <= now) { entry = { count: 0, expires: now + windowMs }; entries.set(key, entry); }
    if (++entry.count > limit) { res.setHeader('Retry-After', Math.ceil((entry.expires - now) / 1000)); res.status(429).json({ error: 'Too many sign-in requests. Try again shortly.' }); return; }
    next();
  };
}

// Validate a redirect before making its request, rather than after following it.
export async function fetchValidated(url: URL, init: RequestInit, allowed: (url: URL) => boolean, fetcher: typeof fetch = fetch): Promise<Response> {
  let target = url;
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (!allowed(target) || target.username || target.password) throw Object.assign(new Error('Untrusted media redirect.'), { status: 502 });
    const response = await fetcher(target, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw Object.assign(new Error('Media redirect has no destination.'), { status: 502 });
    target = new URL(location, target);
  }
  throw Object.assign(new Error('Too many media redirects.'), { status: 502 });
}

export class WorkPool {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private limit: number, private queueLimit: number) {}
  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.queueLimit) throw Object.assign(new Error('Transcoding is busy. Try again shortly.'), { status: 503 });
      await new Promise<void>(resolve => this.waiting.push(resolve));
    } else this.active++;
    try { return await action(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
}
