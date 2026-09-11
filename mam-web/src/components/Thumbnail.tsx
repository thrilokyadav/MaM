import { useEffect, useRef, useState } from 'react';
import { Video, Film, FileText, Image as ImageIcon } from 'lucide-react';
import type { MamDocument } from '../types/mam';
import { authHeader } from '../api/nuxeoClient';
import './Thumbnail.css';

/**
 * Reusable document thumbnail.
 *
 * Reads the ready-to-use rendition URL from `contextParameters.thumbnail.url`
 * (Nuxeo's `thumbnail` document enricher — `ThumbnailJsonEnricher`, backed by
 * `GET /api/v1/id/{uid}/@rendition/thumbnail`). Callers must request that
 * enricher (`enrichers-document: thumbnail` header) when fetching the
 * document; this component never constructs the URL itself.
 *
 * The app authenticates GET requests with an `Authorization: Bearer`
 * header sourced from the current OIDC session (never a URL query
 * parameter — an `<img src>` cannot carry a custom header, so the
 * rendition bytes are fetched here with the same auth header every other
 * API call uses, and rendered via a local `blob:` object URL). No
 * credential ever appears in source-attribute or network-visible URL
 * text.
 */

function monogram(title: string): string {
  const parts = title.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join('') || 'AS';
}

function TypeGlyph({ type }: { type: string }) {
  if (type === 'BroadcastVideo') return <Video aria-hidden="true" />;
  if (type === 'Picture' || type === 'BroadcastImage') return <ImageIcon aria-hidden="true" />;
  if (type === 'File' || type === 'Note') return <FileText aria-hidden="true" />;
  return <Film aria-hidden="true" />;
}

interface ThumbnailProps {
  doc: MamDocument;
  /** Extra class on the outer wrapper. Sizing/aspect-ratio comes from the caller's container class. */
  className?: string;
  /** Larger fallback glyph/monogram, for bigger containers like the asset detail header. */
  size?: 'default' | 'large';
}

type LoadState = 'loading' | 'ready' | 'unavailable';

export function Thumbnail({ doc, className, size = 'default' }: ThumbnailProps) {
  const thumb = doc.contextParameters?.thumbnail as { url?: string } | undefined;
  const thumbnailUrl = thumb?.url;
  const isVideo = doc.type === 'BroadcastVideo';
  const transcodedVideos = doc.properties?.['vid:transcodedVideos'];
  const isProcessed = Array.isArray(transcodedVideos) && transcodedVideos.length > 0;

  const [state, setState] = useState<LoadState>(thumbnailUrl ? 'loading' : 'unavailable');
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const currentBlobUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!thumbnailUrl) {
      setState('unavailable');
      setObjectUrl(null);
      return;
    }
    setState('loading');
    setObjectUrl(null);
    const ac = new AbortController();
    fetch(thumbnailUrl, {
      headers: { ...authHeader() },
      signal: ac.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        currentBlobUrl.current = url;
        setObjectUrl(url);
        setState('ready');
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setState('unavailable');
      });
    return () => {
      ac.abort();
      if (currentBlobUrl.current) {
        URL.revokeObjectURL(currentBlobUrl.current);
        currentBlobUrl.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumbnailUrl]);

  return (
    <div className={`thumb${size === 'large' ? ' thumb-lg' : ''}${className ? ` ${className}` : ''}`}>
      {state === 'ready' && objectUrl ? (
        <img className="thumb-img" src={objectUrl} alt="" />
      ) : null}

      {state !== 'ready' && (
        <div
          className={`thumb-fallback${isVideo ? ' thumb-fallback-video' : ''}`}
          aria-hidden="true"
        >
          {isVideo ? (
            <>
              <Video className="thumb-fallback-icon" />
              {state === 'unavailable' && (
                <span className="thumb-fallback-label">
                  {isProcessed ? 'Preview unavailable' : 'Processing…'}
                </span>
              )}
            </>
          ) : (
            <>
              <span className="thumb-fallback-mono">{monogram(doc.title || 'AS')}</span>
              <span className="thumb-fallback-type">
                <TypeGlyph type={doc.type} />
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
