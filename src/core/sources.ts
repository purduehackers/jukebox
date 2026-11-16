// Pure server-side URL parsing. Never fetches; never builds shell commands.
import type { SourceRef } from '../contract/types.ts';
import { PortError } from './ports.ts';

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const NUMERIC_ID = /^\d{1,15}$/;
export const FIXTURE_SOURCES = ['fixture:master', 'fixture:request', 'fixture:song', 'fixture:aac'] as const;

export function canonicalizeUrl(input: unknown): SourceRef {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2048) {
    throw new PortError('INVALID_SOURCE', 'Paste a single YouTube, Spotify, Apple Music, or Deezer track link');
  }
  const raw = input.trim();
  if (/(?:^|\/)(?:\.|%2e){1,2}(?:\/|[?#]|$)/i.test(raw) || /[\\\u0000-\u0020\u007f]/.test(raw) || /^https:\/\/[^/]*:/.test(raw)) throw new PortError('INVALID_SOURCE', 'Use a plain HTTPS track link without a port');
  if ((FIXTURE_SOURCES as readonly string[]).includes(raw)) {
    return { provider: 'fixture', itemId: raw.slice('fixture:'.length), canonicalUrl: raw };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PortError('INVALID_SOURCE', 'That is not a valid link');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new PortError('INVALID_SOURCE', 'Only plain HTTPS track links are supported');
  }
  const authority = /^https:\/\/([^/?#]+)/i.exec(raw)?.[1];
  if (!authority || authority.toLowerCase() !== url.hostname) throw new PortError('INVALID_SOURCE', 'Use a plain provider hostname');
  const host = url.hostname.toLowerCase();

  // Only the content ID matters. Every other query parameter and the fragment are
  // navigation/tracking context (si, drli, utm_*, redirects, #t=...): they are
  // discarded, never validated or forwarded, because the canonical URL is rebuilt
  // from the ID alone.
  let youtube: string | null = null;
  const youtubeHost = ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host);
  if (youtubeHost && host !== 'youtu.be' && url.pathname === '/watch') {
    youtube = url.searchParams.get('v');
  } else if (host === 'youtu.be') {
    youtube = url.pathname.slice(1);
  } else if (youtubeHost && host !== 'youtu.be' && /^\/(?:shorts|live)\/[^/]+$/.test(url.pathname)) {
    youtube = url.pathname.split('/')[2]!;
  }
  if (youtube !== null) {
    if (!YOUTUBE_ID.test(youtube)) throw new PortError('INVALID_SOURCE', 'Invalid YouTube video ID');
    return { provider: 'youtube', itemId: youtube, canonicalUrl: `https://www.youtube.com/watch?v=${youtube}` };
  }
  const spotify = /^\/(?:intl-[a-z]{2}\/)?track\/([^/]+)$/.exec(url.pathname);
  if (host === 'open.spotify.com' && spotify) {
    const id = spotify[1]!;
    if (!SPOTIFY_ID.test(id)) throw new PortError('INVALID_SOURCE', 'Invalid Spotify track ID');
    return { provider: 'spotify', itemId: id, canonicalUrl: `https://open.spotify.com/track/${id}` };
  }
  if (host === 'deezer.com' || host === 'www.deezer.com') {
    // Track URL with optional locale prefix, e.g. /track/<id> or /us/track/<id>.
    // Redirect shorteners (link.deezer.com, deezer.page.link) are not fetched, so
    // they stay unsupported; the canonical form re-parses to itself.
    const deezer = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?track\/([^/]+)$/i.exec(url.pathname);
    if (deezer) {
      if (!NUMERIC_ID.test(deezer[1]!)) throw new PortError('INVALID_SOURCE', 'Invalid Deezer track ID');
      return { provider: 'deezer', itemId: deezer[1]!, canonicalUrl: `https://www.deezer.com/track/${deezer[1]}` };
    }
  }
  if (host === 'music.apple.com') {
    // Album URL with ?i=<trackId> or /song/<slug>/<id>.
    // The service stores `canonicalUrl` and re-parses it for preparation, so the canonical
    // form `/song/<id>` must canonicalize to itself.
    const song = /^\/(?:[a-z]{2}\/)?song\/(?:[^/]+\/)?(\d{1,15})$/.exec(url.pathname);
    const album = /^\/[a-z]{2}\/album\/[^/]+\/\d{1,15}$/.test(url.pathname) ? url.searchParams.get('i') : null;
    if (song && url.searchParams.has('i') && url.searchParams.get('i') !== song[1]) throw new PortError('INVALID_SOURCE', 'Conflicting Apple Music track IDs');
    const id = song?.[1] ?? album;
    if (id && NUMERIC_ID.test(id)) {
      const country = /^\/([a-z]{2})\//.exec(url.pathname)?.[1];
      return { provider: 'apple_music', itemId: id, canonicalUrl: `https://music.apple.com/${country && country !== 'us' ? country + '/' : ''}song/${id}` };
    }
  }
  if (url.searchParams.has('list') || /playlist|album/.test(url.pathname)) {
    throw new PortError('SOURCE_UNSUPPORTED', 'Playlists and albums cannot be requested; send a single track link');
  }
  throw new PortError('SOURCE_UNSUPPORTED', 'Unsupported link; use a YouTube, Spotify, Apple Music, or Deezer track');
}
