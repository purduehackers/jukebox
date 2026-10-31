# Phase 4B: attendee queue

Status: PH ID, three-song quota, admin-managed nights, and automatic admission
confirmed. Depends on phase-2 contracts, source resolution, and quota accounting.

## Goal

A phone-friendly QR destination at intended `/queue`, with a short, understandable
request flow and explicit request status.

## Scope

- Require PH ID for submission and enforce three songs per stable user identity
  per admin-managed night session. No guest submissions or midnight quota reset.
- Admit valid requests automatically. Admins can remove them; do not add a
  per-song approval step. Distinguish queued/preparing media from manual review.
- Paste a supported URL; show resolved title/artist/version and duration before
  accepting it. Spotify/Apple matching must use the selected resolver strategy,
  with disambiguation rather than silently choosing an unrelated recording.
- Surface unsupported provider, invalid link, unknown/over-limit duration,
  duplicates, unavailable source, quota exhaustion, and moderation state.
- Prevent duplicate submission on retries. Enforce all rules server-side.
- Show validating/preparing/queued/playing/played/rejected/failed/cancelled states as
  appropriate, remaining allowance, and queue timing based on the chosen policy.
  Do not present a guaranteed exact ETA when the queue can change.
- Include withdrawal or replacement only after their quota implications are set.
- QR targets the configured canonical public route. A test QR must point to a
  reachable test origin rather than a phone's own localhost.

## Exit gate

Test new and returning users, event spanning midnight, retry/double tap,
unsupported/malicious URL, overlong item, mismatched version, admin removal, quota
refund policy, and two clients seeing consistent queue state. Use local metadata
and auth fixtures so routine checks do not rely on live provider APIs.

Own attendee UI/resolver integration files as assigned. The backend remains the
authority for quotas, moderation, ordering, and provider validation.
