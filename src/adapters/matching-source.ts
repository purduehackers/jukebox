import { LookupCache, timedLookup } from './lookup-cache.ts';
import type { MediaPurpose, ResolvedSource, SourceRef } from '../contract/types.ts';
import { PortError, type SourcePort } from '../core/ports.ts';
import { canonicalizeUrl } from '../core/sources.ts';
import {
  candidateMatchesTitleArtist, channelTier, detectMarkers, durationMatches,
  durationTolerance, isYoutubeRef, type Candidate, type CandidateSearchPort,
  type CatalogPort, type CatalogTrack,
} from './matching-core.ts';

type Finding = { candidate: Candidate; ref: SourceRef; titleArtist: boolean; conflict: boolean; durationOk: boolean; notes: string[] };

export class MatchingSource implements SourcePort {
  private readonly cache = new LookupCache<ResolvedSource>();
  private readonly inner: SourcePort;
  private readonly catalog: CatalogPort;
  private readonly search: CandidateSearchPort;

  constructor(inner: SourcePort, catalog: CatalogPort, search: CandidateSearchPort) {
    this.inner = inner;
    this.catalog = catalog;
    this.search = search;
  }

  canonicalize(url: string): SourceRef {
    return this.inner.canonicalize(url);
  }

  async resolve(ref: SourceRef, purpose: MediaPurpose): Promise<ResolvedSource> {
    if (ref.provider !== 'spotify' && ref.provider !== 'apple_music' && ref.provider !== 'deezer') return this.inner.resolve(ref, purpose);
    return this.cache.get(`${purpose}:${ref.canonicalUrl}`, () => this.resolveCatalog(ref, purpose));
  }

