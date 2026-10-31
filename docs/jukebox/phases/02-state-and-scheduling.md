# Phase 2: shared state and scheduling

Status: separate repo and audio-only source direction confirmed. Exact scheduling,
identity, worker placement, and moderation choices still block final contracts.

## Goal

Make queue behavior precise and shared across devices. Select the service/runtime
using engineer input and phase-1 evidence, then implement the smallest durable
version with fake source/player adapters for local development.

## Proposed domain model

- Event/session: identity, start/end, quota period, policy configuration.
- Source submission: canonical submitted URL/provider/id, requester, lifecycle,
  metadata provenance, resolved playable item, duration, moderation outcome.
- Queue entry: stable ID, queue kind, ordering, item/version, lifecycle.
- Playback session: active entry, mode, intended state, observed state, saved
  master item/position, current device generation, last acknowledged command.
- Schedule: persisted due time or accumulated playback clock according to D04,
  plus the active request slot and policy revision.
- Device: pairing/authorization, active lease, expiry and heartbeat information.
- Prepared media: stable asset ID, audio codec/container, preparation state,
  cache references, lifetime, and failed-job cleanup. Keep a suspended mix pinned.

These are candidate concepts, not a prescribed schema. Do not store playback
position every animation frame; choose a recovery checkpoint interval after
defining the acceptable resume tolerance.

## Work and contracts

1. Write the behavior table for timer due, empty queues, end, skip, pause, failure,
   buffering, offline, and reset. Decide the midnight/event-boundary behavior.
   Honor the confirmed normal-song boundary and over-six-minute mix interruption
   rule. Request length validation is a separate policy from master classification.
2. Define typed commands, responses, events, public snapshots, errors, and
   authorization. Keep the shared contract in one clearly owned location.
3. Persist queue and scheduler transitions atomically. Use revision checks or
   equivalent ordering to handle simultaneous admin actions and requests.
4. Identify commands by stable IDs so retries cannot enqueue or skip twice.
   Fence stale devices using a lease/generation checked on every accepted report.
5. Reconnect by retrieving a current snapshot and resuming a known revision;
   stale events must not overwrite new state. Decide command acknowledgement
   timeout and how admin sees “requested” versus “confirmed by player.”
6. Enforce admin, attendee, and playback-device permissions server-side. Public
   `/display` rendering is not itself authorization to claim venue playback.
7. Separate pending resolution/moderation from ready-to-play entries. Validate
   duration and quotas on the server. Use provider URL allowlists and bounded
   resolver behavior; do not fetch arbitrary submitted URLs on the server.
8. Build fixtures, a fake clock, and a fake player/source resolver. Use a short
   simulated interval in tests without changing production policy.

## Exit gate

An agreed contract and local service with durable recovery, two-client shared
state, transactional ordering, and clear error paths. Meaningful tests cover
timer boundaries, master resume state, empty queues, stale/duplicate commands,
simultaneous changes, lease expiry, moderation/quota accounting, and reconnect.

Schedule and identity decisions must be settled before claiming this phase done.
The backend's time-based decisions must survive instance restarts; a sleeping
browser interval must not be their only trigger. A due transition can be reconciled
atomically when the designated player reconnects if that matches the chosen policy.
