import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { PlayerSource } from './Player';
import './style.css';
import YouTubeCommentThread, { type YouTubeComment } from './YouTubeCommentThread';
import LyricsPanel from './LyricsPanel';
import MovieDetails, { RottenTomatoes } from './MovieDetails';
import { NotificationBell, WatchalongInvite, type WatchRoom } from './WatchalongUI';
import { useTvNavigation } from './tv-navigation';

const Player = lazy(() => import('./Player'));

type Status = {
  siteName: string;
  plex: { configured: boolean; reachable: boolean; machineId: string | null };
  tvheadend: { configured: boolean; reachable: boolean };
  navidrome: { configured: boolean };
  seerr: { configured: boolean };
  authenticated: boolean;
  user: string | null;
};
type Section = { key: string; title: string; type: 'movie' | 'show' };
export type Item = {
  ratingKey: string; type: string; title: string; year?: number; summary?: string;
  thumb?: string | null; art?: string | null; duration?: number; viewOffset?: number; index?: number; parentIndex?: number;
  parentTitle?: string; grandparentTitle?: string; leafCount?: number;
  contentRating?: string; rating?: number; audienceRating?: number; ratingImage?: string; audienceRatingImage?: string; ratings?: Array<{type: string; value: number}>; genres?: string[]; cast?: string[]; directors?: string[]; tagline?: string;
};
type Channel = {
  uuid: string; name: string; number: number | null; logo?: string | null;
  programmes?: Array<{ eventId: number | null; title: string; subtitle: string; description: string; start: number; stop: number }>;
  current?: { title?: string; subtitle?: string; description?: string; start?: number; stop?: number; progress?: number | null } | null;
};
type MusicAlbum = { id: string; name: string; artist: string; coverArt?: string; songCount?: number; year?: number };
type MusicTrack = { id: string; title: string; artist: string; album: string; coverArt?: string; duration?: number; contentType?: string };
type SeerrShow = { id: number; mediaType?: 'tv' | 'movie'; title: string; year: string | null; overview: string; posterPath: string | null; status: number | null; requestStatus: number | null };
type SeerrSeason = { seasonNumber: number; name: string; episodeCount: number; overview: string; posterPath: string | null; airDate: string | null };
type SeerrEpisode = { episodeNumber: number; title: string; overview: string; airDate: string; runtime: number | null };
type SeerrSeriesDetails = SeerrShow & { backdropPath: string | null; firstAirDate: string; seasons: SeerrSeason[]; requestedSeasons?: number[] };
type SeerrSeasonDetails = { seasonNumber: number; name: string; episodes: SeerrEpisode[] };
type SeriesSearchEntry = { key: string; seerr: SeerrShow | null; plex: Item | null };
type ShowSeasonEntry = { seasonNumber: number; name: string; episodeCount: number; plexItem: Item | null; seerr: SeerrSeason | null };
type YouTubeResult = { id: string; title: string; author: string; authorId: string | null; durationSeconds: number; thumbnail: string | null; publishedText: string; published?: number; viewCountText: string };
type YouTubeVideo = YouTubeResult & { description: string; streamUrl: string; contentType: string; mode: 'direct' | 'dash'; captions: NonNullable<PlayerSource['subtitles']>; related: YouTubeResult[] };
type CreatorSubscription = { id: string; name: string };
type SavedYouTubeVideo = YouTubeResult;
type ProfileData = { subscriptions: CreatorSubscription[]; watchlist: SavedYouTubeVideo[]; watchedVideoIds: string[]; mediaProgress: Record<string, { seconds: number; duration: number; updatedAt: number }> };
type Playback = PlayerSource & { title: string; audio?: boolean; musicTrackId?: string; channelUuid?: string };
type AppTab = 'movies' | 'tv' | 'live' | 'youtube' | 'music';
type DirectYouTubeRoute = { kind: 'video'; id: string } | { kind: 'handle'; handle: string } | { kind: 'channel'; id: string };

function routeFromLocation(): { tab: AppTab; youtube: DirectYouTubeRoute | null } {
  let pathname = window.location.pathname;
  try { pathname = decodeURIComponent(pathname); } catch { /* treat malformed escapes as an unmatched path */ }
  if (pathname === '/series' || pathname === '/series/') return { tab: 'tv', youtube: null };
  if (pathname === '/movies' || pathname === '/movies/') return { tab: 'movies', youtube: null };
  if (pathname === '/tv' || pathname === '/tv/') return { tab: 'live', youtube: null };
  if (pathname === '/music' || pathname === '/music/') return { tab: 'music', youtube: null };
  if (pathname === '/youtube' || pathname === '/youtube/') return { tab: 'youtube', youtube: null };
  if (pathname === '/youtube/watch' || pathname === '/youtube/watch/') {
    const id = new URLSearchParams(window.location.search).get('v') || '';
    return { tab: 'youtube', youtube: /^[A-Za-z0-9_-]{11}$/.test(id) ? { kind: 'video', id } : null };
  }
  const handle = pathname.match(/^\/youtube\/@([A-Za-z0-9._-]{1,64})\/?$/)?.[1];
  if (handle) return { tab: 'youtube', youtube: { kind: 'handle', handle } };
  const channelId = pathname.match(/^\/youtube\/channel\/([A-Za-z0-9_-]{24})\/?$/)?.[1];
  if (channelId) return { tab: 'youtube', youtube: { kind: 'channel', id: channelId } };
  return { tab: 'movies', youtube: null };
}

function normalizeMediaTitle(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload as T;
}

function durationLabel(value?: number) {
  if (!value) return '';
  const minutes = Math.round(value / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

function PlexGate({ onSignedIn, siteName }: { onSignedIn: (user: string) => void; siteName: string }) {
  const [code, setCode] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [phoneSignIn, setPhoneSignIn] = useState(false);
  const [qrCode, setQrCode] = useState('');

  async function signIn(phone = false) {
    setError('');
    setPending(true);
    setPhoneSignIn(phone); setQrCode('');
    // Open synchronously from the click gesture so browser popup protection does not block Plex.
    const authWindow = phone ? null : window.open('about:blank', '_blank');
    try {
      const pin = await request<{ code: string; authUrl: string }>('/api/auth/plex/pin', { method: 'POST' });
      setCode(pin.code);
      setAuthUrl(pin.authUrl);
      if (phone) {
        const { toDataURL } = await import('qrcode');
        setQrCode(await toDataURL(pin.authUrl, { width: 320, margin: 4, errorCorrectionLevel: 'M' }));
      } else if (authWindow) authWindow.location.replace(pin.authUrl);
      else setError('Your browser blocked the Plex sign-in tab. Use “Open Plex sign-in” below, or allow pop-ups for this site.');
    } catch (reason) {
      authWindow?.close();
      setCode('');
      setError(reason instanceof Error ? reason.message : 'Could not start Plex sign-in.');
      setPending(false);
    }
  }

  useEffect(() => {
    if (!code) return;
    let busy = false;
    let stopped = false;
    const poll = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await request<{ authenticated: boolean; user?: string }>('/api/auth/plex/poll');
        if (stopped) return;
        if (result.authenticated) {
          window.clearInterval(poll);
          onSignedIn(result.user || 'Plex user');
        }
      } catch (reason) {
        if (stopped) return;
        window.clearInterval(poll);
        setError(reason instanceof Error ? reason.message : 'Plex sign-in failed.');
        setCode('');
        setPending(false);
      } finally { busy = false; }
    }, 1800);
    return () => { stopped = true; window.clearInterval(poll); };
  }, [code, onSignedIn]);

  return (
    <main className="gate-screen">
      <div className="gate-glow" />
      <div className="gate-brand"><span className="brand-mark">⌂</span><span>{siteName.toUpperCase()}</span></div>
      <section className="gate-card">
        <div className="gate-art"><span className="gate-play">▶</span><span className="gate-art-label">YOUR LIBRARY, ON YOUR TERMS</span></div>
        <div className="gate-copy">
          <div className="eyebrow">SIGN IN TO CONTINUE</div>
          <h1>Your home.<br /><em>Your screen.</em></h1>
          <p>Movies and shows from your Plex library. Live channels from TVHeadend. All in one place.</p>
          {code ? (
            <div className="pin-box">
              <span className="eyebrow">PLEX SIGN-IN</span>
              {phoneSignIn && (qrCode ? <img className="plex-qr" src={qrCode} alt="Scan with your phone to approve Plex sign-in on this screen" width="320" height="320" /> : <span role="status">Preparing QR code…</span>)}
              <span className="waiting"><i /> {phoneSignIn ? 'Scan with your phone’s camera and approve sign-in with Plex. This screen will sign in automatically.' : 'Approve the request in the Plex tab. This page will sign in automatically.'}</span>
              <a href={authUrl} target="_blank" rel="noreferrer">Open Plex sign-in ↗</a>
              <button className="text-button" onClick={() => { setCode(''); setPending(false); setQrCode(''); }}>Start again</button>
            </div>
          ) : (
            <><button className="plex-login" onClick={() => void signIn()} disabled={pending}>
              <span className="plex-logo">▰</span>{pending ? 'Connecting to Plex…' : 'Continue with Plex'}
            </button><button className="plex-phone-login" onClick={() => void signIn(true)} disabled={pending}>Sign in with phone <span aria-hidden="true">▦</span></button></>
          )}
          {error && <div className="error-banner">{error}</div>}
          <div className="privacy-note"><span>▣</span> Sign in only connects to your configured Plex server.</div>
        </div>
      </section>
      <div className="gate-foot"><span>Copyright (c) 2026 Helio AG Ventures.</span></div>
    </main>
  );
}

function MediaCard({ item, onClick, compact = false, progress = 0 }: { item: Item; onClick: () => void; compact?: boolean; progress?: number }) {
  const progressPercent = item.duration ? Math.max(0, Math.min(100, progress * 1000 / item.duration * 100)) : 0;
  return (
    <button className={`media-card ${compact ? 'episode-card' : ''}`} onClick={onClick}>
      <div className="poster-wrap">
        {item.thumb ? <img className="poster" src={item.thumb} alt="" loading="lazy" /> : <div className="poster-placeholder"><span>HC</span></div>}
        <span className="card-action">{item.type === 'show' || item.type === 'season' ? '＋' : '▶'}</span>
        {progressPercent > 0 && progressPercent < 95 && <><span className="resume-badge">RESUME</span><span className="resume-progress"><i style={{ width: `${progressPercent}%` }} /></span></>}
        {item.duration && <span className="runtime">{durationLabel(item.duration)}</span>}
      </div>
      <span className="media-title">{item.title || 'Untitled'}</span>
      <span className="media-meta">{item.year || (item.parentIndex ? `Season ${item.parentIndex}` : '')}{item.type === 'episode' && item.index ? ` · Episode ${item.index}` : ''}</span>
    </button>
  );
}

function Carousel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const rail = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const update = useCallback(() => { const el = rail.current; if (el) setEdges({ start: el.scrollLeft < 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 }); }, []);
  useEffect(() => { const el = rail.current; if (!el) return; update(); const observer = new ResizeObserver(update); observer.observe(el); return () => observer.disconnect(); }, [children, update]);
  const move = (direction: number) => rail.current?.scrollBy({ left: direction * rail.current.clientWidth * .9, behavior: 'smooth' });
  return <div className="carousel"><button className="carousel-arrow previous" aria-label="Previous titles" disabled={edges.start} onClick={() => move(-1)}>‹</button><div ref={rail} className={`media-rail ${className}`} onScroll={update}>{children}</div><button className="carousel-arrow next" aria-label="Next titles" disabled={edges.end} onClick={() => move(1)}>›</button></div>;
}

