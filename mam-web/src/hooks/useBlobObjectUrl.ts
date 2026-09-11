import { useEffect, useRef, useState } from 'react';
import { authHeader } from '../api/nuxeoClient';

/**
 * Fetches a Nuxeo blob URL (e.g. a `NuxeoBlob.data` download link) with the
 * app's `Authorization: Bearer` header and exposes it as a local `blob:`
 * object URL — the same pattern `Thumbnail.tsx` uses for rendition
 * thumbnails, generalized so `<video src>`/download links can use it too
 * (neither can carry a custom `Authorization` header on their own, so the
 * bytes must be fetched here first).
 *
 * Pass `null`/`undefined` to skip fetching (e.g. while the URL isn't known
 * yet). The object URL is revoked automatically on cleanup/URL change.
 */
export type BlobFetchState = 'idle' | 'loading' | 'ready' | 'error';

export function useBlobObjectUrl(url: string | null | undefined): {
  objectUrl: string | null;
  state: BlobFetchState;
  error: string | null;
} {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [state, setState] = useState<BlobFetchState>(url ? 'loading' : 'idle');
  const [error, setError] = useState<string | null>(null);
  const currentBlobUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!url) {
      setState('idle');
      setObjectUrl(null);
      setError(null);
      return;
    }
    setState('loading');
    setObjectUrl(null);
    setError(null);
    const ac = new AbortController();
    fetch(url, { headers: { ...authHeader() }, signal: ac.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        const objUrl = URL.createObjectURL(blob);
        currentBlobUrl.current = objUrl;
        setObjectUrl(objUrl);
        setState('ready');
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setState('error');
        setError(e instanceof Error ? e.message : 'Failed to load media');
      });
    return () => {
      ac.abort();
      if (currentBlobUrl.current) {
        URL.revokeObjectURL(currentBlobUrl.current);
        currentBlobUrl.current = null;
      }
    };
  }, [url]);

  return { objectUrl, state, error };
}