  private async resolveCatalog(ref: SourceRef, purpose: MediaPurpose): Promise<ResolvedSource> {
    try {
      const track = await timedLookup('catalog', () => this.catalog.lookup(ref));
      if (!track) throw new PortError('SOURCE_UNAVAILABLE', "That track isn't in the catalog");
      if (track.durationMs === null || track.durationMs <= 0) {
        throw this.failure(track, [], 'no_match', 'The catalog has no usable duration, so no confident match is possible. Paste a YouTube link.');
      }
      if (purpose === 'request' && track.durationMs >= 360000) throw new PortError('DURATION_REJECTED', 'The full catalog recording must be strictly under six minutes');
      const raw = await timedLookup('youtube_search', () => this.search.search(track));
      const findings: Finding[] = [];
      for (const candidate of raw.slice(0, 10)) {
        let candidateRef: SourceRef;
        try {
          candidateRef = canonicalizeUrl(candidate.url);
        } catch {
          continue;
        }
        if (!isYoutubeRef(candidateRef)) continue;
        const canonicalCandidate = { ...candidate, url: candidateRef.canonicalUrl };
        const titleArtist = candidateMatchesTitleArtist(track, canonicalCandidate);
        const requestedMarkers = detectMarkers(track.title);
        const foundMarkers = detectMarkers(candidate.title);
        const conflict = requestedMarkers.length !== foundMarkers.length || requestedMarkers.some((marker) => !foundMarkers.includes(marker));
        const durationOk = durationMatches(candidate.durationSec, track.durationMs);
        const notes = markerNotes(requestedMarkers, foundMarkers);
        if (!durationOk) notes.push(`duration differs by ${Math.round(Math.abs(candidate.durationSec - track.durationMs / 1000))} s`);
        findings.push({ candidate: canonicalCandidate, ref: candidateRef, titleArtist, conflict, durationOk, notes });
      }

      const strong = findings.filter((finding) => finding.titleArtist && !finding.conflict && finding.durationOk);
      if (strong.length === 0) {
        const matching = findings.filter((finding) => finding.titleArtist);
        if (matching.length > 0) {
          throw this.failure(track, matching, 'version_mismatch', 'Only other versions or durations were found; paste the YouTube link of the version you want.');
        }
        throw this.failure(track, findings, 'no_match', 'No confident match was found; paste a YouTube link.');
      }

      let chosen = strong[0]!;
      const reasons = ['same title and artist', `duration within ${Math.ceil(durationTolerance(track.durationMs))} s of the catalog`];
      if (strong.length > 1) {
        const bestTier = Math.min(...strong.map((finding) => channelTier(finding.candidate, track).tier));
        const tierCandidates = strong.filter((finding) => channelTier(finding.candidate, track).tier === bestTier);
        chosen = tierCandidates[0]!;
        const tierDescription = channelTier(chosen.candidate, track).description;
        reasons.push(`several equivalent uploads; preferred ${tierDescription}`);
      }
      // Every fallback must satisfy the title/artist/version rules and the
      // user's 60-second catalog tolerance, including less preferred channels.
      // Never retry the same recording or broaden search after extraction fails.
      const seen = new Set<string>([chosen.ref.canonicalUrl]);
      const alternatives = strong
        .sort((a, b) => channelTier(a.candidate, track).tier - channelTier(b.candidate, track).tier)
        .filter((finding) => {
          if (seen.has(finding.ref.canonicalUrl)) return false;
          seen.add(finding.ref.canonicalUrl);
          return true;
        });
      const attempts = [chosen, ...alternatives].slice(0, 2);
      let resolved: ResolvedSource | undefined;
      const failedUrls: string[] = [];
      for (const attempt of attempts) {
        chosen = attempt;
        try {
          resolved = await timedLookup('audio_source', () => this.inner.resolve(chosen.ref, purpose));
          if (purpose === 'request' && resolved.durationSec >= 360) throw new PortError('DURATION_REJECTED', 'The resolved recording must be strictly under six minutes');
        } catch (error) {
          if (!(error instanceof PortError) || error.details?.kind !== 'audio_format_unavailable') throw error;
          failedUrls.push(chosen.ref.canonicalUrl);
          if (attempt === attempts.at(-1)) {
            throw new PortError(error.code, error.message, error.technical, {
              ...error.details, attemptedUrls: failedUrls,
            });
          }
          continue;
        }
        const resolvedCandidate = { ...chosen.candidate, title: resolved.title, channel: resolved.artist ?? chosen.candidate.channel };
        const titleArtistOk = candidateMatchesTitleArtist(track, resolvedCandidate);
        const versionOk = detectMarkers(resolved.title).join('|') === detectMarkers(track.title).join('|');
        const durationOk = durationMatches(resolved.durationSec, track.durationMs);
        if (!durationOk || !titleArtistOk || !versionOk) {
          const notes = [...chosen.notes];
          if (!durationOk) notes.push(`resolved recording differs by ${Math.round(Math.abs(resolved.durationSec - track.durationMs / 1000))} s`);
          if (!titleArtistOk || !versionOk) notes.push('resolved title, artist, or version changed since search');
          const altered: Finding = { ...chosen, candidate: resolvedCandidate, durationOk, notes };
          throw this.failure(track, [altered], 'version_mismatch', 'The resolved recording title, version, or duration differs from the catalog; paste the YouTube link of the version you want.');
        }
        break;
      }
      if (!resolved) throw new PortError('SOURCE_UNAVAILABLE', 'No matched upload could be resolved', true);
      if (failedUrls.length) reasons.push('preferred upload exposed no suitable audio-only format; used an equivalent matched upload');
      for (const marker of detectMarkers(chosen.candidate.title, ['remaster', 'remastered', 'mono', 'stereo', 'explicit', 'clean', 'deluxe'])) {
        reasons.push(`soft marker: ${marker}`);
      }
      const selection = isPlainObject(resolved.selection)
        ? { ...resolved.selection, matchedFrom: ref.canonicalUrl, matchedUrl: chosen.candidate.url, catalog: { provider: track.provider, itemId: track.itemId, title: track.title, artists: track.artists, durationMs: track.durationMs, provenance: track.provenance ?? 'fixture', ...(track.isrc ? { isrc: track.isrc } : {}) } }
        : resolved.selection;
      return {
        ...resolved,
        ref,
        title: track.title,
        artist: track.artists.join(', '),
        selection,
        match: {
          via: 'youtube',
          url: chosen.candidate.url,
          title: chosen.candidate.title,
          artist: chosen.candidate.channel,
          durationSec: resolved.durationSec,
          reasons,
        },
      };
    } catch (error) {
      if (error instanceof PortError) throw error;
      throw new PortError('SOURCE_UNAVAILABLE', 'Matching is temporarily unavailable', true);
    }
  }

  private failure(track: CatalogTrack, findings: Finding[], kind: string, message: string): PortError {
    const relevant = [...findings].sort((a, b) => relevance(b) - relevance(a)).slice(0, 3);
    return new PortError('SOURCE_UNAVAILABLE', message, false, {
      kind,
      requested: { title: track.title, artist: track.artists.join(', '), durationSec: (track.durationMs ?? 0) / 1000 },
      candidates: relevant.map(({ candidate, notes }) => ({
        url: candidate.url,
        title: candidate.title,
        channel: candidate.channel,
        durationSec: candidate.durationSec,
        notes: notes.length ? notes : ['title and artist matched'],
      })),
    });
  }
}

function markerNotes(requested: string[], found: string[]): string[] {
  const notes = found.filter((marker) => !requested.includes(marker)).map((marker) => `extra marker: ${marker}`);
  notes.push(...requested.filter((marker) => !found.includes(marker)).map((marker) => `missing marker: ${marker}`));
  return notes;
}

function relevance(finding: Finding): number {
  return (finding.titleArtist ? 4 : 0) + (finding.conflict ? 1 : 0) + (finding.durationOk ? 1 : 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

