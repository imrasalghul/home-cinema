import '@videojs/react/video/skin.css';
import '@videojs/react/live-video/skin.css';
import { VideoPlayer, VideoSkin, Video, usePlayer } from '@videojs/react/video';
import { LiveVideoPlayer, LiveVideoSkin } from '@videojs/react/live-video';
import { HlsJsVideo } from '@videojs/react/media/hlsjs-video';
import { DashVideo } from '@videojs/react/media/dash-video';
import { AudioPlayer, AudioSkin, Audio } from '@videojs/react/audio';
import '@videojs/react/audio/skin.css';
import { useEffect, useRef, useState } from 'react';
import { GoogleCast } from '@videojs/react/extensions/google-cast';

export type SubtitleTrack = { src: string; label: string; language: string };
export type PlayerSource = { url: string; mode: 'direct' | 'hls' | 'dash'; contentType?: string; streamId?: string; live?: boolean; audio?: boolean; durationSeconds?: number; subtitles?: SubtitleTrack[]; itemKey?: string; initialTime?: number; roomId?: string; onPosition?: (seconds: number) => void; onProgress?: (seconds: number, duration: number, closing?: boolean) => void };

export default function Player({ source }: { source: PlayerSource }) {
  if (source.live) {
    return <LiveVideoPlayer><LiveVideoSkin className="vjs-skin" style={{ width: '100%', aspectRatio: '16 / 9' }}><CastingMedia source={source} live /></LiveVideoSkin></LiveVideoPlayer>;
  }
  if (source.audio) return <AudioPlayer><AudioSkin><Audio src={source.url} autoPlay preload="auto" /></AudioSkin></AudioPlayer>;
  return <VideoPlayer><VideoSkin className="vjs-skin" style={{ width: '100%', aspectRatio: '16 / 9' }}><CastingMedia source={source} /><PlaybackProgress source={source} /></VideoSkin>{source.roomId && <WatchalongSync roomId={source.roomId} />}</VideoPlayer>;
}

