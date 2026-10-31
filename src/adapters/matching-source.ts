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
    if (ref.provider !== 'spotify' && ref.provider !== 'apple_music') return this.inner.resolve(ref, purpose);
    try {
      const track = await this.catalog.lookup(ref);
      if (!track) throw new PortError('SOURCE_UNAVAILABLE', "That track isn't in the catalog");
      if (track.durationMs === null || track.durationMs <= 0) {
        throw this.failure(track, [], 'no_match', 'The catalog has no usable duration, so no confident match is possible. Paste a YouTube link.');
      }
      const raw = await this.search.search(track);
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
        const durationsEquivalent = tierCandidates.every((finding) => Math.abs(finding.candidate.durationSec - tierCandidates[0]!.candidate.durationSec) <= 3);
        if (tierCandidates.length > 1 && !durationsEquivalent) {
          throw this.failure(track, tierCandidates, 'ambiguous', 'Several different edits match. Paste the YouTube link of the version you want.');
        }
        chosen = tierCandidates[0]!;
        const tierDescription = channelTier(chosen.candidate, track).description;
        reasons.push(`several equivalent uploads; picked ${tierDescription}`);
      }
      for (const marker of detectMarkers(chosen.candidate.title, ['remaster', 'remastered', 'mono', 'stereo', 'explicit', 'clean', 'deluxe'])) {
        reasons.push(`soft marker: ${marker}`);
      }
      const resolved = await this.inner.resolve(chosen.ref, purpose);
      if (!durationMatches(resolved.durationSec, track.durationMs)) {
        const altered: Finding = { ...chosen, durationOk: false, notes: [...chosen.notes, `prepared recording differs by ${Math.round(Math.abs(resolved.durationSec - track.durationMs / 1000))} s`] };
        throw this.failure(track, [altered], 'version_mismatch', 'The matched recording duration differs from the catalog; paste the YouTube link of the version you want.');
      }
      const selection = isPlainObject(resolved.selection)
        ? { ...resolved.selection, matchedFrom: ref.canonicalUrl, matchedUrl: chosen.candidate.url }
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

