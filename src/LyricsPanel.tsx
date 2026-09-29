import { useEffect, useState } from 'react';

type Song = { id: number; title: string; artist: string; url: string };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

export default function LyricsPanel({ trackId, onClose }: { trackId: string; onClose: () => void }) {
  const [songs, setSongs] = useState<Song[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setSongs([]); setSelected(0); setLoading(true); setError('');
    void fetch(`/api/music/lyrics/${encodeURIComponent(trackId)}`, { signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Genius is unavailable.');
      if (!controller.signal.aborted) setSongs(data.songs);
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [trackId]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [onClose]);
  const song = songs[selected];
  // Keep the third-party script isolated from the app, its cookies and player.
  const embedDocument = song ? `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:12px;font:16px system-ui;background:#fff;color:#111}a{color:#333}</style></head><body><div id="rg_embed_link_${song.id}" class="rg_embed_link" data-song-id="${song.id}">Read <a target="_blank" rel="noopener noreferrer" href="${escapeHtml(song.url)}">${escapeHtml(song.title)} by ${escapeHtml(song.artist)}</a> on Genius</div><script crossorigin src="https://genius.com/songs/${song.id}/embed.js"></script></body></html>` : '';
  return <aside data-tv-scope className="lyrics-panel" id="music-lyrics" aria-label="Genius lyrics">
    <header><div><strong>Lyrics</strong><small>Genius</small></div><button className="icon-button" onClick={onClose} data-tv-close aria-label="Close lyrics">×</button></header>
    {loading ? <p role="status">Finding lyrics…</p> : error ? <p role="alert">{error}</p> : !song ? <p>No matching lyrics found on Genius.</p> : <>
      {songs.length > 1 && <label className="lyrics-match">Song match<select value={selected} onChange={event => setSelected(Number(event.target.value))}>{songs.map((entry, index) => <option value={index} key={entry.id}>{entry.title} — {entry.artist}</option>)}</select></label>}
      <iframe key={song.id} title={`${song.title} lyrics from Genius`} srcDoc={embedDocument} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" />
      <a className="lyrics-source" href={song.url} target="_blank" rel="noopener noreferrer">Open on Genius ↗</a>
    </>}
  </aside>;
}
