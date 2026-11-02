// Pure server-side URL allowlist. Never fetches; never builds shell commands.
import type { SourceRef } from '../contract/types.ts';
import { PortError } from './ports.ts';

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const SHARE_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const YOUTUBE_CONTEXT = ['si', 't', 'start', 'end', 'time_continue', 'list', 'index', 'start_radio', 'feature', 'pp', 'ab_channel', 'app', 'persist_app', 'lc'];
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
export const FIXTURE_SOURCES = ['fixture:master', 'fixture:request', 'fixture:song', 'fixture:aac'] as const;

export function canonicalizeUrl(input: unknown): SourceRef {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2048) {
    throw new PortError('INVALID_SOURCE', 'Paste a single YouTube, Spotify, or Apple Music track link');
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
  const params = [...url.searchParams.entries()];
  const only = (allowed: string[]) => params.every(([k]) => allowed.includes(k)) &&
    new Set(params.map(([k]) => k)).size === params.length;
  const share = url.searchParams.get('si');
  if (share !== null && !SHARE_TOKEN.test(share)) throw new PortError('INVALID_SOURCE', 'Invalid sharing parameter');
  const host = url.hostname.toLowerCase();

  let youtube: string | null = null;
  const youtubeHost = ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host);
  if (url.hash && (!youtubeHost || !/^#t=[0-9hms.]+$/.test(url.hash))) throw new PortError('INVALID_SOURCE', 'Unsupported link fragment');
  const youtubeParams = (watch: boolean) => only([...YOUTUBE_CONTEXT, ...(watch ? ['v'] : [])]) && params.every(([k, value]) => k === 'v' || (value.length <= 512 && /^[\p{L}\p{N}\p{M}\p{S}_ .%+,:=()@-]*$/u.test(value)));
  if (youtubeHost && host !== 'youtu.be' && url.pathname === '/watch' && youtubeParams(true)) {
    youtube = url.searchParams.get('v');
  } else if (host === 'youtu.be' && youtubeParams(false)) {
    youtube = url.pathname.slice(1);
  } else if (youtubeHost && host !== 'youtu.be' && /^\/(?:shorts|live)\/[^/]+$/.test(url.pathname) && youtubeParams(false)) {
    youtube = url.pathname.split('/')[2]!;
  }
  if (youtube !== null) {
    if (!YOUTUBE_ID.test(youtube)) throw new PortError('INVALID_SOURCE', 'Invalid YouTube video ID');
    return { provider: 'youtube', itemId: youtube, canonicalUrl: `https://www.youtube.com/watch?v=${youtube}` };
  }
  const spotify = /^\/(?:intl-[a-z]{2}\/)?track\/([^/]+)$/.exec(url.pathname);
  if (host === 'open.spotify.com' && spotify && only(['si', 'utm_source', 'utm_medium', 'utm_campaign', 'context'])) {
    const id = spotify[1]!;
    if (!SPOTIFY_ID.test(id)) throw new PortError('INVALID_SOURCE', 'Invalid Spotify track ID');
    return { provider: 'spotify', itemId: id, canonicalUrl: `https://open.spotify.com/track/${id}` };
  }
  if (host === 'music.apple.com' && only(['i', 'l', 'ls', 'app', 'at', 'ct', 'itsct', 'itscg', 'mt', 'uo'])) {
    // Album URL with ?i=<trackId> or /song/<slug>/<id>.
    // The service stores `canonicalUrl` and re-parses it for preparation, so the canonical
    // form `/song/<id>` must canonicalize to itself.
    const song = /^\/(?:[a-z]{2}\/)?song\/(?:[^/]+\/)?(\d{1,15})$/.exec(url.pathname);
    const album = /^\/[a-z]{2}\/album\/[^/]+\/\d{1,15}$/.test(url.pathname) ? url.searchParams.get('i') : null;
    if (song && url.searchParams.has('i') && url.searchParams.get('i') !== song[1]) throw new PortError('INVALID_SOURCE', 'Conflicting Apple Music track IDs');
    const id = song?.[1] ?? album;
    if (id && /^\d{1,15}$/.test(id)) {
      const country = /^\/([a-z]{2})\//.exec(url.pathname)?.[1];
      return { provider: 'apple_music', itemId: id, canonicalUrl: `https://music.apple.com/${country && country !== 'us' ? country + '/' : ''}song/${id}` };
    }
  }
  if (url.searchParams.has('list') || /playlist|album/.test(url.pathname)) {
    throw new PortError('SOURCE_UNSUPPORTED', 'Playlists and albums cannot be requested; send a single track link');
  }
  throw new PortError('SOURCE_UNSUPPORTED', 'Unsupported link; use a YouTube, Spotify, or Apple Music track');
}
