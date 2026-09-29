import { useEffect, useId, useRef, useState } from 'react';

export type YouTubeComment = { id: string; author: string; authorThumbnail: string | null; publishedText: string; likeCount: number; content: string; replies: number; replyContinuation: string | null };

export default function YouTubeCommentThread({ videoId, comment, depth = 0 }: { videoId: string; comment: YouTubeComment; depth?: number }) {
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [replies, setReplies] = useState<YouTubeComment[]>([]);
  const [continuation, setContinuation] = useState<string | null>(comment.replyContinuation);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const regionId = useId();
  useEffect(() => () => controller.current?.abort(), []);

  async function loadReplies() {
    if (!continuation || controller.current) return;
    const current = new AbortController(); controller.current = current;
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/youtube/comments/${encodeURIComponent(videoId)}?continuation=${encodeURIComponent(continuation)}`, { signal: current.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load replies.');
      if (current.signal.aborted) return;
      setReplies(existing => {
        const unique = new Map(existing.map(reply => [reply.id || `${reply.author}:${reply.publishedText}:${reply.content}`, reply]));
        for (const reply of result.comments as YouTubeComment[]) unique.set(reply.id || `${reply.author}:${reply.publishedText}:${reply.content}`, reply);
        return [...unique.values()];
      });
      setContinuation(result.continuation && result.continuation !== continuation ? result.continuation : null);
      setLoaded(true);
    } catch (reason) {
      if (!current.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load replies.');
    } finally {
      if (!current.signal.aborted) setLoading(false);
      controller.current = null;
    }
  }

  return <article className={`youtube-comment ${depth ? 'youtube-comment-reply' : ''}`}>
    {comment.authorThumbnail ? <img src={comment.authorThumbnail} alt="" loading="lazy" /> : <span className="comment-avatar" aria-hidden="true">{comment.author.slice(0, 1).toUpperCase()}</span>}
    <div><div className="comment-byline"><strong>{comment.author}</strong><span>{comment.publishedText}</span></div><p>{comment.content}</p><small>♥ {comment.likeCount.toLocaleString()}</small>
      {comment.replyContinuation && depth < 8 ? <>
        <button className="comment-replies-toggle" aria-expanded={expanded} aria-controls={regionId} onClick={() => { const next = !expanded; setExpanded(next); if (next && !loaded) void loadReplies(); }}>{expanded ? '▴ Hide replies' : `▾ ${comment.replies.toLocaleString()} ${comment.replies === 1 ? 'reply' : 'replies'}`}</button>
        {expanded && <div id={regionId} className="comment-replies" aria-label={`Replies to ${comment.author}`} aria-busy={loading}>
          {replies.map((reply, index) => <YouTubeCommentThread key={reply.id || index} videoId={videoId} comment={reply} depth={depth + 1} />)}
          {loading && <p className="comment-replies-feedback" role="status">Loading replies…</p>}
          {error && <div className="comment-replies-feedback" role="alert"><p>{error}</p><button className="comment-replies-toggle" onClick={() => void loadReplies()}>Retry</button></div>}
          {loaded && !replies.length && !loading && !error && <p className="comment-replies-feedback">No replies returned for this thread.</p>}
          {loaded && continuation && !loading && !error && <button className="comment-replies-toggle" onClick={() => void loadReplies()}>Load more replies</button>}
        </div>}
      </> : comment.replies > 0 ? <small className="comment-replies-unavailable"> · {comment.replies.toLocaleString()} replies unavailable</small> : null}
    </div>
  </article>;
}