function PlaybackProgress({ source }: { source: PlayerSource }) {
  const store = usePlayer();
  const canPlay = usePlayer((state: any) => state.canPlay);
  const seeked = useRef(false);

  useEffect(() => {
    if (!canPlay || seeked.current || source.roomId) return;
    seeked.current = true;
    if (source.initialTime && source.initialTime > 5) store.seek(source.initialTime);
  }, [canPlay, source.initialTime, store]);

  useEffect(() => {
    const timer = window.setInterval(() => source.onPosition?.(Number(store.state.currentTime) || 0), 500);
    return () => window.clearInterval(timer);
  }, [source.onPosition, store]);

  useEffect(() => {
    if (!source.onProgress) return;
    const save = (closing = false) => {
      const state = store.state;
      const seconds = Number(state.currentTime) || 0;
      const duration = Number(state.duration) || 0;
      if (seconds > 0 && duration > 0) source.onProgress?.(seconds, duration, closing);
    };
    const timer = window.setInterval(() => save(), 10_000);
    const flush = () => save(true);
    const visibility = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', visibility);
    return () => { window.clearInterval(timer); window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', visibility); save(); };
  }, [source.itemKey, source.onProgress, store]);

  return null;
}

function WatchalongSync({ roomId }: { roomId: string }) {
  const store = usePlayer();
  const mediaReady = usePlayer((state: any) => state.canPlay);
  const [message, setMessage] = useState('Connecting to watchalong…');
  const [intent, setIntent] = useState(false);
  const [ended, setEnded] = useState(false);
  const pauseIfAttached = () => { if (store.target && !store.destroyed) store.pause(); };
  const queued = useRef<'play' | 'pause' | 'seek' | undefined>(undefined);
  useEffect(() => {
    let stopped = false;
    let busy = false;
    let initialized = false;
    let suppressUntil = 0;
    let previous = { paused: true, time: 0, at: performance.now() };
    let failures = 0;
    let endedRoom = false;
    let applyingSeek = false;
    let reportedEnd = false;
    const sync = async () => {
      if (busy || stopped || endedRoom) return;
      busy = true;
      const state = store.state;
      const seconds = Number(state.currentTime) || 0;
      const now = performance.now();
      let command = queued.current; queued.current = undefined;
      if (initialized && !applyingSeek && now > suppressUntil && !command) {
        if (state.paused !== previous.paused && !state.waiting && !state.seeking) command = state.paused ? 'pause' : 'play';
        const expected = previous.time + (previous.paused ? 0 : (now - previous.at) / 1000);
        if (Math.abs(seconds - expected) > 1.4) command = 'seek';
        if (state.ended && !reportedEnd) command = 'pause';
        reportedEnd = state.ended;
      }
      previous = { paused: state.paused, time: seconds, at: now };
      const buffered = state.buffered || [];
      const ready = Boolean(!applyingSeek && !state.seeking && !state.waiting && (state.remotePlaybackState === 'connected' || state.canPlay && buffered.some(([start, end]: number[]) => start <= seconds + .2 && end >= Math.min(seconds + 1, Number(state.duration) || seconds + 1))));
      try {
        const sent = performance.now();
        const response = await fetch(`/api/watchalong/${roomId}/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ready, command, position: seconds }), signal: AbortSignal.timeout(4000) });
        const room = await response.json(); if (!response.ok) throw new Error(room.error || 'Watchalong unavailable');
        if (stopped) return;
        failures = 0;
        if (room.ended) { endedRoom = true; setEnded(true); pauseIfAttached(); setMessage('Watchalong ended. Close the player to continue watching on your own.'); return; }
        setIntent(room.intent);
        const target = room.position + (room.playing ? (performance.now() - sent) / 2000 : 0);
        const needsSeek = Boolean(store.target) && state.canPlay && Math.abs(Number(store.state.currentTime) - target) > (room.playing ? .8 : .3);
        if (!applyingSeek && store.target && !store.destroyed && (needsSeek || Boolean(store.state.paused) === room.playing)) {
          suppressUntil = performance.now() + 1200;
          if (room.playing && needsSeek) pauseIfAttached();
          if (needsSeek) {
            applyingSeek = true;
            void store.seek(target).catch(() => { if (!stopped) setMessage('Waiting for the seek to load…'); }).finally(() => {
              applyingSeek = false; suppressUntil = performance.now() + 1200;
              previous = { paused: store.state.paused, time: Number(store.state.currentTime) || 0, at: performance.now() };
            });
          }
          if (stopped || !store.target || store.destroyed) return;
          if (room.playing && ready && !applyingSeek) {
            void store.play().catch(() => { if (!stopped) { queued.current = 'pause'; setMessage('Your browser needs a click: press Play together to start.'); } });
          } else pauseIfAttached();
          previous = { paused: store.state.paused, time: Number(store.state.currentTime) || 0, at: performance.now() };
        }
        if (store.target && !store.destroyed && store.state.playbackRate !== 1) store.setPlaybackRate(1);
        initialized = true;
        const pending = room.members.filter((member: any) => !member.accepted);
        const offline = room.members.filter((member: any) => member.accepted && !member.connected);
        const buffering = room.members.filter((member: any) => member.connected && !member.ready);
        setMessage(pending.length ? `Waiting for ${pending.map((member: any) => member.name).join(', ')} to accept` : offline.length ? `Paused — waiting for ${offline.map((member: any) => member.name).join(', ')} to reconnect` : buffering.length ? `Paused — ${buffering.map((member: any) => member.name).join(', ')} is buffering` : room.playing ? 'Watching together · synchronized' : 'Paused for everyone');
      } catch {
        if (!stopped) { failures++; suppressUntil = performance.now() + 1200; pauseIfAttached(); previous.paused = true; setMessage(failures > 2 ? 'Connection lost — paused for everyone. Reconnecting…' : 'Reconnecting to watchalong…'); if (command) queued.current = command; }
      } finally { busy = false; }
    };
    pauseIfAttached(); void sync();
    const timer = window.setInterval(() => void sync(), 400);
    const leave = () => { void fetch(`/api/watchalong/${roomId}/disconnect`, { method: 'POST', keepalive: true }); };
    window.addEventListener('pagehide', leave);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('pagehide', leave); leave(); };
  }, [roomId, store]);
  return <div className="watchalong-status" role="status"><span>{message}</span><button disabled={ended || !mediaReady} onClick={() => { if (!store.target || store.destroyed) return; queued.current = intent ? 'pause' : 'play'; if (!intent) void store.play().catch(() => {}); else pauseIfAttached(); }}>{intent ? 'Pause together' : 'Play together'}</button><button className="secondary" disabled={ended} onClick={() => { void fetch(`/api/watchalong/${roomId}/leave`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ end: true }) }); }}>End watchalong</button></div>;
}

function CastingMedia({ source, live = false }: { source: PlayerSource; live?: boolean }) {
  const [resolved, setResolved] = useState<PlayerSource | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setResolved(null);
    void fetch('/api/cast', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: source.url, subtitles: source.subtitles || [] }) }).then(async response => {
      const grant = await response.json(); if (!response.ok) throw new Error(grant.error || 'Could not prepare casting.');
      setResolved({ ...source, url: new URL(grant.url, window.location.origin).href, subtitles: grant.subtitles });
    }).catch(() => { if (!controller.signal.aborted) setResolved(source); });
    return () => controller.abort();
  }, [source.url]);
  if (!resolved) return <div className="player-loading"><span className="spinner" /> Preparing player…</div>;
  return <>{live ? <HlsJsVideo className="vjs-media" src={resolved.url} streamType="live" autoPlay playsInline /> : <PlaybackMedia source={resolved} />}<GoogleCast src={resolved.url} contentType={resolved.mode === 'hls' ? 'application/vnd.apple.mpegurl' : resolved.mode === 'dash' ? 'application/dash+xml' : resolved.contentType || 'video/mp4'} streamType={live ? 'live' : 'on-demand'} /></>;
}

function PlaybackMedia({ source }: { source: PlayerSource }) {
  const tracks = source.subtitles?.map((track) => <track key={track.src} kind="subtitles" src={track.src} srcLang={track.language} label={track.label} />);
  if (source.mode === 'dash') return <DashVideo className="vjs-media" source={{ src: source.url }} autoPlay={!source.roomId} playsInline crossOrigin="anonymous">{tracks}</DashVideo>;
  if (source.mode === 'hls') return <HlsJsVideo className="vjs-media" source={{ src: source.url, type: 'application/vnd.apple.mpegurl', engine: { hlsJs: { fragLoadingTimeOut: 120_000 } } }} streamType="on-demand" autoPlay={!source.roomId} playsInline>{tracks}</HlsJsVideo>;
  return <Video className="vjs-media" autoPlay={!source.roomId} playsInline preload="auto" crossOrigin="anonymous"><source src={source.url} type={source.contentType || (source.url.endsWith('.webm') ? 'video/webm' : 'video/mp4')} />{tracks}</Video>;
}