function VideoOverlay({ playback, onClose, onWatchalong }: { playback: Playback; onClose: () => void; onWatchalong: () => void }) {
  const [lyricsOpen, setLyricsOpen] = useState(false);
  function close() {
    onClose();
  }
  return (
    <div className={playback.audio ? "music-dock" : "player-backdrop"} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="player-dialog" role={playback.audio ? "region" : "dialog"} aria-modal={playback.audio ? undefined : true} aria-label={playback.title}>
        {playback.audio && playback.musicTrackId && lyricsOpen && <LyricsPanel trackId={playback.musicTrackId} onClose={() => setLyricsOpen(false)} />}<header className="player-head"><div><span className="live-dot" /> NOW PLAYING <strong>{playback.title}</strong></div>{playback.audio && playback.musicTrackId && <button className="lyrics-toggle" aria-expanded={lyricsOpen} aria-controls="music-lyrics" onClick={() => setLyricsOpen(open => !open)}>Lyrics</button>}{playback.itemKey && !playback.roomId && <button className="watchalong-button" onClick={onWatchalong}>Watchalong</button>}<button className="icon-button" onClick={close} data-tv-close aria-label="Close player">×</button></header>
        <div className={`video-frame ${playback.audio ? 'audio-frame' : ''}`}><Suspense fallback={<div className="player-loading"><span className="spinner" /> Loading player…</div>}><Player key={`${playback.itemKey || playback.url}:${playback.roomId || ""}`} source={playback} /></Suspense></div>
      </section>
    </div>
  );
}

