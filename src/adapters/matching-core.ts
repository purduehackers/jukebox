import type { SourceRef } from '../contract/types.ts';

export interface CatalogTrack {
  provider: 'spotify' | 'apple_music';
  itemId: string;
  title: string;
  artists: string[];
  album?: string;
  durationMs: number | null;
  isrc?: string;
  provenance?: string;
}

export interface CatalogPort {
  lookup(ref: SourceRef): Promise<CatalogTrack | null>;
}

export interface Candidate {
  url: string;
  title: string;
  channel: string;
  durationSec: number;
}

export interface CandidateSearchPort {
  search(track: CatalogTrack): Promise<Candidate[]>;
}

export const HARD_MARKERS = [
  'live', 'remix', 'acoustic', 'instrumental', 'karaoke', 'cover', 'sped up',
  'slowed', 'reverb', 'nightcore', '8d', 'radio edit', 'extended', 'demo', 'reprise',
] as const;

export const SOFT_MARKERS = ['remaster', 'remastered', 'mono', 'stereo', 'explicit', 'clean', 'deluxe'] as const;

export function normalizeText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

export function detectMarkers(value: string, markers: readonly string[] = HARD_MARKERS): string[] {
  const normalized = ` ${normalizeText(value)} `;
  return markers.filter((marker) => {
    const words = marker.split(' ').join('\\s+');
    return new RegExp(`(?:^|\\s)${words}(?:$|\\s)`).test(normalized);
  });
}

export function baseTitle(value: string): string {
  const withoutFeat = value.replace(/\b(?:feat\.?|ft\.?|featuring)\b[\s\S]*$/i, ' ');
  const withoutMarkers = [...HARD_MARKERS, ...SOFT_MARKERS].reduce((text, marker) => {
    const words = marker.split(' ').join('\\s+');
    return text.replace(new RegExp(`(?:^|[\\s([{-])${words}(?=$|[\\s)\\]}-])`, 'gi'), ' ');
  }, withoutFeat);
  return normalizeText(withoutMarkers);
}

export function durationTolerance(durationMs: number): number {
  return Math.max(3, (durationMs / 1000) * 0.02);
}

export function durationMatches(candidateSec: number, catalogMs: number): boolean {
  return Math.abs(candidateSec - catalogMs / 1000) <= durationTolerance(catalogMs);
}

/** Whole-word containment on normalized text, so "love" is not found inside "lovely". */
export function containsWords(haystack: string, needle: string): boolean {
  return needle !== '' && ` ${haystack} `.includes(` ${needle} `);
}

export function candidateMatchesTitleArtist(track: CatalogTrack, candidate: Candidate): boolean {
  // Noise words ("audio", "video", ...) are stripped from both sides, so a song that is really
  // called "Video Games" still matches an upload titled "Video Games (Official Audio)".
  const title = normalizeCandidateTitle(baseTitle(track.title));
  const candidateTitle = normalizeCandidateTitle(candidate.title);
  const candidateChannel = normalizeChannel(candidate.channel);
  return containsWords(candidateTitle, title) && track.artists.some((artist) => {
    return containsWords(`${candidateTitle} ${candidateChannel}`, normalizeText(artist));
  });
}

export function normalizeCandidateTitle(value: string): string {
  const withoutNoise = value.replace(/\b(?:official|audio|video|lyrics?|visualizer|hd|hq|music video|topic|vevo)\b/gi, ' ');
  return normalizeText(withoutNoise);
}

export function normalizeChannel(value: string): string {
  return normalizeText(value.replace(/\s*-\s*topic\s*$/i, '').replace(/\bvevo\b/gi, '').replace(/\bofficial\b/gi, ''));
}

export function channelTier(candidate: Candidate, track: CatalogTrack): { tier: number; description: string } {
  if (/\s*-\s*topic\s*$/i.test(candidate.channel)) return { tier: 0, description: 'the auto-generated Topic upload' };
  const channel = normalizeChannel(candidate.channel);
  if (track.artists.some((artist) => channel === normalizeText(artist))) {
    return { tier: 1, description: 'the artist channel upload' };
  }
  return { tier: 2, description: 'the best matching channel upload' };
}

export function isYoutubeRef(ref: SourceRef): boolean {
  return ref.provider === 'youtube' && /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(ref.canonicalUrl);
}
