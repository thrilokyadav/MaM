import { Video as VideoIcon } from 'lucide-react';
import type { MamDocument, TranscodedVideoItem } from '../types/mam';
import { useBlobObjectUrl } from '../hooks/useBlobObjectUrl';
import { Thumbnail } from './Thumbnail';
import './VideoPlayer.css';

/**
 * Native HTML5 `<video>` playback of a `BroadcastVideo`'s transcoded MP4
 * proxy (`vid:transcodedVideos`, produced by Nuxeo's stock video pipeline —
 * see `nuxeo-platform-video`'s `video.xsd`). Falls back to the poster
 * `Thumbnail` while the proxy is still processing or unavailable.
 *
 * The proxy's blob URL (`content.data`) requires the same `Authorization:
 * Bearer` header as every other API call, so it can't be set directly as
 * `<video src>` — the bytes are fetched once via `useBlobObjectUrl` and
 * played from the resulting local `blob:` URL, exactly like `Thumbnail.tsx`
 * does for poster images.
 */

function pickMp4Proxy(items: TranscodedVideoItem[] | undefined): TranscodedVideoItem | undefined {
  if (!items || items.length === 0) return undefined;
  const mp4 = items.find((i) => (i.content?.['mime-type'] ?? '').toLowerCase().includes('mp4'));
  return mp4 ?? items[0];
}

export function VideoPlayer({ doc }: { doc: MamDocument }) {
  const transcoded = doc.properties?.['vid:transcodedVideos'];
  const proxy = pickMp4Proxy(transcoded);
  const proxyUrl = proxy?.content?.data;

  const { objectUrl, state, error } = useBlobObjectUrl(proxyUrl);

  if (!proxyUrl) {
    return (
      <div className="video-player video-player-fallback">
        <Thumbnail doc={doc} size="large" />
        <p className="detail-note">
          <VideoIcon aria-hidden style={{ width: 14, height: 14 }} />
          No MP4 proxy is available yet. Nuxeo's video pipeline produces this
          automatically once the original upload finishes processing.
        </p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="video-player video-player-fallback">
        <Thumbnail doc={doc} size="large" />
        <p className="detail-note detail-note-error">
          Could not load the proxy video{error ? `: ${error}` : ''}.
        </p>
      </div>
    );
  }

  if (state === 'loading' || !objectUrl) {
    return (
      <div className="video-player video-player-fallback">
        <Thumbnail doc={doc} size="large" />
        <p className="detail-note">Loading proxy video…</p>
      </div>
    );
  }

  return (
    <div className="video-player">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video className="video-player-el" src={objectUrl} controls preload="metadata" />
      {proxy?.name ? <p className="video-player-caption mono">{proxy.name}</p> : null}
    </div>
  );
}
