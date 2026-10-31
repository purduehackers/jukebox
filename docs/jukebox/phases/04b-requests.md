# Phase 4B: attendee queue

Status: depends on phase-2 contracts and source/identity/moderation decisions.

## Goal

A phone-friendly QR destination at intended `/queue`, with a short, understandable
request flow and explicit request status.

## Scope

- The agreed sign-in or guest experience; stable person identity if enforcing a
  real person-based quota. Guest browser limits must be described as approximate.
- Paste a supported URL; show resolved title/artist/version and duration before
  accepting it. Spotify/Apple matching must use the selected resolver strategy,
  with disambiguation rather than silently choosing an unrelated recording.
- Surface unsupported provider, invalid link, unknown/over-limit duration,
  duplicates, unavailable source, quota exhaustion, and moderation state.
- Prevent duplicate submission on retries. Enforce all rules server-side.
- Show pending/approved/queued/playing/played/rejected/failed/cancelled states as
  appropriate, remaining allowance, and queue timing based on the chosen policy.
  Do not present a guaranteed exact ETA when the queue can change.
- Include withdrawal or replacement only after their quota implications are set.
- QR targets the configured canonical public route. A test QR must point to a
  reachable test origin rather than a phone's own localhost.

## Exit gate

Test new and returning users, event spanning midnight, retry/double tap,
unsupported/malicious URL, overlong item, mismatched version, moderation, quota
refund policy, and two clients seeing consistent queue state. Use local metadata
and auth fixtures so routine checks do not rely on live provider APIs.

Own attendee UI/resolver integration files as assigned. The backend remains the
authority for quotas, moderation, ordering, and provider validation.
