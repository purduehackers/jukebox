// Catalogs supply metadata only. No preview audio, embeds, session tokens, or
// arbitrary submitted URLs cross into the media pipeline.
import type { SourceRef } from '../contract/types.ts';
import { PortError } from '../core/ports.ts';
import { canonicalizeUrl } from '../core/sources.ts';
import type { CatalogPort, CatalogTrack } from './matching-core.ts';

type Config = { fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; spotifyClientId?: string; spotifyClientSecret?: string; appleDeveloperToken?: string; timeoutMs?: number };
const MAX_BYTES = 2 * 1024 * 1024;

export class LiveCatalog implements CatalogPort {
  private readonly config: Config;
  private readonly fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly cache = new Map<string, { until: number; track: CatalogTrack }>();
  private active = 0;
  private requests: number[] = [];
  private token: { value: string; until: number } | null = null;
  private tokenPending: Promise<string> | null = null;
  constructor(config: Config = {}) { this.config = config; this.fetcher = config.fetch ?? fetch; }

  private async request(url: string, init: RequestInit = {}): Promise<{ status: number; text: string }> {
    const now = Date.now();
    this.requests = this.requests.filter(at => at > now - 60000);
    if (this.requests.length >= 20) throw new PortError('SOURCE_UNAVAILABLE', 'Music catalog request limit reached; try again in a minute.', true, { kind: 'catalog_unavailable' });
    this.requests.push(now);
    try {
      const response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs ?? 10000) });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, text: '' };
      }
      if (!response.body) throw Error();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_BYTES) throw Error();
          chunks.push(next.value);
        }
      } finally { await reader.cancel(); }
      return { status: response.status, text: Buffer.concat(chunks).toString('utf8') };
    } catch {
      throw new PortError('SOURCE_UNAVAILABLE', 'The music catalog could not be reached or returned an oversized response. Try again later.', true, { kind: 'catalog_unavailable' });
    }
  }

  async lookup(ref: SourceRef): Promise<CatalogTrack | null> {
    const checked = canonicalizeUrl(ref.canonicalUrl);
    if (checked.provider !== ref.provider || checked.itemId !== ref.itemId || !['spotify', 'apple_music', 'deezer'].includes(ref.provider)) {
      throw new PortError('INVALID_SOURCE', 'Invalid catalog recording');
    }
    const key = checked.canonicalUrl;
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return structuredClone(cached.track);
    if (this.active >= 2) throw new PortError('SOURCE_UNAVAILABLE', 'Music catalog is busy; try again shortly.', true);
    this.active++;
    try {
      const track = ref.provider === 'spotify' ? await this.spotify(checked) : ref.provider === 'deezer' ? await this.deezer(checked) : await this.apple(checked);
      if (track) {
        if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { until: Date.now() + 300000, track });
      }
      return track ? structuredClone(track) : null;
    } finally { this.active--; }
  }

  private status(status: number, provider: string): void {
    if (status >= 200 && status < 300) return;
    if (status === 401 || status === 403) throw new PortError('SOURCE_UNSUPPORTED', `${provider} catalog access was denied. Ask an organizer to check catalog configuration.`, false, { kind: 'catalog_configuration' });
    throw new PortError('SOURCE_UNAVAILABLE', `${provider} catalog is temporarily unavailable${status === 429 ? ' (rate limited)' : ''}. Try again later.`, true, { kind: 'catalog_unavailable' });
  }

  private async spotifyToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    if (this.tokenPending) return this.tokenPending;
    this.tokenPending = (async () => {
      const result = await this.request('https://accounts.spotify.com/api/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${this.config.spotifyClientId}:${this.config.spotifyClientSecret}`).toString('base64')}` },
        body: 'grant_type=client_credentials',
      });
      this.status(result.status, 'Spotify');
      const body = parseJson(result.text);
      if (typeof body.access_token !== 'string' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) throw malformed('Spotify');
      this.token = { value: body.access_token, until: Date.now() + Math.max(0, body.expires_in * 1000 - 30000) };
      return body.access_token;
    })();
    try { return await this.tokenPending; } finally { this.tokenPending = null; }
  }

  private async spotify(ref: SourceRef): Promise<CatalogTrack | null> {
    if (this.config.spotifyClientId || this.config.spotifyClientSecret) {
      if (!this.config.spotifyClientId || !this.config.spotifyClientSecret) {
        throw new PortError('SOURCE_UNSUPPORTED', 'Set both JUKEBOX_SPOTIFY_CLIENT_ID and JUKEBOX_SPOTIFY_CLIENT_SECRET, or remove both to use public track metadata.', false, { kind: 'catalog_configuration' });
      }
      const token = await this.spotifyToken();
      const result = await this.request(`https://api.spotify.com/v1/tracks/${ref.itemId}`, { headers: { authorization: `Bearer ${token}` } });
      if (result.status === 401) this.token = null;
      if (result.status === 404) return null;
      this.status(result.status, 'Spotify');
      const body = parseJson(result.text);
      // Reject relinking to another recording; never quietly change the requested version.
      if (body.id !== ref.itemId) throw malformed('Spotify');
      return track(ref, body.name, artistNames(body.artists), body.duration_ms, 'spotify_web_api', body.album?.name, body.external_ids?.isrc);
    }
    const result = await this.request(`https://open.spotify.com/embed/track/${ref.itemId}`);
    if (result.status === 404) return null;
    this.status(result.status, 'Spotify');
    const embedded = /<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(result.text);
    const entity = embedded ? parseJson(embedded[1]!).props?.pageProps?.state?.data?.entity : null;
    // Public embed metadata is an inspected, replaceable capability, not a stable
    // Web API contract. Consume only this entity; ignore all playback/session data.
    if (!entity || entity.type !== 'track' || entity.id !== ref.itemId || entity.uri !== `spotify:track:${ref.itemId}`) {
      throw new PortError('SOURCE_UNSUPPORTED', 'Spotify public track metadata is unavailable or has changed. An organizer can configure JUKEBOX_SPOTIFY_CLIENT_ID and JUKEBOX_SPOTIFY_CLIENT_SECRET for the documented API; otherwise paste a YouTube link.', false, { kind: 'catalog_configuration' });
    }
    return track(ref, entity.name, artistNames(entity.artists), entity.duration, 'spotify_public_embed');
  }

  private async deezer(ref: SourceRef): Promise<CatalogTrack | null> {
    // Public, unauthenticated track endpoint; no API key needed.
    const result = await this.request(`https://api.deezer.com/track/${ref.itemId}`);
    if (result.status === 404) return null;
    this.status(result.status, 'Deezer');
    const body = parseJson(result.text);
    // Deezer reports unknown tracks as HTTP 200 with an error object.
    if (body.error) {
      if (body.error.code === 800) return null;
      throw new PortError('SOURCE_UNAVAILABLE', 'Deezer catalog is temporarily unavailable. Try again later.', true, { kind: 'catalog_unavailable' });
    }
    // Reject relinking to another recording; never quietly change the requested version.
    if (String(body.id) !== ref.itemId) throw malformed('Deezer');
    return track(ref, body.title, [body.artist?.name], typeof body.duration === 'number' ? body.duration * 1000 : NaN, 'deezer_public_api', body.album?.title, body.isrc);
  }

  private async apple(ref: SourceRef): Promise<CatalogTrack | null> {
    const country = /^https:\/\/music\.apple\.com\/([a-z]{2})\//.exec(ref.canonicalUrl)?.[1] ?? 'us';
    if (this.config.appleDeveloperToken) {
      const result = await this.request(`https://api.music.apple.com/v1/catalog/${country}/songs/${ref.itemId}`, { headers: { authorization: `Bearer ${this.config.appleDeveloperToken}` } });
      if (result.status === 404) return null;
      this.status(result.status, 'Apple Music');
      const body = parseJson(result.text);
      if (!Array.isArray(body.data)) throw malformed('Apple Music');
      const song = body.data.find((entry: any) => entry.id === ref.itemId && entry.type === 'songs');
      if (!song) throw malformed('Apple Music');
      const attributes = song.attributes;
      if (!attributes || typeof attributes !== 'object') throw malformed('Apple Music');
      return track(ref, attributes.name, [attributes.artistName], attributes.durationInMillis, 'apple_music_api', attributes.albumName, attributes.isrc);
    }
    const result = await this.request(`https://itunes.apple.com/lookup?id=${ref.itemId}&entity=song&country=${country}&limit=1`);
    this.status(result.status, 'Apple Music');
    const body = parseJson(result.text);
    if (!Array.isArray(body.results)) throw malformed('Apple Music');
    const song = body.results.find((entry: any) => entry.kind === 'song' && String(entry.trackId) === ref.itemId);
    if (!song) throw new PortError('SOURCE_UNAVAILABLE', 'That exact song is absent from Apple’s public iTunes catalog in this storefront. Paste a YouTube link, or ask an organizer to configure Apple Music API access.', false, { kind: 'catalog_metadata' });
    return track(ref, song.trackName, [song.artistName], song.trackTimeMillis, 'apple_itunes_lookup', song.collectionName);
  }
}

function parseJson(text: string): any {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch { throw malformed('Music'); }
}
function artistNames(value: unknown): unknown {
  return Array.isArray(value) ? value.map(a => a?.name) : null;
}
function malformed(provider: string): PortError {
  return new PortError('SOURCE_UNAVAILABLE', `${provider} returned incomplete or changed track metadata. No recording was selected.`, false, { kind: 'catalog_metadata' });
}
function track(ref: SourceRef, title: unknown, artists: unknown, duration: unknown, provenance: string, album?: unknown, isrc?: unknown): CatalogTrack {
  if (typeof title !== 'string' || !title.trim() || title.length > 500 || !Array.isArray(artists) || !artists.length || artists.some(a => typeof a !== 'string' || !a.trim() || a.length > 300) || typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 14400000) throw malformed(ref.provider);
  return { provider: ref.provider as CatalogTrack['provider'], itemId: ref.itemId, title, artists, durationMs: duration, provenance,
    ...(typeof album === 'string' ? { album } : {}), ...(typeof isrc === 'string' ? { isrc } : {}) };
}
