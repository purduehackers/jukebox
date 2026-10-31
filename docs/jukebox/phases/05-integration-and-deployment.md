# Phase 5: integration, rehearsal, and deployment

Status: after the core phases and infrastructure answers. No deployment is part
of the current planning task.

## Local integration

1. Provide one documented startup path for service, app, storage, fixtures, fake
   auth, and metadata resolver. Pick non-conflicting ports; the current dashboard
   and API-v4 defaults both use 3000.
2. Run separate browser profiles/devices as attendee, organizer, and designated
   player. Validate that the user/organizer pages produce no music.
3. Simulate a full event with an accelerated clock, across midnight and any Lunar
   schedule boundaries. Exercise quota reset, empty queues, moderation, repeated
   commands, track errors, connection loss, device lease expiry, and refresh.
4. Rehearse on the real laptop and wall: window placement, audio activation,
   HDMI route, sound coexistence, sleep recovery, QR reachability, and emergency
   fallback. Keep simulated success distinct from hardware success.

## Preview deployment

- Confirm repo ownership and write access, hosting project, runtime, durable
  storage, event isolation, provider credentials, and identity callback setup.
- Use preview-only storage, credentials, and device pairing. Preview commands must
  not reach the production player or queues, even when accounts are shared.
- Deploy compatible app/service contracts and database migrations deliberately.
  Confirm reconnects and mixed-version behavior before changing production.
- Re-test real provider playback on the preview origin; origin/referrer/autoplay
  behavior can differ from localhost. Record provider quotas and account needs.
- Validate the chosen audio worker process/storage, audio-only format selection,
  range requests, suspended-mix pinning, cleanup, and origin/auth behavior. A
  frontend deployment alone does not establish that the media worker is running.

## Production and DNS

1. Create/configure the approved hosting project and attach
   `jukebox.purduehackers.com`. Obtain the actual assigned DNS target and any
   verification records. Do not invent them or reuse another project's CNAME.
2. Prepare a separate DNS-repo change for `zones/purduehackers.com/jukebox.yaml`;
   read its local instructions and run the current `cli:validate` / `cli:plan`
   workflow. Its `main` deployment job applies zone changes to Cloudflare.
3. Follow the engineer's deployment/merge procedure, verify DNS, HTTPS, routes,
   callbacks, websocket origin authorization, and public read versus device/admin
   access. If desired, implement the separate `music` redirect explicitly.
4. Verify production pairing and actual output with an organizer present. Define
   fallback music, emergency stop, manual recovery, and rollback owner.

## Exit gate and operations handoff

The agreed night-long rehearsal succeeds; pending hardware checks are resolved;
production state survives supported reconnect/restart cases; and the organizer
has a short runbook covering start event, activate audio, pair device, manage
requests, recover connection, stop event, and roll back. Include state backup/
retention and credential rotation responsibilities appropriate to the chosen
service. Document known limits rather than promising uninterrupted provider audio.
