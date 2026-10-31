import type { SourceRef } from '../contract/types.ts';
import { PortError } from '../core/ports.ts';
import type { SourcePort } from '../core/ports.ts';
import { FakeSource } from './fakes.ts';
import { MatchingSource } from './matching-source.ts';
import { canonicalizeUrl } from '../core/sources.ts';
import type { Candidate, CandidateSearchPort, CatalogPort, CatalogTrack } from './matching-core.ts';

export const MATCHING_FIXTURE_URLS = {
  spotify: 'https://open.spotify.com/track/1OAFmguvHB2OI2AMYXpmyG',
  apple: 'https://music.apple.com/us/song/a-new-kind-of-love/1000000000001',
  live: 'https://open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA',
  studio: 'https://open.spotify.com/track/BBBBBBBBBBBBBBBBBBBBBB',
  ambiguous: 'https://open.spotify.com/track/CCCCCCCCCCCCCCCCCCCCCC',
  cover: 'https://open.spotify.com/track/DDDDDDDDDDDDDDDDDDDDDD',
  durationTrap: 'https://open.spotify.com/track/EEEEEEEEEEEEEEEEEEEEEE',
  missing: 'https://open.spotify.com/track/FFFFFFFFFFFFFFFFFFFFFF',
} as const;

const youtube = (id: string) => `https://www.youtube.com/watch?v=${id}`;

// The Ghost Funk Orchestra identity above is the sole real metadata fact here.
// All durations, other catalog records, and all candidate uploads are fictional test fixtures.
export const FIXTURE_TRACKS: CatalogTrack[] = [
  { provider: 'spotify', itemId: '1OAFmguvHB2OI2AMYXpmyG', title: 'A New Kind Of Love (pt. 1)', artists: ['Ghost Funk Orchestra'], album: 'A New Kind Of Love', durationMs: 212_000 },
  { provider: 'apple_music', itemId: '1000000000001', title: 'A New Kind Of Love (pt. 1)', artists: ['Ghost Funk Orchestra'], durationMs: 212_000 },
  { provider: 'spotify', itemId: 'AAAAAAAAAAAAAAAAAAAAAA', title: 'Fictional Song (Live)', artists: ['Example Artist'], durationMs: 180_000 },
  { provider: 'spotify', itemId: 'BBBBBBBBBBBBBBBBBBBBBB', title: 'Fictional Song', artists: ['Example Artist'], durationMs: 180_000 },
  { provider: 'spotify', itemId: 'CCCCCCCCCCCCCCCCCCCCCC', title: 'Different Edit Song', artists: ['Edit Artist'], durationMs: 200_000 },
  { provider: 'spotify', itemId: 'DDDDDDDDDDDDDDDDDDDDDD', title: 'Borrowed Time', artists: ['Cover Artist'], durationMs: 180_000 },
  { provider: 'spotify', itemId: 'EEEEEEEEEEEEEEEEEEEEEE', title: 'Duration Trap Song', artists: ['Trap Artist'], durationMs: 180_000 },
];

