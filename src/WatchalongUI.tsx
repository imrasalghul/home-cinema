import { useEffect, useState } from 'react';

export type WatchRoom = { id: string; itemKey: string; title: string; inviter: string; accepted: boolean; ended: boolean; position: number; playing: boolean; members: Array<{ name: string; accepted: boolean; ready: boolean; connected: boolean }> };
async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Watchalong request failed.'); return result;
}

export function NotificationBell({ onJoin }: { onJoin: (room: WatchRoom) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [rooms, setRooms] = useState<WatchRoom[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    let stopped = false;
    const refresh = () => void api<WatchRoom[]>('/api/watchalong/notifications').then(result => { if (!stopped) { setRooms(result); setError(''); } }).catch(() => { if (!stopped) setError('Notifications are temporarily unavailable.'); });
    refresh(); const timer = window.setInterval(refresh, 5000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, []);
  const pending = rooms.filter(room => !room.accepted).length;
  return <div className="notifications"><button className="notification-bell" aria-label={`Notifications${pending ? ` (${pending} pending watchalong invitations)` : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>{pending > 0 && <span className="notification-count">{pending}</span>}</button>{open && <section data-tv-scope className="notification-panel" aria-label="Watchalong notifications"><header><strong>Notifications</strong><button className="icon-button" data-tv-close aria-label="Close notifications" onClick={() => setOpen(false)}>×</button></header>{error && <p role="alert">{error}</p>}{!rooms.length && !error && <p>No watchalong invitations.</p>}{rooms.map(room => <article key={room.id}><strong>{room.title}</strong><p>{room.accepted ? `Watchalong with ${room.members.map(member => member.name).join(' and ')}` : `${room.inviter} invited you to watch together.`}</p><div><button disabled={Boolean(busy)} onClick={async () => { setBusy(room.id); setError(''); try { await onJoin(room); setOpen(false); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not join.'); } finally { setBusy(''); } }}>{busy === room.id ? 'Joining…' : room.accepted ? 'Rejoin' : 'Accept & watch'}</button><button className="secondary" disabled={Boolean(busy)} onClick={async () => { try { await api(`/api/watchalong/${room.id}/leave`, { end: true }); setRooms(current => current.filter(entry => entry.id !== room.id)); } catch (reason) { setError(String(reason)); } }}>{room.accepted ? 'End' : 'Decline'}</button></div></article>)}</section>}</div>;
}

export function WatchalongInvite({ item, onClose, onCreated, position }: { item: { ratingKey: string; title: string }; position: number; onClose: () => void; onCreated: (room: WatchRoom) => Promise<void> }) {
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { let stopped = false; void api<Array<{ id: string; name: string }>>('/api/watchalong/users').then(result => { if (!stopped) setUsers(result); }).catch(reason => { if (!stopped) setError(reason.message); }).finally(() => { if (!stopped) setLoading(false); }); return () => { stopped = true; }; }, []);
  return <div className="detail-backdrop invitation-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="invite-dialog" role="dialog" aria-modal="true" aria-label="Invite to watchalong"><header><h2>Watch together</h2><button className="icon-button" onClick={onClose} disabled={busy} data-tv-close aria-label="Close invitation">×</button></header><p>{item.title}</p><label>Plex server user<select value={selected} onChange={event => setSelected(event.target.value)} disabled={loading || busy}><option value="">{loading ? 'Loading Plex users…' : 'Select a user'}</option>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>{!loading && !users.length && !error && <p>No other users have access to this server.</p>}<p className="muted">They’ll receive an invitation in their notification bell. Playback waits until both of you are ready.</p>{error && <p className="error-banner" role="alert">{error}</p>}<button className="feature-play" disabled={!selected || busy} onClick={async () => { setBusy(true); setError(''); try { const room = await api<WatchRoom>('/api/watchalong', { userId: selected, itemKey: item.ratingKey, position }); await onCreated(room); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not invite user.'); } finally { setBusy(false); } }}>{busy ? 'Inviting…' : 'Invite & watch'}</button></section></div>;
}
