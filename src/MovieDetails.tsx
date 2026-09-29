import { useEffect, useState } from 'react';
import type { Item } from './main';

export function RottenTomatoes({ item }: { item: Item }) {
  const ratings = [...(item.ratings || [])];
  if (!ratings.some(rating => rating.type === 'critic') && item.ratingImage?.startsWith('rottentomatoes://') && item.rating != null) ratings.push({ type: 'critic', value: item.rating });
  if (!ratings.some(rating => rating.type === 'audience') && item.audienceRatingImage?.startsWith('rottentomatoes://') && item.audienceRating != null) ratings.push({ type: 'audience', value: item.audienceRating });
  return <div className="tomato-ratings">{ratings.length ? ratings.map(rating => <span key={rating.type} title={`Rotten Tomatoes ${rating.type} score`}><span aria-hidden="true">{rating.type === 'audience' ? '🍿' : '🍅'}</span><strong>{Math.round(rating.value * 10)}%</strong><small>Rotten Tomatoes {rating.type === 'audience' ? 'audience' : 'critics'}</small></span>) : <span className="muted">Rotten Tomatoes score unavailable</span>}</div>;
}

export default function MovieDetails({ item, onClose, onPlay, onWatchalong, resume }: { item: Item; onClose: () => void; onPlay: (item: Item) => void; onWatchalong: (item: Item) => void; resume: boolean }) {
  const [details, setDetails] = useState(item);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setDetails(item); setError('');
    void fetch(`/api/plex/metadata/${encodeURIComponent(item.ratingKey)}`, { signal: controller.signal }).then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not load details.'); setDetails(result); }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', keydown);
    const previous = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { controller.abort(); document.removeEventListener('keydown', keydown); document.body.style.overflow = previous; };
  }, [item.ratingKey]);
  return <div className="detail-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="movie-detail-dialog" role="dialog" aria-modal="true" aria-label={`${details.title} details`}><div className="movie-detail-art">{(details.art || details.thumb) && <img src={details.art || details.thumb || ''} alt="" />}<div className="movie-detail-shade" /><button autoFocus className="icon-button movie-detail-close" aria-label="Close movie details" onClick={onClose}>×</button><div className="movie-detail-title"><h2>{details.title}</h2><div className="movie-detail-actions"><button className="feature-play" onClick={() => onPlay(details)}>▶ {resume ? 'Resume' : 'Play'}</button><button className="watchalong-button" onClick={() => onWatchalong(details)}>Watchalong</button></div></div></div><div className="movie-detail-body"><div className="movie-detail-meta">{details.year && <span>{details.year}</span>}{details.contentRating && <span className="content-rating">{details.contentRating}</span>}{details.duration && <span>{Math.floor(details.duration / 3600000)}h {Math.round(details.duration / 60000) % 60}m</span>}</div><RottenTomatoes item={details} /><div className="movie-detail-columns"><div>{details.tagline && <strong>{details.tagline}</strong>}<p>{details.summary || 'No description available.'}</p></div><aside>{details.cast?.length ? <p><span>Cast:</span> {details.cast.join(', ')}</p> : null}{details.directors?.length ? <p><span>Director:</span> {details.directors.join(', ')}</p> : null}{details.genres?.length ? <p><span>Genres:</span> {details.genres.join(', ')}</p> : null}</aside></div>{error && <p role="alert" className="error-banner">{error}</p>}</div></section></div>;
}
