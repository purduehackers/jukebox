# Phase 4B contract proposals (additive; integration owner decides)

Every item below is additive to contract version 1 and lives in its own
`contract-proposal:` commit with tests. Nothing existing changes meaning.

## P1. `request.preview` (read-only) + `expectRecordingKey` guard + `details` + `RATE_LIMITED`

**Gap.** `request.submit` resolves and admits atomically. The brief requires showing the
resolved title/artist/duration (and, for Spotify/Apple, the matched recording) *before*
accepting. Without a preview the attendee can only learn what a link means by spending
allowance.

**Proposal.**

| Change | Where | Notes |
| --- | --- | --- |
| `request.preview {url}` → `PreviewResult` | `types.ts`, `validate.ts` (attendee role), `service.ts` | Runs the same order as submit (allowlist → open night → quota pre-check → bounded resolve). Writes nothing, bumps no revision, never stored in `commands`. Post-resolve rejections (≥ 6 min, duplicate) are returned as `verdict` so the requester still sees what the link is. Pre-resolve failures are ordinary typed errors. |
| `request.submit {url, expectRecordingKey?}` | same | If given and the link now resolves to a different `recordingKey`, fails `GUARD_MISMATCH` and consumes nothing. Closes the "previewed version A, admitted version B" window (a catalog or matcher change between the two calls). Semantics without the field are unchanged. |
| `ResolvedSource.match?: MatchInfo` | `types.ts` | Optional provenance for a Spotify/Apple link matched to a playable recording. Echoed in the preview; not persisted outside `selection`. |
| `ApiError.details?`, `PortError.details?` | `types.ts`, `ports.ts`, `service.ts#failure` | Optional structured, user-safe context (e.g. `{kind:'ambiguous', candidates:[…]}`) so the UI can offer a disambiguation list instead of parsing prose. Stored and replayed with the command response. |
| `ErrorCode` `RATE_LIMITED` (retryable) | `types.ts`, `service.ts` | Preview triggers resolver work (30 s subprocess on the worker), so it is limited to 12 / minute / identity (`ServiceOptions.previewLimit`). In-memory; resets on restart. |

**Not proposed:** a separate preview token or reservation. A preview is advice, not a
promise; the server re-checks everything at submit and the guard catches changed matches.

**Tests:** `tests/preview.test.ts` (read-only, verdicts, error parity, rate limit,
guard, details replay).