export const FIXTURE_CANDIDATES: Record<string, Candidate[]> = {
  'spotify:1OAFmguvHB2OI2AMYXpmyG': [
    { url: youtube('GFOtrack001'), title: 'A New Kind Of Love Pt 1 (Official Audio)', channel: 'Ghost Funk Orchestra - Topic', durationSec: 212 },
  ],
  'apple_music:1000000000001': [
    { url: youtube('GFOtrack001'), title: 'A New Kind Of Love Pt 1 (Audio)', channel: 'Ghost Funk Orchestra - Topic', durationSec: 212 },
  ],
  'spotify:AAAAAAAAAAAAAAAAAAAAAA': [
    { url: youtube('EXlive00001'), title: 'Fictional Song', channel: 'Example Artist', durationSec: 180 },
  ],
  'spotify:BBBBBBBBBBBBBBBBBBBBBB': [
    { url: youtube('EXmix000001'), title: 'Fictional Song (Remix)', channel: 'Example Artist', durationSec: 180 },
    { url: youtube('EXlive00002'), title: 'Fictional Song (Live)', channel: 'Example Artist - Topic', durationSec: 180 },
  ],
  'spotify:CCCCCCCCCCCCCCCCCCCCCC': [
    { url: youtube('EDITshort01'), title: 'Different Edit Song', channel: 'Edit Artist', durationSec: 197 },
    { url: youtube('EDITlong001'), title: 'Different Edit Song', channel: 'Edit Artist', durationSec: 203 },
  ],
  'spotify:DDDDDDDDDDDDDDDDDDDDDD': [
    { url: youtube('COVERsong01'), title: 'Borrowed Time (Cover)', channel: 'Other Singer', durationSec: 180 },
    { url: youtube('REALsong001'), title: 'Borrowed Time (Official Audio)', channel: 'Cover Artist - Topic', durationSec: 180 },
  ],
  'spotify:EEEEEEEEEEEEEEEEEEEEEE': [
    { url: youtube('TRAPsong001'), title: 'Duration Trap Song', channel: 'Trap Artist', durationSec: 220 },
  ],
};

export class FixtureCatalog implements CatalogPort {
  private readonly records = new Map<string, CatalogTrack>();
  constructor(tracks: CatalogTrack[] = FIXTURE_TRACKS) {
    for (const track of tracks) this.records.set(canonicalUrlForTrack(track), track);
  }
  async lookup(ref: SourceRef): Promise<CatalogTrack | null> {
    return this.records.get(ref.canonicalUrl) ?? null;
  }
}

export class FixtureCandidateSearch implements CandidateSearchPort {
  private readonly records: Record<string, Candidate[]>;
  constructor(records: Record<string, Candidate[]> = FIXTURE_CANDIDATES) {
    this.records = records;
  }
  async search(track: CatalogTrack): Promise<Candidate[]> {
    return (this.records[`${track.provider}:${track.itemId}`] ?? []).slice(0, 10);
  }
}

export class UnconfiguredCatalog implements CatalogPort {
  async lookup(_ref: SourceRef): Promise<never> {
    throw new PortError('SOURCE_UNSUPPORTED', 'Spotify/Apple Music matching is not configured on this server (it needs catalog credentials)');
  }
}

function canonicalUrlForTrack(track: CatalogTrack): string {
  if (track.provider === 'spotify') return canonicalizeUrl(`https://open.spotify.com/track/${track.itemId}`).canonicalUrl;
  return `https://music.apple.com/song/${track.itemId}`;
}

/** Plain YouTube links the offline dev service knows, for trying the attendee page by hand. */
export const DEMO_YOUTUBE_LINKS = {
  song: 'https://youtu.be/DEMOsong001',
  second: 'https://youtu.be/DEMOsong002',
  overlong: 'https://youtu.be/DEMOlong001',
} as const;

/**
 * Offline source for local development: fixture YouTube items, plus Spotify/Apple fixture links
 * matched through MatchingSource. Not a live matcher; every title, duration, and candidate is made up
 * except the one Spotify track named in the comments above.
 */
export function fixtureMatchingSource(): SourcePort {
  const inner = new FakeSource()
    .add(DEMO_YOUTUBE_LINKS.song, { title: 'Demo Song One', artist: 'Demo Artist', durationSec: 192 })
    .add(DEMO_YOUTUBE_LINKS.second, { title: 'Demo Song Two', artist: 'Demo Artist', durationSec: 201 })
    .add(DEMO_YOUTUBE_LINKS.overlong, { title: 'Demo Long Mix', artist: 'Demo Artist', durationSec: 421 });
  for (const candidates of Object.values(FIXTURE_CANDIDATES)) {
    for (const candidate of candidates) {
      inner.add(candidate.url, { title: candidate.title, artist: candidate.channel, durationSec: candidate.durationSec, recordingKey: `youtube:${new URL(candidate.url).searchParams.get('v')}` });
    }
  }
  return new MatchingSource(inner, new FixtureCatalog(), new FixtureCandidateSearch());
}