function App() {
  useTvNavigation();
  const libraryRequest = useRef(0);
  const playbackRequest = useRef(0);
  const detailRequest = useRef<AbortController | null>(null);
  const profilePending = useRef(new Set<string>());
  function beginDetail() { detailRequest.current?.abort(); const controller = new AbortController(); detailRequest.current = controller; return controller; }
  const [movieDetails, setMovieDetails] = useState<Item | null>(null);
  const [inviteItem, setInviteItem] = useState<Item | null>(null);
  const playbackPosition = useRef(0);
  const [status, setStatus] = useState<Status | null>(null);
  const siteName = status?.siteName || 'Media Home';
  const [tab, setTab] = useState<AppTab>(() => routeFromLocation().tab);
  const [searchExpanded, setSearchExpanded] = useState(false);
  const headerSearchRef = useRef<HTMLInputElement>(null);
  const [directYouTubeRoute, setDirectYouTubeRoute] = useState<DirectYouTubeRoute | null>(() => routeFromLocation().youtube);
  const handledDirectRoute = useRef('');
  const youtubeRouteGeneration = useRef(0);
  const [sections, setSections] = useState<Section[]>([]);
  const [activeSection, setActiveSection] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [start, setStart] = useState(0);
  const [show, setShow] = useState<Item | null>(null);
  const [seasons, setSeasons] = useState<Item[]>([]);
  const [season, setSeason] = useState<Item | null>(null);
  const [episodes, setEpisodes] = useState<Item[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const channelSwitchBusy = useRef(false);
  const [channelTotal, setChannelTotal] = useState(0);
  const [channelStart, setChannelStart] = useState(0);
  const [channelLoadingMore, setChannelLoadingMore] = useState(false);
  const [channelSearch, setChannelSearch] = useState('');
  const [epgNow, setEpgNow] = useState(Date.now());
  const [musicNextStart, setMusicNextStart] = useState(0);
  const [musicHasMore, setMusicHasMore] = useState(false);
  const [musicAlbums, setMusicAlbums] = useState<MusicAlbum[]>([]);
  const [musicTracks, setMusicTracks] = useState<MusicTrack[]>([]);
  const [musicSearch, setMusicSearch] = useState('');
  const [musicAlbumOpen, setMusicAlbumOpen] = useState(false);
  const [musicPlaying, setMusicPlaying] = useState<string | null>(null);
  const [musicLoading, setMusicLoading] = useState(false);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const [seriesLibraryResults, setSeriesLibraryResults] = useState<Item[]>([]);
  const [seerrResults, setSeerrResults] = useState<SeerrShow[]>([]);
  const [seriesSearchLoading, setSeriesSearchLoading] = useState(false);
  const [seriesSearchError, setSeriesSearchError] = useState('');
  const [requestSeries, setRequestSeries] = useState<SeerrShow | null>(null);
  const [requestSeriesDetails, setRequestSeriesDetails] = useState<SeerrSeriesDetails | null>(null);
  const [requestSeriesPlexItem, setRequestSeriesPlexItem] = useState<Item | null>(null);
  const [requestSeriesPlexSeasons, setRequestSeriesPlexSeasons] = useState<Item[]>([]);
  const [requestSeasonDetails, setRequestSeasonDetails] = useState<SeerrSeasonDetails | null>(null);
  const [requestSeasonPlexEpisodes, setRequestSeasonPlexEpisodes] = useState<Item[]>([]);
  const [requestSeasonLoading, setRequestSeasonLoading] = useState(false);
  const [requestingSeason, setRequestingSeason] = useState<number | null>(null);
  const [requestedSeasonKeys, setRequestedSeasonKeys] = useState<string[]>([]);
  const [requestingEpisodeKey, setRequestingEpisodeKey] = useState<string | null>(null);
  const [requestedEpisodeKeys, setRequestedEpisodeKeys] = useState<string[]>([]);
  const [youtubeSearch, setYoutubeSearch] = useState('');
  const [youtubeResults, setYoutubeResults] = useState<YouTubeResult[]>([]);
  const [youtubeLoading, setYoutubeLoading] = useState(false);
  const [youtubeView, setYoutubeView] = useState<'search' | 'subscriptions' | 'channel' | 'watchlist'>('subscriptions');
  const [youtubeVideo, setYoutubeVideo] = useState<YouTubeVideo | null>(null);
  const [youtubeComments, setYoutubeComments] = useState<YouTubeComment[]>([]);
  const [youtubeCommentsLoading, setYoutubeCommentsLoading] = useState(false);
  const [youtubeCommentsError, setYoutubeCommentsError] = useState('');
  const [youtubeChannel, setYoutubeChannel] = useState<CreatorSubscription | null>(null);
  const [youtubeChannelVideos, setYoutubeChannelVideos] = useState<YouTubeResult[]>([]);
  const [youtubeChannelLoading, setYoutubeChannelLoading] = useState(false);
  const [youtubeFeed, setYoutubeFeed] = useState<YouTubeResult[]>([]);
  const [youtubeFeedLoading, setYoutubeFeedLoading] = useState(false);
  const [youtubeFeedError, setYoutubeFeedError] = useState('');
  const [watchlist, setWatchlist] = useState<SavedYouTubeVideo[]>([]);
  const [watchedVideoIds, setWatchedVideoIds] = useState<string[]>([]);
  const [mediaProgress, setMediaProgress] = useState<ProfileData['mediaProgress']>({});
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [subscriptions, setSubscriptions] = useState<CreatorSubscription[]>([]);

  const headerSearchValue = tab === 'music' ? musicSearch : tab === 'live' ? channelSearch : tab === 'youtube' ? youtubeSearch : search;
  const headerSearchPlaceholder = tab === 'movies' ? 'Search movies' : tab === 'tv' ? 'Search series' : tab === 'live' ? 'Search channels' : tab === 'music' ? 'Search music' : 'Search YouTube';

  useEffect(() => {
    if (searchExpanded) headerSearchRef.current?.focus();
  }, [searchExpanded, tab]);

  function updateHeaderSearch(value: string) {
    if (tab === 'movies' || tab === 'tv') setSearch(value);
    else if (tab === 'live') setChannelSearch(value);
    else if (tab === 'music') { setMusicAlbumOpen(false); setMusicSearch(value); }
    else { setYoutubeSearch(value); setYoutubeView('search'); }
  }

  function setBrowserPath(path: string) {
    if (`${window.location.pathname}${window.location.search}` !== path) window.history.pushState({}, '', path);
  }

  function navigateSection(nextTab: AppTab) {
    youtubeRouteGeneration.current++;
    const paths: Record<AppTab, string> = { movies: '/movies', tv: '/series', live: '/tv', music: '/music', youtube: '/youtube' };
    setBrowserPath(paths[nextTab]);
    setTab(nextTab); setDirectYouTubeRoute(null); setSearch(''); setSearchExpanded(false);
    setYoutubeVideo(null); setYoutubeChannel(null); setYoutubeView(nextTab === 'youtube' ? 'subscriptions' : 'search');
    setShow(null); setSeason(null); setEpisodes([]); setMovieDetails(null);
    setRequestSeries(null); setRequestSeriesDetails(null); setRequestSeasonDetails(null);
    if (nextTab === 'music') { setMusicAlbumOpen(false); setMusicTracks([]); }
  }

  useEffect(() => {
    const syncRoute = () => {
      youtubeRouteGeneration.current++;
      const route = routeFromLocation();
      setTab(route.tab); setDirectYouTubeRoute(route.youtube); setSearchExpanded(false);
      setYoutubeVideo(null); setYoutubeChannel(null); setYoutubeView(route.tab === 'youtube' ? 'subscriptions' : 'search');
      setSearch(''); setShow(null); setSeason(null); setEpisodes([]); setMovieDetails(null);
      setRequestSeries(null); setRequestSeriesDetails(null); setRequestSeasonDetails(null);
    };
    window.addEventListener('popstate', syncRoute);
    return () => window.removeEventListener('popstate', syncRoute);
  }, []);

  useEffect(() => {
    if (tab !== 'live' && playback?.live) {
      setPlayback(null);
    }
  }, [tab, playback?.live, playback?.streamId]);

  useEffect(() => {
    const id = playback?.streamId;
    if (!id) return;
    const release = () => { void fetch(`/api/streams/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true }).catch(() => {}); };
    window.addEventListener('pagehide', release);
    return () => { window.removeEventListener('pagehide', release); release(); };
  }, [playback?.streamId]);

  useEffect(() => {
    setLoading(false); setRequestSeasonLoading(false);
    return () => { libraryRequest.current++; playbackRequest.current++; detailRequest.current?.abort(); };
  }, [tab]);

  function stopLivePlayback() { playbackRequest.current++; setPlayback(null); }

  const refreshStatus = useCallback(async () => {
    try {
      const [serverStatus, account] = await Promise.all([
        request<Omit<Status, 'authenticated' | 'user'>>('/api/status'),
        request<{ authenticated: boolean; user: string | null }>('/api/auth/me'),
      ]);
      setStatus({ ...serverStatus, ...account });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'The media service is not responding.');
    }
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  useEffect(() => {
    document.title = siteName;
    document.querySelector('meta[name="description"]')?.setAttribute('content', `${siteName} — your personal media library.`);
  }, [siteName]);

  useEffect(() => {
    if (!status?.authenticated) { setProfileLoaded(false); return; }
    const controller = new AbortController();
    setProfileLoaded(false);
    void request<ProfileData>('/api/profile', { signal: controller.signal }).then((profile) => {
      if (controller.signal.aborted) return;
      setSubscriptions(profile.subscriptions);
      setWatchlist(profile.watchlist);
      setWatchedVideoIds(profile.watchedVideoIds);
      setMediaProgress(profile.mediaProgress || {});
      setProfileLoaded(true);
    }).catch((error) => { if (!controller.signal.aborted) setPageError(error instanceof Error ? error.message : 'Could not load your saved profile.'); });
    return () => controller.abort();
  }, [status?.authenticated, status?.user]);

  useEffect(() => {
    if (!status?.authenticated) return;
    const controller = new AbortController();
    void request<Section[]>('/api/plex/sections', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setSections(result); }).catch(error => { if (!controller.signal.aborted) setPageError(error.message); });
    return () => controller.abort();
  }, [status?.authenticated]);

  useEffect(() => {
    if (!['movies', 'tv'].includes(tab)) return;
    const wantedType = tab === 'movies' ? 'movie' : 'show';
    setActiveSection(current => sections.some(section => section.key === current && section.type === wantedType) ? current : sections.find(section => section.type === wantedType)?.key || '');
  }, [sections, tab]);

  const loadPage = useCallback(async (sectionId: string, offset = 0, append = false) => {
    if (!sectionId) return;
    const generation = ++libraryRequest.current;
    if (!append) { setItems([]); setTotal(0); setStart(0); }
    setLoading(true);
    setPageError('');
    try {
      const page = await request<{ items: Item[]; total: number; start: number }>(`/api/plex/libraries/${sectionId}?start=${offset}&size=60`);
      if (generation !== libraryRequest.current) return;
      setItems((current) => append ? [...current, ...page.items] : page.items);
      setTotal(page.total);
      setStart(page.start + page.items.length);
    } catch (error) {
      if (generation !== libraryRequest.current) return;
      setPageError(error instanceof Error ? error.message : 'Could not load your Plex library.');
    } finally { if (generation === libraryRequest.current) setLoading(false); }
  }, []);

  useEffect(() => {
    if (status?.authenticated && ['movies', 'tv'].includes(tab) && activeSection && sections.find(section => section.key === activeSection)?.type === (tab === 'movies' ? 'movie' : 'show')) {
      setShow(null); setSeason(null); setEpisodes([]);
      void loadPage(activeSection);
    }
    return () => { libraryRequest.current++; };
  }, [status?.authenticated, tab, activeSection, loadPage, sections]);

  useEffect(() => {
    if (!status?.authenticated || tab !== 'live') return;
    const controller = new AbortController();
    setLoading(true); setPageError(''); setChannels([]); setChannelTotal(0); setChannelStart(0);
    const timer = window.setTimeout(() => {
      void request<{ items: Channel[]; total: number; start: number }>(`/api/tv/channels?start=0&size=100&query=${encodeURIComponent(channelSearch.trim())}`, { signal: controller.signal }).then((result) => {
        setChannels(result.items); setChannelTotal(result.total); setChannelStart(result.start + result.items.length);
      }).catch((error) => { if (!controller.signal.aborted) setPageError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, channelSearch.trim() ? 250 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [status?.authenticated, tab, channelSearch]);

  useEffect(() => {
    if (tab !== 'live') return;
    const timer = window.setInterval(() => setEpgNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [tab]);

  useEffect(() => {
    const onRemoteKey = async (event: Event) => {
      const remote = (event as CustomEvent<{ key?: string; action?: string }>).detail;
      if (remote?.action !== 'down' || !['ChannelUp', 'ChannelDown'].includes(remote.key || '') || tab !== 'live' || !playback?.live || !playback.channelUuid || channelSwitchBusy.current) return;
      channelSwitchBusy.current = true;
      try {
        let allChannels = channels;
        if (allChannels.length < channelTotal) {
          const loaded: Channel[] = [];
          for (let offset = 0; offset < channelTotal; offset += 250) {
            const page = await request<{ items: Channel[]; total: number }>(`/api/tv/channels?start=${offset}&size=250`);
            loaded.push(...page.items);
            if (!page.items.length || loaded.length >= page.total) break;
          }
          if (loaded.length) allChannels = loaded;
        }
        const ordered = [...allChannels].sort((a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
        const current = ordered.findIndex(channel => channel.uuid === playback.channelUuid);
        if (ordered.length && current >= 0) {
          const step = remote.key === 'ChannelUp' ? 1 : -1;
          void startLive(ordered[(current + step + ordered.length) % ordered.length]);
        }
      } catch (error) {
        setPageError(error instanceof Error ? error.message : 'Could not change channel.');
      } finally {
        channelSwitchBusy.current = false;
      }
    };
    window.addEventListener('tv-remote-key', onRemoteKey);
    return () => window.removeEventListener('tv-remote-key', onRemoteKey);
  }, [tab, playback, channels, channelTotal]);

  useEffect(() => {
    if (!status?.authenticated || tab !== 'live') return;
    const controller = new AbortController();
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const updated: Channel[] = [];
        let count = 0;
        for (let offset = 0; offset < Math.max(100, channelStart); offset += 250) {
          const page = await request<{ items: Channel[]; total: number }>(`/api/tv/channels?start=${offset}&size=${Math.min(250, Math.max(100, channelStart) - offset)}&query=${encodeURIComponent(channelSearch.trim())}`, { signal: controller.signal });
          updated.push(...page.items); count = page.total;
          if (page.items.length === 0 || updated.length >= count) break;
        }
        if (!controller.signal.aborted) { setChannels(updated); setChannelTotal(count); setEpgNow(Date.now()); }
      } catch (error) { if (!controller.signal.aborted) setPageError(error instanceof Error ? error.message : 'Could not refresh the guide.'); }
      finally { refreshing = false; }
    };
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [status?.authenticated, tab, channelStart, channelSearch]);

  useEffect(() => {
    if (!status?.authenticated || tab !== 'music' || musicSearch.trim().length >= 2 || musicAlbumOpen) return;
    const controller = new AbortController();
    setMusicLoading(true);
    void request<{ albums: MusicAlbum[]; nextStart: number; hasMore: boolean }>('/api/music/albums', { signal: controller.signal })
      .then((result) => { setMusicAlbums(result.albums); setMusicNextStart(result.nextStart); setMusicHasMore(result.hasMore); })
      .catch((error) => { if (!controller.signal.aborted) setPageError(error instanceof Error ? error.message : 'Could not load music.'); })
      .finally(() => { if (!controller.signal.aborted) setMusicLoading(false); });
    return () => controller.abort();
  }, [status?.authenticated, tab, musicSearch.trim().length < 2, musicAlbumOpen]);

  useEffect(() => {
    if (!status?.authenticated || tab !== 'music') return;
    if (musicAlbumOpen) return;
    if (musicSearch.trim().length < 2) { setMusicTracks([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setMusicLoading(true);
      void request<{ albums: MusicAlbum[]; tracks: MusicTrack[] }>(`/api/music/search?query=${encodeURIComponent(musicSearch.trim())}`, { signal: controller.signal })
        .then((result) => { setMusicAlbums(result.albums); setMusicTracks(result.tracks); })
        .catch((error) => { if (!controller.signal.aborted) setPageError(error instanceof Error ? error.message : 'Music search failed.'); })
        .finally(() => { if (!controller.signal.aborted) setMusicLoading(false); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [status?.authenticated, tab, musicSearch, musicAlbumOpen]);

  useEffect(() => {
    if (!['tv', 'movies'].includes(tab) || search.trim().length < 2) {
      setSeriesLibraryResults([]); setSeerrResults([]); setSeriesSearchError(''); setSeriesSearchLoading(false);
      return;
    }
    setSeriesLibraryResults([]); setSeerrResults([]); setSeriesSearchLoading(true); setSeriesSearchError('');
    const plexType = tab === 'tv' ? 'show' : 'movie';
    const seerrType = tab === 'tv' ? 'tv' : 'movie';
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSeriesSearchLoading(true); setSeriesSearchError('');
      const searches: Promise<unknown>[] = [request<Item[]>(`/api/plex/search?type=${plexType}&query=${encodeURIComponent(search.trim())}`, { signal: controller.signal })];
      if (status?.seerr.configured) searches.push(request<{ results: SeerrShow[] }>(`/api/seerr/search?type=${seerrType}&query=${encodeURIComponent(search.trim())}`, { signal: controller.signal }));
      void Promise.allSettled(searches).then(([plexResult, seerrResult]) => {
        if (controller.signal.aborted) return;
        if (plexResult.status === 'fulfilled') setSeriesLibraryResults(plexResult.value as Item[]);
        else setSeriesSearchError(plexResult.reason instanceof Error ? plexResult.reason.message : 'Plex series search failed.');
        if (seerrResult) {
          if (seerrResult.status === 'fulfilled') setSeerrResults((seerrResult.value as { results: SeerrShow[] }).results);
          else setSeriesSearchError(seerrResult.reason instanceof Error ? seerrResult.reason.message : 'Seerr series search failed.');
        } else setSeerrResults([]);
      }).finally(() => { if (!controller.signal.aborted) setSeriesSearchLoading(false); });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [tab, search, status?.seerr.configured]);

  useEffect(() => {
    if (tab !== 'youtube' || youtubeView !== 'search' || youtubeSearch.trim().length < 2) { setYoutubeResults([]); setYoutubeLoading(false); return; }
    setYoutubeResults([]); setYoutubeLoading(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setYoutubeLoading(true);
      void request<{ results: YouTubeResult[] }>(`/api/youtube/search?query=${encodeURIComponent(youtubeSearch.trim())}`, { signal: controller.signal })
        .then((result) => setYoutubeResults(result.results))
        .catch((error) => { if (!controller.signal.aborted) setPageError(error instanceof Error ? error.message : 'Invidious search failed.'); })
        .finally(() => { if (!controller.signal.aborted) setYoutubeLoading(false); });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [tab, youtubeSearch, youtubeView]);

  useEffect(() => {
    if (tab !== 'youtube' || !youtubeVideo) { setYoutubeComments([]); setYoutubeCommentsError(''); setYoutubeCommentsLoading(false); return; }
    const controller = new AbortController();
    setYoutubeComments([]); setYoutubeCommentsError(''); setYoutubeCommentsLoading(true);
    void request<{ comments: YouTubeComment[] }>(`/api/youtube/comments/${encodeURIComponent(youtubeVideo.id)}`, { signal: controller.signal })
      .then((result) => setYoutubeComments(result.comments))
      .catch((error) => { if (!controller.signal.aborted) setYoutubeCommentsError(error instanceof Error ? error.message : 'Comments are unavailable.'); })
      .finally(() => { if (!controller.signal.aborted) setYoutubeCommentsLoading(false); });
    return () => controller.abort();
  }, [tab, youtubeVideo?.id]);

  useEffect(() => {
    if (tab !== 'youtube' || youtubeView !== 'channel' || !youtubeChannel) { setYoutubeChannelVideos([]); setYoutubeChannelLoading(false); return; }
    const controller = new AbortController();
    setYoutubeChannelVideos([]); setYoutubeChannelLoading(true);
    void request<{ results: YouTubeResult[] }>(`/api/youtube/channel/${encodeURIComponent(youtubeChannel.id)}`, { signal: controller.signal })
      .then((result) => setYoutubeChannelVideos(result.results))
      .catch((error) => { if (!controller.signal.aborted) setPageError(error instanceof Error ? error.message : 'Could not load this creator’s videos.'); })
      .finally(() => { if (!controller.signal.aborted) setYoutubeChannelLoading(false); });
    return () => controller.abort();
  }, [tab, youtubeView, youtubeChannel?.id]);

  useEffect(() => {
    if (tab !== 'youtube' || youtubeView !== 'subscriptions' || subscriptions.length === 0) { setYoutubeFeed([]); setYoutubeFeedLoading(false); setYoutubeFeedError(''); return; }
    const controller = new AbortController();
    setYoutubeFeed([]); setYoutubeFeedError(''); setYoutubeFeedLoading(true);
    void (async () => {
      const lists: YouTubeResult[][] = new Array(subscriptions.length);
      let cursor = 0;
      let failures = 0;
      const worker = async () => {
        while (!controller.signal.aborted) {
          const index = cursor++;
          if (index >= subscriptions.length) return;
          const creator = subscriptions[index];
          try { lists[index] = (await request<{ results: YouTubeResult[] }>(`/api/youtube/channel/${encodeURIComponent(creator.id)}`, { signal: controller.signal })).results; }
          catch { lists[index] = []; if (!controller.signal.aborted) failures++; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, subscriptions.length) }, () => worker()));
      if (controller.signal.aborted) return;
      setYoutubeFeed(lists.flat().sort((a, b) => (b.published || 0) - (a.published || 0)).slice(0, 60));
      if (failures === subscriptions.length) setYoutubeFeedError('Could not load any creator feeds from Invidious. Try again in a moment.');
      else if (failures > 0) setYoutubeFeedError(`${failures} creator feed${failures === 1 ? '' : 's'} could not be loaded.`);
      setYoutubeFeedLoading(false);
    })();
    return () => controller.abort();
  }, [tab, youtubeView, subscriptions]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query ? items.filter((item) => `${item.title} ${item.year || ''} ${item.summary || ''}`.toLocaleLowerCase().includes(query)) : items;
  }, [items, search]);

  const seriesSearchEntries = useMemo<SeriesSearchEntry[]>(() => {
    const norm = normalizeMediaTitle;
    const expectedType = tab === 'tv' ? 'show' : 'movie';
    const plex = seriesLibraryResults.filter((entry) => entry.type === expectedType);
    const used = new Set<string>();
    const entries: SeriesSearchEntry[] = seerrResults.map((candidate) => {
      const candidateTitle = norm(candidate.title);
      const match = plex.find((item) => !used.has(item.ratingKey) && norm(item.title) === candidateTitle && (!candidate.year || !item.year || Number(candidate.year) === item.year)) || null;
      if (match) used.add(match.ratingKey);
      return { key: `seerr-${candidate.id}`, seerr: candidate, plex: match };
    });
    for (const item of plex) if (!used.has(item.ratingKey)) entries.push({ key: `plex-${item.ratingKey}`, seerr: null, plex: item });
    return entries;
  }, [seriesLibraryResults, seerrResults, tab]);

  async function openShow(item: Item, knownSeerr?: SeerrShow | null) {
    const controller = beginDetail();
    setPageError(''); setLoading(true); setShow(item); setSeasons([]); setSeason(null); setEpisodes([]); setRequestSeasonDetails(null); setRequestSeasonPlexEpisodes([]);
    setRequestSeries(knownSeerr || null); setRequestSeriesDetails(null); setRequestSeriesPlexItem(item); setRequestSeriesPlexSeasons([]);
    try {
      const plexSeasons = await request<Item[]>(`/api/plex/metadata/${item.ratingKey}/children`);
      if (controller.signal.aborted) return;
      setSeasons(plexSeasons); setRequestSeriesPlexSeasons(plexSeasons);
      if (!status?.seerr.configured) return;
      let match = knownSeerr || null;
      if (!match) {
        const { results } = await request<{ results: SeerrShow[] }>(`/api/seerr/search?type=tv&query=${encodeURIComponent(item.title)}`);
        if (controller.signal.aborted) return;
        match = results.find((entry) => normalizeMediaTitle(entry.title) === normalizeMediaTitle(item.title) && (!entry.year || !item.year || Number(entry.year) === item.year)) || null;
      }
      if (!match) return;
      setRequestSeries(match);
      const details = await request<SeerrSeriesDetails>(`/api/seerr/tv/${match.id}`);
      if (!controller.signal.aborted) setRequestSeriesDetails(details);
    } catch (error) { if (controller.signal.aborted) return; setPageError(error instanceof Error ? error.message : 'Could not load series from Plex and Seerr.'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }

  async function openSeason(item: Item) {
    const controller = beginDetail();
    setPageError(''); setSeason(item); setRequestSeasonDetails(null); setRequestSeasonPlexEpisodes([]); setLoading(true);
    try { const result = await request<Item[]>(`/api/plex/metadata/${item.ratingKey}/children`); if (!controller.signal.aborted) setEpisodes(result); }
    catch (error) { if (controller.signal.aborted) return; setPageError(error instanceof Error ? error.message : 'Could not load episodes.'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }

  async function startPlayback(item: Item, room?: WatchRoom) {
    const generation = ++playbackRequest.current;
    setPageError(''); setLoading(true);
    try {
      const result = await request<{ mode: 'direct' | 'hls'; url: string; streamId?: string; live?: boolean; durationSeconds?: number; subtitles?: PlayerSource['subtitles'] }>(`/api/plex/play/${item.ratingKey}`, { method: 'POST' });
      if (generation !== playbackRequest.current) { if (result.streamId) void fetch(`/api/streams/${result.streamId}`, { method: 'DELETE' }).catch(() => {}); return; }
      setYoutubeVideo(null);
      const saved = mediaProgress[item.ratingKey];
      const initialTime = room ? room.position : saved ? saved.seconds : Math.round((item.viewOffset || 0) / 1000);
      setMovieDetails(null); playbackPosition.current = initialTime;
      setPlayback({ ...result, title: item.title, itemKey: item.ratingKey, initialTime, roomId: room?.id, onPosition: (seconds) => { playbackPosition.current = seconds; }, onProgress: (seconds, duration, closing) => saveMediaProgress(item.ratingKey, seconds, duration, closing) });
    } catch (error) { if (generation !== playbackRequest.current) return; setPageError(error instanceof Error ? error.message : 'Could not start playback.'); if (room) throw error; }
    finally { if (generation === playbackRequest.current) setLoading(false); }
  }

  async function joinWatchalong(room: WatchRoom) {
    const item = await request<Item>(`/api/plex/metadata/${room.itemKey}`);
    const joined = await request<WatchRoom>(`/api/watchalong/${room.id}/join`, { method: 'POST' });
    await startPlayback(item, joined);
  }

  function inviteFromPlayback() {
    if (!playback?.itemKey) return;
    setInviteItem({ ratingKey: playback.itemKey, type: 'movie', title: playback.title });
  }

  const saveMediaProgress = useCallback((ratingKey: string, seconds: number, duration: number, keepalive = false) => {
    const savedSeconds = duration > 0 && seconds / duration >= 0.95 ? 0 : seconds;
    setMediaProgress((current) => ({ ...current, [ratingKey]: { seconds: savedSeconds, duration, updatedAt: Date.now() } }));
    void request(`/api/profile/progress/${encodeURIComponent(ratingKey)}`, { method: 'PUT', keepalive, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seconds, duration }) }).catch(() => {});
  }, []);

  async function startLive(channel: Channel) {
    const generation = ++playbackRequest.current;
    setPageError(''); setLoading(true);
    try {
      const result = await request<{ mode: 'hls'; url: string; streamId: string; live: boolean; title: string }>(`/api/tv/play/${encodeURIComponent(channel.uuid)}`, { method: 'POST' });
      if (generation !== playbackRequest.current) { void fetch(`/api/streams/${result.streamId}`, { method: 'DELETE' }).catch(() => {}); return; }
      setYoutubeVideo(null);
      setPlayback({ ...result, title: channel.name, channelUuid: channel.uuid });
    } catch (error) { if (generation !== playbackRequest.current) return; setPageError(error instanceof Error ? error.message : 'Could not start this channel.'); }
    finally { if (generation === playbackRequest.current) setLoading(false); }
  }

  async function playMusic(track: MusicTrack) {
    const generation = ++playbackRequest.current;
    setPageError('');
    try {
      const result = await request<{ url: string; contentType: string }>(`/api/music/stream/${encodeURIComponent(track.id)}`);
      if (generation !== playbackRequest.current) return;
      setYoutubeVideo(null);
      setMusicPlaying(track.id);
      setPlayback({ mode: 'direct', url: result.url, contentType: result.contentType || track.contentType || 'audio/mpeg', title: `${track.title} · ${track.artist}`, audio: true, musicTrackId: track.id });
    } catch (error) { if (generation !== playbackRequest.current) return; setPageError(error instanceof Error ? error.message : 'Could not play this track.'); }
  }

  async function openAlbum(album: MusicAlbum) {
    const controller = beginDetail();
    setPageError(''); setMusicLoading(true); setMusicSearch(''); setMusicAlbumOpen(true);
    try {
      const result = await request<{ tracks: MusicTrack[] }>(`/api/music/album/${encodeURIComponent(album.id)}`);
      if (controller.signal.aborted) return;
      setMusicTracks(result.tracks);
    } catch (error) { if (controller.signal.aborted) return; setPageError(error instanceof Error ? error.message : 'Could not load this album.'); }
    finally { if (!controller.signal.aborted) setMusicLoading(false); }
  }

  async function loadMoreAlbums() {
    if (musicLoading || !musicHasMore) return;
    setMusicLoading(true);
    try {
      const result = await request<{ albums: MusicAlbum[]; nextStart: number; hasMore: boolean }>(`/api/music/albums?start=${musicNextStart}`);
      setMusicAlbums((current) => [...current, ...result.albums.filter((album) => !current.some((entry) => entry.id === album.id))]);
      setMusicNextStart(result.nextStart); setMusicHasMore(result.hasMore);
    } catch (error) { setPageError(error instanceof Error ? error.message : 'Could not load more albums.'); }
    finally { setMusicLoading(false); }
  }

  async function loadMoreChannels() {
    if (channelLoadingMore || channelStart >= channelTotal) return;
    setChannelLoadingMore(true);
    try {
      const result = await request<{ items: Channel[]; total: number; start: number }>('/api/tv/channels?start=' + channelStart + '&size=100&query=' + encodeURIComponent(channelSearch.trim()));
      setChannels((current) => [...current, ...result.items.filter((entry) => !current.some((existing) => existing.uuid === entry.uuid))]);
      setChannelTotal(result.total); setChannelStart(result.start + result.items.length);
    } catch (error) { setPageError(error instanceof Error ? error.message : 'Could not load more channels.'); }
    finally { setChannelLoadingMore(false); }
  }

  async function signOut() {
    setProfileLoaded(false); setMovieDetails(null); setInviteItem(null); setPlayback(null); setYoutubeVideo(null);
    setSubscriptions([]); setWatchlist([]); setWatchedVideoIds([]); setMediaProgress({});
    setYoutubeResults([]); setYoutubeFeed([]); setYoutubeChannel(null); setYoutubeChannelVideos([]);
    await request('/api/auth/logout', { method: 'POST' });
    setStatus((current) => current ? { ...current, authenticated: false, user: null } : current);
    setSections([]); setItems([]); setChannels([]); setShow(null);
  }

  async function openRequestSeries(show: SeerrShow, plexItem: Item | null) {
    const controller = beginDetail();
    setPageError(''); setRequestSeries(show); setRequestSeriesDetails(null); setRequestSeriesPlexItem(plexItem);
    setRequestSeriesPlexSeasons([]); setRequestSeasonDetails(null); setRequestSeasonPlexEpisodes([]);
    try {
      const tasks: Promise<unknown>[] = [request<SeerrSeriesDetails>(`/api/seerr/tv/${show.id}`)];
      if (plexItem) tasks.push(request<Item[]>(`/api/plex/metadata/${plexItem.ratingKey}/children`));
      const [details, plexSeasons] = await Promise.all(tasks);
      if (controller.signal.aborted) return;
      setRequestSeriesDetails(details as SeerrSeriesDetails);
      if (plexSeasons) setRequestSeriesPlexSeasons(plexSeasons as Item[]);
    } catch (error) { if (controller.signal.aborted) return; setPageError(error instanceof Error ? error.message : 'Could not load series availability.'); }
  }

  async function openRequestSeason(seasonInfo: SeerrSeason) {
    const controller = beginDetail();
    if (!requestSeries) return;
    setRequestSeasonLoading(true); setRequestSeasonDetails(null); setRequestSeasonPlexEpisodes([]);
    try {
      const plexSeason = requestSeriesPlexSeasons.find((item) => item.index === seasonInfo.seasonNumber);
      const tasks: Promise<unknown>[] = [request<SeerrSeasonDetails>(`/api/seerr/tv/${requestSeries.id}/season/${seasonInfo.seasonNumber}`)];
      if (plexSeason) tasks.push(request<Item[]>(`/api/plex/metadata/${plexSeason.ratingKey}/children`));
      const [details, plexEpisodes] = await Promise.all(tasks);
      if (controller.signal.aborted) return;
      setRequestSeasonDetails(details as SeerrSeasonDetails);
      if (plexEpisodes) setRequestSeasonPlexEpisodes(plexEpisodes as Item[]);
      else setRequestSeasonPlexEpisodes([]);
      if (show) {
        setSeason(plexSeason || { ratingKey: '', type: 'season', title: seasonInfo.name, index: seasonInfo.seasonNumber });
        setEpisodes((plexEpisodes as Item[] | undefined) || []);
      }
    } catch (error) { if (controller.signal.aborted) return; setPageError(error instanceof Error ? error.message : 'Could not compare season episodes.'); }
    finally { if (!controller.signal.aborted) setRequestSeasonLoading(false); }
  }

  async function requestSeason(seasonInfo: SeerrSeason) {
    if (!requestSeries) return;
    setRequestingSeason(seasonInfo.seasonNumber); setPageError('');
    try {
      await request('/api/seerr/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaId: requestSeries.id, seasons: [seasonInfo.seasonNumber] }) });
      setRequestedSeasonKeys((current) => [...new Set([...current, `${requestSeries.id}:${seasonInfo.seasonNumber}`])]);
      setSeerrResults((current) => current.map((entry) => entry.id === requestSeries.id ? { ...entry, requestStatus: 2 } : entry));
    } catch (error) { setPageError(error instanceof Error ? error.message : 'Could not request this season.'); }
    finally { setRequestingSeason(null); }
  }

  async function requestEpisode(seasonNumber: number, episodeNumber: number) {
    if (!requestSeries) return;
    const key = `${requestSeries.id}:${seasonNumber}:${episodeNumber}`;
    setRequestingEpisodeKey(key); setPageError('');
    try {
      await request(`/api/seerr/tv/${requestSeries.id}/season/${seasonNumber}/episode/${episodeNumber}/request`, { method: 'POST' });
      setRequestedEpisodeKeys((current) => [...new Set([...current, key])]);
    } catch (error) { setPageError(error instanceof Error ? error.message : 'Could not request this episode.'); }
    finally { setRequestingEpisodeKey(null); }
  }

  async function requestMovie(movie: SeerrShow) {
    setRequestingSeason(movie.id); setPageError('');
    try {
      await request('/api/seerr/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaType: 'movie', mediaId: movie.id }) });
      setSeerrResults((current) => current.map((entry) => entry.id === movie.id ? { ...entry, requestStatus: 2 } : entry));
    } catch (error) { setPageError(error instanceof Error ? error.message : 'Could not request this movie.'); }
    finally { setRequestingSeason(null); }
  }

  async function playYoutube(video: YouTubeResult) {
    youtubeRouteGeneration.current++;
    setBrowserPath(`/youtube/watch?v=${encodeURIComponent(video.id)}`);
    setTab('youtube'); setDirectYouTubeRoute(null);
    const generation = ++playbackRequest.current;
    setPageError(''); setLoading(true);
    try {
      const playback = await request<Omit<YouTubeVideo, 'authorId' | 'thumbnail' | 'publishedText' | 'viewCountText' | 'published'>>(`/api/youtube/video/${encodeURIComponent(video.id)}`);
      if (generation !== playbackRequest.current) return;
      setPlayback(null);
      setYoutubeVideo({ ...video, ...playback });
    } catch (error) { if (generation !== playbackRequest.current) return; setPageError(error instanceof Error ? error.message : 'Could not start this video.'); }
    finally { if (generation === playbackRequest.current) setLoading(false); }
  }

  function openYoutubeChannel(id: string | null, name: string) {
    if (!id) return;
    youtubeRouteGeneration.current++;
    setBrowserPath(`/youtube/channel/${encodeURIComponent(id)}`);
    setTab('youtube'); setDirectYouTubeRoute(null);
    setYoutubeChannel({ id, name }); setYoutubeVideo(null); setYoutubeView('channel');
  }

  async function openYoutubeHandle(handle: string) {
    const generation = ++youtubeRouteGeneration.current;
    setYoutubeView('channel'); setYoutubeChannel(null); setYoutubeVideo(null); setPageError(''); setLoading(true);
    try {
      const creator = await request<CreatorSubscription>(`/api/youtube/resolve-channel?handle=${encodeURIComponent(handle)}`);
      if (generation === youtubeRouteGeneration.current) setYoutubeChannel(creator);
    } catch (error) {
      if (generation === youtubeRouteGeneration.current) setPageError(error instanceof Error ? error.message : `Could not find YouTube creator @${handle}.`);
    } finally { if (generation === youtubeRouteGeneration.current) setLoading(false); }
  }

  useEffect(() => {
    if (!status?.authenticated) return;
    if (!directYouTubeRoute) { handledDirectRoute.current = ''; return; }
    const route = directYouTubeRoute;
    const key = route.kind === 'video' ? `video:${route.id}` : route.kind === 'handle' ? `handle:${route.handle}` : `channel:${route.id}`;
    if (handledDirectRoute.current === key) return;
    handledDirectRoute.current = key;
    setDirectYouTubeRoute(null);
    setTab('youtube');
    if (route.kind === 'video') {
      setYoutubeView('search');
      void playYoutube({ id: route.id, title: 'YouTube video', author: '', authorId: null, durationSeconds: 0, thumbnail: null, publishedText: '', viewCountText: '' });
    } else if (route.kind === 'handle') {
      setBrowserPath(`/youtube/@${encodeURIComponent(route.handle)}`);
      void openYoutubeHandle(route.handle);
    } else {
      openYoutubeChannel(route.id, route.id);
    }
  }, [status?.authenticated, directYouTubeRoute]);

  async function toggleSubscription(creator: CreatorSubscription) {
    if (!profileLoaded || profilePending.current.has(creator.id)) return;
    profilePending.current.add(creator.id);
    const removing = subscriptions.some(entry => entry.id === creator.id);
    try {
      await request('/api/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(removing ? { subscriptionRemove: creator.id } : { subscriptionAdd: creator }) });
      setSubscriptions(current => removing ? current.filter(entry => entry.id !== creator.id) : [...current.filter(entry => entry.id !== creator.id), creator]);
    } catch (error) { setPageError(error instanceof Error ? error.message : 'Could not save subscription.'); }
    finally { profilePending.current.delete(creator.id); }
  }

  async function toggleWatchlist(video: YouTubeResult) {
    if (!profileLoaded || profilePending.current.has(video.id)) return;
    profilePending.current.add(video.id);
    const removing = watchlist.some(entry => entry.id === video.id);
    try {
      await request('/api/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(removing ? { watchlistRemove: video.id } : { watchlistAdd: video }) });
      setWatchlist(current => removing ? current.filter(entry => entry.id !== video.id) : [...current.filter(entry => entry.id !== video.id), video]);
    } catch (error) { setPageError(error instanceof Error ? error.message : 'Could not save watchlist.'); }
    finally { profilePending.current.delete(video.id); }
  }

  async function importWatchHistory(file: File) {
    setPageError('');
    try {
      if (file.size > 1_000_000) throw new Error('Choose a history JSON file smaller than 1 MB.');
      const data = JSON.parse(await file.text());
      const rows = Array.isArray(data) ? data : data.watch_history || data.watchedVideoIds;
      if (!Array.isArray(rows)) throw new Error('Choose an Invidious export or YouTube watch-history JSON file.');
      const ids = rows.flatMap((entry: unknown) => {
        const raw = typeof entry === 'string' ? entry : typeof entry === 'object' && entry ? (entry as { videoId?: string; titleUrl?: string; url?: string }).videoId || (entry as { titleUrl?: string; url?: string }).titleUrl || (entry as { url?: string }).url : '';
        if (!raw || typeof raw !== 'string') return [];
        let id = raw;
        try { const url = new URL(raw); id = url.searchParams.get('v') || (url.hostname === 'youtu.be' ? url.pathname.slice(1) : ''); } catch { /* plain video identifier */ }
        return /^[A-Za-z0-9_-]{11}$/.test(id) ? [id] : [];
      });
      const incoming = [...new Set<string>(ids)].slice(-2000);
      if (!incoming.length) throw new Error('No valid watched video identifiers were found in that file.');
      await request('/api/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watchedVideoIds: incoming }) });
      const profile = await request<ProfileData>('/api/profile');
      setWatchedVideoIds(profile.watchedVideoIds);
    } catch (error) { setPageError(error instanceof Error ? error.message : 'Could not import watch history.'); }
  }

  const markYoutubeSeen = useCallback((videoId: string, keepalive = false) => {
    void request(`/api/profile/watched/${encodeURIComponent(videoId)}`, { method: 'PUT', keepalive }).catch(() => {});
    setWatchedVideoIds((current) => current.includes(videoId) ? current : [...current, videoId].slice(-2000));
  }, []);

  function youtubeCard(video: YouTubeResult) {
    const isSaved = watchlist.some((entry) => entry.id === video.id);
    const isSeen = watchedVideoIds.includes(video.id);
    return <article className="youtube-card" key={video.id}><button className="youtube-card-main" onClick={() => void playYoutube(video)}><div className="youtube-poster">{video.thumbnail && <img src={video.thumbnail} alt="" loading="lazy" />}<span className="youtube-play">▶</span>{isSeen && <span className="youtube-seen-badge">✓ Seen</span>}</div><strong>{video.title}</strong><span className="media-meta">{video.author}{video.durationSeconds ? ` · ${durationLabel(video.durationSeconds * 1000)}` : ''}</span><span className="media-meta">{video.viewCountText}{video.publishedText ? ` · ${video.publishedText}` : ''}</span></button><div className="youtube-card-actions"><button className="creator-link" onClick={() => openYoutubeChannel(video.authorId, video.author)} disabled={!video.authorId}>More from {video.author} →</button><button className="watchlist-action" onClick={() => toggleWatchlist(video)}>{isSaved ? 'Saved ✓' : '+ Watchlist'}</button></div></article>;
  }

  const onSignedIn = useCallback((user: string) => {
    setStatus((current) => current ? { ...current, authenticated: true, user } : current);
    setPageError('');
  }, []);

  if (!status) return <div className="boot-screen"><span className="spinner" /> Connecting to your media servers…</div>;
  if (!status.authenticated) return <PlexGate siteName={siteName} onSignedIn={onSignedIn} />;

  const currentSection = sections.find((section) => section.key === activeSection);
  const currentItems = season ? episodes : filtered;
  const featuredItem = currentItems.find((item) => item.art && item.summary) || currentItems.find((item) => item.thumb) || null;
  const continueItems = currentItems.filter((item) => { const seconds = mediaProgress[item.ratingKey]?.seconds ?? (item.viewOffset || 0) / 1000; return seconds > 5 && Boolean(item.duration) && seconds * 1000 < (item.duration || 0) * .95; });
  const epgStart = Math.floor(epgNow / 1_800_000) * 1_800_000;
  const epgEnd = epgStart + 4 * 60 * 60 * 1000;
  const epgWidth = 960;
  const epgTicks = Array.from({ length: 9 }, (_, index) => epgStart + index * 30 * 60 * 1000);
  const filteredChannels = channels.filter((channel) => !channelSearch.trim() || `${channel.number || ''} ${channel.name}`.toLocaleLowerCase().includes(channelSearch.trim().toLocaleLowerCase()));
  const showSeasonEntries: ShowSeasonEntry[] = (() => {
    if (!show) return [];
    const result: ShowSeasonEntry[] = (requestSeriesDetails?.seasons || []).filter((entry) => entry.seasonNumber >= 0 && entry.episodeCount > 0).map((entry) => ({
      seasonNumber: entry.seasonNumber, name: entry.name, episodeCount: entry.episodeCount,
      plexItem: requestSeriesPlexSeasons.find((plexSeason) => plexSeason.index === entry.seasonNumber) || null, seerr: entry,
    }));
    for (const plexSeason of seasons) if (!result.some((entry) => entry.seasonNumber === plexSeason.index)) result.push({
      seasonNumber: plexSeason.index || 0, name: plexSeason.title, episodeCount: plexSeason.leafCount || 0, plexItem: plexSeason, seerr: null,
    });
    return result.sort((a, b) => a.seasonNumber - b.seasonNumber);
  })();
  const showEpisodeEntries: Array<SeerrEpisode & { plexItem: Item | null }> = (() => {
    if (!show || !requestSeasonDetails) return [];
    const result = requestSeasonDetails.episodes.map((entry) => ({ ...entry, plexItem: requestSeasonPlexEpisodes.find((item) => item.index === entry.episodeNumber) || null }));
    for (const item of requestSeasonPlexEpisodes) if (!result.some((entry) => entry.episodeNumber === item.index)) result.push({
      episodeNumber: item.index || 0, title: item.title, overview: item.summary || '', airDate: '', runtime: null, plexItem: item,
    });
    return result.sort((a, b) => a.episodeNumber - b.episodeNumber);
  })();

  return (
    <div className={`app-shell ${playback?.audio ? "has-music-dock" : ""}`}>
      <div className="ambient ambient-one" /><div className="ambient ambient-two" />
      <header className="topbar">
        <a className="brand" href="#top"><span>{siteName}</span></a>
        <nav className="main-nav" aria-label="Media sections">
          <button className={tab === 'music' ? 'active' : ''} onClick={() => navigateSection('music')}>Music</button>
          <button className={tab === 'movies' ? 'active' : ''} onClick={() => navigateSection('movies')}>Movies</button>
          <button className={tab === 'tv' ? 'active' : ''} onClick={() => navigateSection('tv')}>Series</button>
          <button className={tab === 'live' ? 'active' : ''} onClick={() => navigateSection('live')}>Live TV <span className="nav-live-dot" /></button>
          <button className={tab === 'youtube' ? 'active' : ''} onClick={() => navigateSection('youtube')}>YouTube</button>
        </nav>
        <div className="top-actions">
          <div className={`header-search ${searchExpanded ? 'expanded' : ''}`}>
            <label className="header-search-field">
              <span className="sr-only">{headerSearchPlaceholder}</span>
              <input ref={headerSearchRef} value={headerSearchValue} onChange={(event) => updateHeaderSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setSearchExpanded(false); event.currentTarget.blur(); } }} placeholder={headerSearchPlaceholder} aria-label={headerSearchPlaceholder} autoComplete="off" tabIndex={searchExpanded ? 0 : -1} />
            </label>
            <button className="header-search-toggle" type="button" aria-label={searchExpanded ? 'Close search' : 'Open search'} aria-expanded={searchExpanded} onClick={() => { setSearchExpanded((expanded) => !expanded); if (tab === 'youtube') setYoutubeView('search'); }}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.6" /><path d="m16 16 4.2 4.2" /></svg>
            </button>
          </div>
          <NotificationBell onJoin={joinWatchalong} /><div className="user-menu" title={`Signed in as ${status.user || 'Plex user'}`}><span className="user-avatar">{(status.user || 'P').slice(0, 1).toUpperCase()}</span><button onClick={signOut}>{status.user || 'Plex'}<span className="chevron">⌄</span></button></div>
        </div>
      </header>

      <main id="top" className="page-content">
        {tab === 'youtube' ? (
          <section className="youtube-section">
            <div className="youtube-subnav"><button className={youtubeView === 'search' ? 'active' : ''} onClick={() => { setBrowserPath('/youtube'); setYoutubeVideo(null); setYoutubeView('search'); }}>Search</button><button className={youtubeView === 'subscriptions' ? 'active' : ''} onClick={() => { setBrowserPath('/youtube'); setYoutubeVideo(null); setYoutubeView('subscriptions'); }}>Subscriptions <span>{subscriptions.length}</span></button><button className={youtubeView === 'watchlist' ? 'active' : ''} onClick={() => { setBrowserPath('/youtube'); setYoutubeVideo(null); setYoutubeView('watchlist'); }}>Watchlist <span>{watchlist.length}</span></button></div>
            <label className="history-import">Import watch history<input type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importWatchHistory(file); event.target.value = ''; }} /></label>
            {youtubeVideo ? <>
              <button className="back-link youtube-back" onClick={() => { setBrowserPath(youtubeView === 'channel' && youtubeChannel ? `/youtube/channel/${encodeURIComponent(youtubeChannel.id)}` : '/youtube'); setYoutubeVideo(null); }}>← Back to {youtubeView === 'search' ? 'search' : youtubeView === 'channel' ? youtubeChannel?.name : 'videos'}</button>
              <div className="youtube-watch-layout"><div className="youtube-watch-main">
                <Suspense fallback={<div className="player-loading"><span className="spinner" /> Loading player…</div>}><Player key={youtubeVideo.id} source={{ mode: youtubeVideo.mode, url: youtubeVideo.streamUrl, contentType: youtubeVideo.contentType, durationSeconds: youtubeVideo.durationSeconds, subtitles: youtubeVideo.captions, onProgress: (seconds, duration, closing) => { if (duration > 0 && seconds / duration >= 0.8) markYoutubeSeen(youtubeVideo.id, closing); } }} /></Suspense>
                <h2 className="youtube-video-title">{youtubeVideo.title}</h2>
                <div className="youtube-video-author"><button className="creator-link" onClick={() => openYoutubeChannel(youtubeVideo.authorId, youtubeVideo.author)}>{youtubeVideo.author} · View channel and videos →</button>{youtubeVideo.authorId && <button className="subscribe-button" onClick={() => toggleSubscription({ id: youtubeVideo.authorId!, name: youtubeVideo.author })}>{subscriptions.some((item) => item.id === youtubeVideo.authorId) ? 'Subscribed ✓' : 'Subscribe'}</button>}</div>
                {youtubeVideo.description && <p className="youtube-description">{youtubeVideo.description}</p>}
                <section className="youtube-comments"><h3>Comments <span>{youtubeComments.length ? youtubeComments.length : ''}</span></h3>{youtubeCommentsError ? <p className="seerr-hint">{youtubeCommentsError}</p> : youtubeCommentsLoading ? <p className="seerr-hint">Loading comments…</p> : youtubeComments.length === 0 ? <p className="seerr-hint">No comments available.</p> : youtubeComments.map((comment, index) => <YouTubeCommentThread key={`${youtubeVideo.id}-${comment.id || index}`} videoId={youtubeVideo.id} comment={comment} />)}</section>
              </div><aside className="youtube-related"><h3>Related videos</h3>{youtubeVideo.related.map((video) => <button className="related-video" key={video.id} onClick={() => void playYoutube(video)}><span className="related-thumb">{video.thumbnail && <img src={video.thumbnail} alt="" loading="lazy" />}{watchedVideoIds.includes(video.id) && <span className="youtube-seen-badge" aria-label="Watched">✓</span>}</span><span><strong>{video.title}</strong><small>{video.author}{video.viewCountText ? ` · ${video.viewCountText}` : ''}</small></span></button>)}</aside></div>
            </> : youtubeView === 'search' ? <>
              {youtubeLoading && <p className="seerr-hint">Searching YouTube through Invidious…</p>}
              {youtubeSearch.trim().length < 2 ? <p className="seerr-hint">Search videos through Invidious.</p> : youtubeResults.length === 0 && !youtubeLoading ? <EmptyState title="No videos found" text="Try another search." /> : <div className="media-grid youtube-grid">{youtubeResults.map(youtubeCard)}</div>}
            </> : youtubeView === 'channel' ? youtubeChannel ? <>
              <button className="back-link youtube-back" onClick={() => { setBrowserPath('/youtube'); setYoutubeChannel(null); setYoutubeView('subscriptions'); }}>← Back</button><div className="channel-heading"><div><span className="eyebrow">YOUTUBE CREATOR</span><h2>{youtubeChannel.name}</h2></div><button className="subscribe-button" onClick={() => toggleSubscription(youtubeChannel)}>{subscriptions.some((item) => item.id === youtubeChannel.id) ? 'Subscribed ✓' : 'Subscribe'}</button></div>
              {youtubeChannelVideos.length ? <div className="media-grid youtube-grid">{youtubeChannelVideos.map(youtubeCard)}</div> : <p className="seerr-hint">{youtubeChannelLoading ? 'Loading creator videos…' : 'No recent videos found.'}</p>}
            </> : <p className="seerr-hint">{loading ? 'Looking up this YouTube creator…' : 'The creator page could not be loaded.'}</p> : youtubeView === 'watchlist' ? <>
              <div className="channel-heading"><div><span className="eyebrow">SAVED VIDEOS</span><h2>Watchlist</h2></div><span className="item-count">{watchlist.length} VIDEOS</span></div>
              {watchlist.length ? <div className="media-grid youtube-grid">{watchlist.map(youtubeCard)}</div> : <EmptyState title="Your watchlist is empty" text="Save videos from search results, creator pages, and your subscriptions to watch later." />}
            </> : subscriptions.length === 0 ? <EmptyState title="No subscriptions yet" text="Subscribe to creators from a video or channel page. Their latest videos will appear here." /> : <>
              <div className="channel-heading"><div><span className="eyebrow">LATEST UPLOADS</span><h2>Subscriptions</h2></div><span className="item-count">{subscriptions.length} CREATORS</span></div>
              <div className="creator-chips">{subscriptions.map((creator) => <button key={creator.id} onClick={() => openYoutubeChannel(creator.id, creator.name)}>{creator.name}<span>→</span></button>)}</div>
              {youtubeFeed.length ? <div className="media-grid youtube-grid">{youtubeFeed.map(youtubeCard)}</div> : <p className="seerr-hint">{youtubeFeedLoading ? 'Loading your subscribed creators’ latest videos…' : youtubeFeedError || 'No recent uploads found.'}</p>}{youtubeFeedError && youtubeFeed.length > 0 && <p className="seerr-hint">{youtubeFeedError}</p>}
            </>}
          </section>
        ) : null}

        {tab === 'music' && <section className="music-section">
          {musicAlbumOpen && <button className="back-link" onClick={() => { detailRequest.current?.abort(); setMusicAlbumOpen(false); setMusicTracks([]); }}>← All albums</button>}
          {!status?.navidrome.configured && <EmptyState title="Music server is not configured" text="Set the Navidrome server and login in the app’s server environment." />}
          {musicSearch.trim().length >= 2 && musicAlbums.length > 0 && <><div className="section-heading music-results-heading"><div><span className="eyebrow">MATCHING ALBUMS</span></div></div><div className="media-grid music-grid">{musicAlbums.map((album) => <button className="music-album" key={album.id} onClick={() => void openAlbum(album)}><div className="music-album-cover">{album.coverArt ? <img src={`/api/music/cover/${encodeURIComponent(album.coverArt)}`} alt="" loading="lazy" /> : <span>♪</span>}</div><strong>{album.name}</strong><span className="media-meta">{album.artist}{album.year ? ` · ${album.year}` : ''}</span></button>)}</div></>}
          {musicTracks.length > 0 && <div className="music-track-list">{musicTracks.map((track, index) => <button className={`music-track ${musicPlaying === track.id ? 'playing' : ''}`} key={track.id} onClick={() => void playMusic(track)}><span className="music-track-number">{index + 1}</span>{track.coverArt ? <img src={`/api/music/cover/${encodeURIComponent(track.coverArt)}`} alt="" loading="lazy" /> : <span className="music-cover-placeholder">♪</span>}<span className="music-track-info"><strong>{track.title}</strong><small>{track.artist} · {track.album}</small></span><span className="music-duration">{track.duration ? durationLabel(track.duration * 1000) : ''}</span><span className="music-play">▶</span></button>)}</div>}
          {musicLoading && <p className="seerr-hint">Loading music…</p>}
          {!musicSearch.trim() && musicTracks.length === 0 && <><div className="section-heading"><div><span className="eyebrow">YOUR COLLECTION</span><h2>Albums</h2></div></div>{musicAlbums.length ? <div className="media-grid music-grid">{musicAlbums.map((album) => <button className="music-album" key={album.id} onClick={() => void openAlbum(album)}><div className="music-album-cover">{album.coverArt ? <img src={`/api/music/cover/${encodeURIComponent(album.coverArt)}`} alt="" loading="lazy" /> : <span>♪</span>}</div><strong>{album.name}</strong><span className="media-meta">{album.artist}{album.year ? ` · ${album.year}` : ''}</span></button>)}</div> : !musicLoading && <EmptyState title="No albums found" text="Navidrome did not return any albums." />}</>}
          {!musicAlbumOpen && musicSearch.trim().length < 2 && musicHasMore && <div className="load-more"><button onClick={() => void loadMoreAlbums()} disabled={musicLoading}>{musicLoading ? 'Loading…' : 'Load more albums'}</button></div>}
          {musicSearch.trim().length >= 2 && musicTracks.length === 0 && musicAlbums.length === 0 && !musicLoading && <EmptyState title="No matching tracks" text="Try another search." />}
        </section>}

        {tab !== 'live' && tab !== 'youtube' && !show && sections.filter((section) => section.type === (tab === 'movies' ? 'movie' : 'show')).length > 1 && (
          <div className="library-row"><div className="section-caption">LIBRARY</div><select value={activeSection} onChange={(event) => setActiveSection(event.target.value)}>{sections.filter((section) => section.type === (tab === 'movies' ? 'movie' : 'show')).map((section) => <option key={section.key} value={section.key}>{section.title}</option>)}</select></div>
        )}

        {pageError && <div className="error-banner page-error">{pageError}<button onClick={() => setPageError('')}>×</button></div>}

        {tab === 'youtube' || tab === 'music' ? null : tab === 'live' ? (
          <>
            {playback?.live && <section className="live-watch" aria-label="Live TV player">
              <header className="live-watch-head"><div><span className="live-dot" /><strong>{playback.title}</strong><span>Live</span></div><button className="icon-button" onClick={stopLivePlayback} aria-label="Close live TV player">×</button></header>
              <div className="video-frame"><Suspense fallback={<div className="player-loading"><span className="spinner" /> Loading channel…</div>}><Player key={playback.streamId} source={playback} /></Suspense></div>
            </section>}
            <div className="epg-toolbar"><span className="epg-date">{new Date(epgNow).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span></div>
            <section className="epg-scroll" aria-label="TV programme guide"><div className="epg-grid" style={{ '--epg-width': `${epgWidth}px` } as React.CSSProperties}><div className="epg-head"><div className="epg-channel-head">CHANNEL</div><div className="epg-time-head">{epgTicks.map((tick) => <span key={tick} style={{ left: `${((tick - epgStart) / (epgEnd - epgStart)) * 100}%` }}>{new Date(tick).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>)}</div></div>{filteredChannels.map((channel) => <div className="epg-row" key={channel.uuid}><button className="epg-channel" onClick={() => void startLive(channel)} title={`Watch ${channel.name}`}>{channel.logo ? <img src={channel.logo} alt="" loading="lazy" /> : <span className="epg-logo-placeholder">{channel.name.slice(0, 2).toUpperCase()}</span>}<span><strong>{channel.number ? `${channel.number}. ` : ''}{channel.name}</strong><small>{channel.current?.title || 'No current programme'}</small></span><span className="epg-tune">▶</span></button><div className="epg-programs">{channel.programmes?.map((program) => { const left = Math.max(0, (program.start * 1000 - epgStart) / (epgEnd - epgStart) * 100); const right = Math.min(100, (program.stop * 1000 - epgStart) / (epgEnd - epgStart) * 100); if (right <= left) return null; return <button className={`epg-program ${program.start * 1000 <= epgNow && program.stop * 1000 > epgNow ? 'epg-current' : ''}`} key={`${channel.uuid}-${program.eventId || program.start}`} style={{ left: `${left}%`, width: `${right - left}%` }} title={`${program.title}${program.subtitle ? ` — ${program.subtitle}` : ''}`} onClick={() => void startLive(channel)}><strong>{program.title}</strong><small>{new Date(program.start * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} – {new Date(program.stop * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small></button>; })}</div></div>)}{channels.length === 0 && !loading && <p className="seerr-hint">{channelSearch.trim() ? 'No matching channels.' : 'No channels found in TVHeadend.'}</p>}</div></section>
            {channelStart < channelTotal && <div className="load-more"><button onClick={() => void loadMoreChannels()} disabled={channelLoadingMore}>{channelLoadingMore ? 'Loading…' : `Load more channels (${channelStart} of ${channelTotal})`}</button></div>}
          </>
        ) : requestSeries && requestSeriesDetails && !show ? (
          <section className="detail-view request-series-view">
            <button className="back-link" onClick={() => { detailRequest.current?.abort(); setLoading(false); setRequestSeries(null); setRequestSeriesDetails(null); setRequestSeasonDetails(null); }}>← Back to series search</button>
            <div className="detail-hero">
              {(requestSeriesDetails.backdropPath || requestSeriesDetails.posterPath) && <img src={`https://image.tmdb.org/t/p/w780${requestSeriesDetails.backdropPath || requestSeriesDetails.posterPath}`} alt="" />}
              <div className="detail-shade" /><div className="detail-copy"><div className="eyebrow">{requestSeriesDetails.firstAirDate?.slice(0, 4) || 'TV SERIES'} · SEERR AVAILABILITY</div><h2>{requestSeriesDetails.title}</h2><p>{requestSeriesDetails.overview || 'Check episodes against your Plex library and request missing seasons.'}</p><span className="detail-count">{requestSeriesPlexItem ? 'MATCHED TO PLEX LIBRARY' : 'NOT IN PLEX LIBRARY'}</span></div>
            </div>
            <div className="section-heading"><div><span className="eyebrow">EPISODE AVAILABILITY</span><h2>{requestSeasonDetails ? requestSeasonDetails.name : 'Seasons'}</h2></div>{requestSeasonDetails && <button className="text-button" onClick={() => setRequestSeasonDetails(null)}>All seasons</button>}</div>
            {requestSeasonDetails ? <>
              <p className="request-season-note">Request the full season, or request individual missing episodes.</p>
              <button className="request-season-action show-request-action" onClick={() => void requestSeason({ seasonNumber: requestSeasonDetails.seasonNumber, name: requestSeasonDetails.name, episodeCount: requestSeasonDetails.episodes.length, overview: '', posterPath: null, airDate: null })} disabled={requestingSeason === requestSeasonDetails.seasonNumber || requestedSeasonKeys.includes(`${requestSeries.id}:${requestSeasonDetails.seasonNumber}`) || Boolean(requestSeriesDetails?.requestedSeasons?.includes(requestSeasonDetails.seasonNumber))}>{requestingSeason === requestSeasonDetails.seasonNumber ? 'Requesting…' : requestedSeasonKeys.includes(`${requestSeries.id}:${requestSeasonDetails.seasonNumber}`) || Boolean(requestSeriesDetails?.requestedSeasons?.includes(requestSeasonDetails.seasonNumber)) ? 'Season already requested' : 'Request full season'}</button>
              {requestSeasonLoading ? <p className="seerr-hint">Checking episodes…</p> : <div className="request-episode-list">{requestSeasonDetails.episodes.map((episode) => {
                const inLibrary = requestSeasonPlexEpisodes.some((plexEpisode) => plexEpisode.index === episode.episodeNumber);
                return <div className={`request-episode ${inLibrary ? 'available' : 'missing'}`} key={`${requestSeasonDetails.seasonNumber}-${episode.episodeNumber}`}><span className="request-episode-number">{String(episode.episodeNumber).padStart(2, '0')}</span><div><strong>{episode.title}</strong><p>{episode.overview || episode.airDate || 'Episode details provided by Seerr.'}</p></div><span className="availability-badge">{inLibrary ? 'In Plex' : 'Missing'}</span>{!inLibrary && <button className="episode-request-action" onClick={() => void requestEpisode(requestSeasonDetails.seasonNumber, episode.episodeNumber)} disabled={requestingEpisodeKey === `${requestSeries.id}:${requestSeasonDetails.seasonNumber}:${episode.episodeNumber}` || requestedEpisodeKeys.includes(`${requestSeries.id}:${requestSeasonDetails.seasonNumber}:${episode.episodeNumber}`)}>{requestedEpisodeKeys.includes(`${requestSeries.id}:${requestSeasonDetails.seasonNumber}:${episode.episodeNumber}`) ? 'Requested' : requestingEpisodeKey === `${requestSeries.id}:${requestSeasonDetails.seasonNumber}:${episode.episodeNumber}` ? 'Requesting…' : 'Request episode'}</button>}</div>;
              })}</div>}
            </> : requestSeriesDetails.seasons.filter((entry) => entry.seasonNumber >= 0 && entry.episodeCount > 0).length === 0 ? <EmptyState title="No seasons listed" text="Seerr did not return season details for this series." /> : <div className="media-grid season-grid request-poster-grid">{requestSeriesDetails.seasons.filter((entry) => entry.seasonNumber >= 0 && entry.episodeCount > 0).map((seasonInfo) => {
              const plexSeason = requestSeriesPlexSeasons.find((entry) => entry.index === seasonInfo.seasonNumber);
              const presentCount = Math.min(plexSeason?.leafCount || 0, seasonInfo.episodeCount);
              const missingCount = Math.max(0, seasonInfo.episodeCount - presentCount);
              const requestKey = `${requestSeries.id}:${seasonInfo.seasonNumber}`;
              const posterItem: Item = plexSeason || { ratingKey: requestKey, type: 'season', title: seasonInfo.name, thumb: seasonInfo.posterPath ? `https://image.tmdb.org/t/p/w500${seasonInfo.posterPath}` : requestSeriesDetails.posterPath ? `https://image.tmdb.org/t/p/w500${requestSeriesDetails.posterPath}` : null };
              return <article className="season-poster-entry" key={requestKey}><MediaCard item={posterItem} onClick={() => void openRequestSeason(seasonInfo)} /><span className={`season-poster-status ${missingCount ? 'missing-text' : 'available-text'}`}>{seasonInfo.episodeCount} episodes · {missingCount ? `${missingCount} missing` : 'Complete in Plex'}</span></article>;
            })}</div>}
          </section>
        ) : show ? (
          <section className="detail-view">
            <button className="back-link" onClick={() => { detailRequest.current?.abort(); setLoading(false); setShow(null); setSeason(null); setEpisodes([]); setRequestSeries(null); setRequestSeriesDetails(null); setRequestSeriesPlexSeasons([]); setRequestSeasonDetails(null); setRequestSeasonPlexEpisodes([]); }}>← Back to {tab === 'tv' ? 'series' : 'movies'}</button>
            <div className="detail-hero">
              {(show.art || show.thumb) && <img src={show.art || show.thumb || ''} alt="" />}
              <div className="detail-shade" />
              <div className="detail-copy"><div className="eyebrow">{show.year || 'SERIES'} · {requestSeriesDetails ? 'PLEX LIBRARY + SEERR' : show.contentRating || 'PLEX LIBRARY'}</div><h2>{season ? season.title : show.title}</h2><p>{season?.summary || show.summary || requestSeriesDetails?.overview || 'Choose a season to browse episodes.'}</p><span className="detail-count">{season ? `${requestSeasonDetails?.episodes.length ?? episodes.length} EPISODES` : `${showSeasonEntries.length || seasons.length} SEASONS`}</span><RottenTomatoes item={show} /></div>
            </div>
            {showSeasonEntries.length > 0 && <><div className="section-heading"><div><span className="eyebrow">{requestSeriesDetails ? 'PLEX + SEERR AVAILABILITY' : 'YOUR NEXT BINGE'}</span><h2>{season ? 'Episodes' : 'Seasons'}</h2></div>{season && <button className="text-button" onClick={() => { setSeason(null); setEpisodes([]); setRequestSeasonDetails(null); setRequestSeasonPlexEpisodes([]); }}>All seasons</button>}</div>
              {season ? requestSeasonDetails ? <>
                <p className="request-season-note">Request the whole season through Seerr, or request individual missing episodes through Sonarr.</p>
                <button className="request-season-action show-request-action" onClick={() => void requestSeason({ seasonNumber: requestSeasonDetails.seasonNumber, name: requestSeasonDetails.name, episodeCount: requestSeasonDetails.episodes.length, overview: '', posterPath: null, airDate: null })} disabled={requestingSeason === requestSeasonDetails.seasonNumber || requestedSeasonKeys.includes(`${requestSeries?.id}:${requestSeasonDetails.seasonNumber}`) || Boolean(requestSeriesDetails?.requestedSeasons?.includes(requestSeasonDetails.seasonNumber))}>{requestingSeason === requestSeasonDetails.seasonNumber ? 'Requesting…' : requestedSeasonKeys.includes(`${requestSeries?.id}:${requestSeasonDetails.seasonNumber}`) || Boolean(requestSeriesDetails?.requestedSeasons?.includes(requestSeasonDetails.seasonNumber)) ? 'Season already requested' : 'Request full season'}</button>
                <div className="episode-list">{showEpisodeEntries.map((episode) => {
                  const plexEpisode = episode.plexItem;
                  return <div className={`episode-row ${plexEpisode ? '' : 'missing-episode-row'}`} key={`${requestSeasonDetails.seasonNumber}-${episode.episodeNumber}`}>
                    {plexEpisode ? <MediaCard item={plexEpisode} compact progress={mediaProgress[plexEpisode.ratingKey]?.seconds ?? Math.round((plexEpisode.viewOffset || 0) / 1000)} onClick={() => void startPlayback(plexEpisode)} /> : <span className="request-episode-number">{String(episode.episodeNumber).padStart(2, '0')}</span>}
                    <div className="episode-copy"><strong>{String(episode.episodeNumber).padStart(2, '0')}. {episode.title}</strong><p>{episode.overview || episode.airDate || (plexEpisode ? 'Ready when you are.' : 'Not found in your Plex library.')}</p></div>
                    <span className={`availability-badge ${plexEpisode ? '' : 'missing-badge'}`}>{plexEpisode ? 'In Plex · Play' : 'Missing'}</span>
                    {!plexEpisode && <button className="episode-request-action" onClick={() => void requestEpisode(requestSeasonDetails.seasonNumber, episode.episodeNumber)} disabled={!requestSeries || requestingEpisodeKey === `${requestSeries.id}:${requestSeasonDetails.seasonNumber}:${episode.episodeNumber}`}>
                      {requestedEpisodeKeys.includes(`${requestSeries?.id}:${requestSeasonDetails.seasonNumber}:${episode.episodeNumber}`) ? 'Requested' : requestingEpisodeKey === `${requestSeries?.id}:${requestSeasonDetails.seasonNumber}:${episode.episodeNumber}` ? 'Requesting…' : 'Request episode'}
                    </button>}
                    {plexEpisode && <button className="watchalong-button" aria-label={`Watchalong: ${episode.title}`} onClick={() => setInviteItem(plexEpisode)}>Watchalong</button>}{plexEpisode && <button className="episode-play" aria-label={`Play ${episode.title}`} onClick={() => void startPlayback(plexEpisode)}>▶</button>}
                  </div>;
                })}</div>
              </> : <div className="episode-list">{episodes.map((episode) => <div className="episode-row" key={episode.ratingKey}><MediaCard item={episode} compact progress={mediaProgress[episode.ratingKey]?.seconds ?? Math.round((episode.viewOffset || 0) / 1000)} onClick={() => void startPlayback(episode)} /><div className="episode-copy"><strong>{episode.index ? `${episode.index}. ` : ''}{episode.title}</strong><p>{episode.summary || 'Ready when you are.'}</p></div><button className="watchalong-button" aria-label={`Watchalong: ${episode.title}`} onClick={() => setInviteItem(episode)}>Watchalong</button><button className="episode-play" onClick={() => void startPlayback(episode)}>▶</button></div>)}</div>
                : requestSeriesDetails ? <div className="media-grid season-grid request-poster-grid">{showSeasonEntries.map((entry) => {
                  const plexCount = Math.min(entry.plexItem?.leafCount || 0, entry.episodeCount);
                  const missingCount = Math.max(0, entry.episodeCount - plexCount);
                  const posterUrl = entry.plexItem?.thumb || (entry.seerr?.posterPath ? `https://image.tmdb.org/t/p/w500${entry.seerr.posterPath}` : null);
                  const posterItem: Item = entry.plexItem || { ratingKey: `season-${requestSeries?.id}-${entry.seasonNumber}`, type: 'season', title: entry.name, year: entry.episodeCount, thumb: posterUrl };
                  return <article className="season-poster-entry" key={`${requestSeries?.id}:${entry.seasonNumber}`}><MediaCard item={{ ...posterItem, thumb: posterUrl }} onClick={() => entry.seerr ? void openRequestSeason(entry.seerr) : entry.plexItem && void openSeason(entry.plexItem)} /><span className={`season-poster-status ${missingCount ? 'missing-text' : 'available-text'}`}>{missingCount ? `${missingCount} missing` : 'Complete in Plex'}</span></article>;
                })}</div> : <div className="media-grid season-grid">{seasons.map((seasonItem) => <MediaCard key={seasonItem.ratingKey} item={seasonItem} onClick={() => void openSeason(seasonItem)} />)}</div>}
            </>}
          </section>
        ) : (
          <>
            {['tv', 'movies'].includes(tab) && search.trim().length >= 2 ? <>
              <div className="shelf-heading"><div><span className="eyebrow">PLEX LIBRARY + SEERR</span><h2>{tab === 'tv' ? 'Series' : 'Movie'} search results</h2></div><span className="item-count">{seriesSearchEntries.length ? `${seriesSearchEntries.length} MATCHES` : ''}</span></div>
              {!status.seerr.configured && <p className="seerr-hint">Seerr is not connected, so this search shows Plex {tab === 'tv' ? 'series' : 'movies'} only.</p>}
              {seriesSearchLoading && <p className="seerr-hint">Searching Plex and Seerr…</p>}
              {seriesSearchError && <p className="error-banner">{seriesSearchError}</p>}
              {!seriesSearchLoading && seriesSearchEntries.length === 0 ? <EmptyState title="No series found" text="Try another title." /> : <div className="media-grid series-search-grid">{seriesSearchEntries.map((entry) => <article className="series-result-card" key={entry.key}>
                <button className="series-result-poster" aria-label={`View ${entry.plex?.title || entry.seerr?.title}`} onClick={() => { if (entry.plex) { if (tab === 'tv') void openShow(entry.plex, entry.seerr); else setMovieDetails(entry.plex); } else if (entry.seerr && tab === 'tv') void openRequestSeries(entry.seerr, null); }} disabled={!entry.plex && tab === 'movies'}>{entry.plex?.thumb ? <img src={entry.plex.thumb} alt="" loading="lazy" /> : entry.seerr?.posterPath ? <img src={`https://image.tmdb.org/t/p/w342${entry.seerr.posterPath}`} alt="" loading="lazy" /> : <div className="poster-placeholder"><span>HC</span></div>}<span className="series-result-badge">{entry.plex ? 'IN PLEX' : 'REQUEST'}</span></button>
                <strong>{entry.plex?.title || entry.seerr?.title}</strong><span className="media-meta">{entry.plex?.year || entry.seerr?.year || 'TV series'}</span>
                {entry.plex && <button className="series-result-action" onClick={() => tab === 'tv' ? void openShow(entry.plex!, entry.seerr) : setMovieDetails(entry.plex!)}>{tab === 'tv' ? 'Browse library + missing episodes' : 'View details'}</button>}
                {entry.seerr && tab === 'tv' && !entry.plex && <button className="series-result-action secondary" onClick={() => void openRequestSeries(entry.seerr!, null)}>Browse seasons / request</button>}
                {entry.seerr && tab === 'movies' && <button className="series-result-action secondary" onClick={() => void requestMovie(entry.seerr!)} disabled={Boolean(entry.plex) || entry.seerr.status === 5 || entry.seerr.requestStatus != null || requestingSeason === entry.seerr.id}>{entry.plex ? 'In Plex' : entry.seerr.status === 5 ? 'Available' : entry.seerr.requestStatus != null ? 'Already requested' : requestingSeason === entry.seerr.id ? 'Requesting…' : 'Request movie'}</button>}
              </article>)}</div>}
            </> : <>
            {!search && featuredItem && <section className="browse-feature" aria-label={`Featured: ${featuredItem.title}`}>
              <img className="browse-feature-art" src={featuredItem.art || featuredItem.thumb || ''} alt="" fetchPriority="high" />
              <div className="browse-feature-shade" />
              <div className="browse-feature-copy"><span className="feature-kind">{tab === 'movies' ? 'Movie' : 'Series'}{featuredItem.year ? ` · ${featuredItem.year}` : ''}{featuredItem.contentRating ? ` · ${featuredItem.contentRating}` : ''}</span><h1>{featuredItem.title}</h1>{featuredItem.summary && <p>{featuredItem.summary}</p>}<button className="feature-play" onClick={() => tab === 'tv' ? void openShow(featuredItem) : void startPlayback(featuredItem)}><span>{tab === 'tv' ? '≡' : '▶'}</span>{tab === 'tv' ? 'View seasons' : (mediaProgress[featuredItem.ratingKey]?.seconds || featuredItem.viewOffset) ? 'Resume' : 'Play'}</button>{tab === 'movies' && <button className="feature-info" onClick={() => setMovieDetails(featuredItem)}>ⓘ More info</button>}</div>
            </section>}
            {!search && continueItems.length > 0 && <section className="browse-shelf"><h2>Continue watching</h2><Carousel>{continueItems.map((item) => <MediaCard key={item.ratingKey} item={item} progress={mediaProgress[item.ratingKey]?.seconds ?? Math.round((item.viewOffset || 0) / 1000)} onClick={() => item.type === 'episode' ? void startPlayback(item) : setMovieDetails(item)} />)}</Carousel></section>}
            {!search && currentItems.length > 6 && <section className="browse-shelf"><h2>{currentSection?.title || 'Your library'}</h2><Carousel>{currentItems.slice(0, 18).map((item) => <MediaCard key={item.ratingKey} item={item} progress={mediaProgress[item.ratingKey]?.seconds ?? Math.round((item.viewOffset || 0) / 1000)} onClick={() => tab === 'tv' ? void openShow(item) : setMovieDetails(item)} />)}</Carousel></section>}
            <div className="shelf-heading"><div><h2>{search ? 'Search results' : tab === 'movies' ? 'All movies' : 'All series'}</h2></div><span className="item-count">{total ? `${total.toLocaleString()} titles` : ''}</span></div>
            {currentItems.length === 0 && !loading ? <EmptyState title={sections.length ? 'Nothing here yet' : 'No Plex libraries found'} text={sections.length ? 'Try another search or check back when your library is ready.' : 'The signed-in Plex account has no movie or show libraries on this server.'} /> : (
              <div className="media-grid">{currentItems.map((item) => <MediaCard key={item.ratingKey} item={item} progress={mediaProgress[item.ratingKey]?.seconds ?? Math.round((item.viewOffset || 0) / 1000)} onClick={() => tab === 'tv' ? void openShow(item) : setMovieDetails(item)} />)}</div>
            )}
            {start < total && <div className="load-more"><button onClick={() => void loadPage(activeSection, start, true)} disabled={loading}>{loading ? 'Loading…' : 'Load more titles'}</button></div>}
            </>}
          </>
        )}
      </main>

      <footer className="app-footer"><span>Copyright (c) 2026 Helio AG Ventures.</span></footer>
      {loading && <div className="loading-toast"><span className="spinner small" /> Getting things ready…</div>}
      {movieDetails && <MovieDetails item={movieDetails} resume={Boolean(mediaProgress[movieDetails.ratingKey]?.seconds || movieDetails.viewOffset)} onClose={() => setMovieDetails(null)} onPlay={(item) => void startPlayback(item)} onWatchalong={setInviteItem} />}
      {playback && !playback.live && <VideoOverlay playback={playback} onWatchalong={inviteFromPlayback} onClose={() => { playbackRequest.current++; setPlayback(null); setMusicPlaying(''); }} />}
      {inviteItem && <WatchalongInvite key={inviteItem.ratingKey} item={inviteItem} position={playback?.itemKey === inviteItem.ratingKey ? playbackPosition.current : mediaProgress[inviteItem.ratingKey]?.seconds || (inviteItem.viewOffset || 0) / 1000} onClose={() => setInviteItem(null)} onCreated={joinWatchalong} />}
    </div>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><div className="empty-icon">⌂</div><h3>{title}</h3><p>{text}</p></div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
