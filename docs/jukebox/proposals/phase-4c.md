# Phase 4C contract proposal: artwork and public next master

Status: proposal for the Phase 2 integration owner; not an integrated contract decision.

## Rationale

The display sketch includes artwork alongside the current track. The existing shared
contract exposed only title, artist, and duration, and did not expose which master
track would follow the current request turn. Display code should consume authoritative
server state rather than infer queue progression locally.

## Additive proposal

- Add optional `artworkUrl` to resolved metadata and relevant master queue, request
  queue, and `nowPlaying` views. Only absolute `http:` and `https:` URLs are accepted;
  `data:`, `javascript:`, and other schemes fail source resolution before persistence.
- Append a SQLite migration adding nullable artwork URL columns to master and request
  rows. Existing databases and rows remain valid with `NULL` artwork.
- Add public-safe `nextMaster`, containing only title, artist, duration, and optional
  artwork URL. During a request turn it identifies the suspended master (if any),
  otherwise the next playable master item by the scheduler's queue/cursor rules. It
  intentionally has no requester, device, or entry identifiers.
- Pass through yt-dlp's optional metadata `thumbnail` only when it is an HTTP(S) URL.
  Fixture metadata without thumbnails remains without artwork.

## Evidence and limitations

The current Python worker's resolver already requests yt-dlp metadata, but its response
previously discarded `thumbnail`; preparation itself is audio-only and remains so.
The code can now pass through a metadata thumbnail when yt-dlp provides one. No live
provider metadata was fetched for this proposal, so actual artwork availability,
image reachability, licensing, and image rendering/CORS behavior are unverified. This
proposal does not claim a provider-specific artwork API or guarantee that every source
has artwork. The consuming display should treat `artworkUrl` as optional and handle
load failure.

## Verification

Added tests cover nullable artwork propagation, persistence across service restart,
public snapshot privacy, `nextMaster` during normal master playback and a suspended-mix
request turn, and rejection of non-HTTP(S) artwork URLs. Worker adapter tests cover
thumbnail mapping and rejection of an unsafe scheme. Run `npm test` and `npm run
typecheck` before integration review.
