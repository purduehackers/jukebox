# Designated Firefox player

Phase 4C composes `<Player />` from `Player.tsx` exactly once in its display page.
The current `DisplayPage` only adds this frame to the shared placeholder. Replace
that composition during integration; do not mount a second audio source.

The frame opens silently. Pair using an admin-issued code, claim playback, then
click **Activate audio locally** on the display. Pairing persists in localStorage;
a lease and activation never persist. Reload requires claim/activation again.
A normal claim never takes over a live tab or another device. Explicit same-device
takeover fences the old generation. Every successful claim waits a full 15-second
old lease before starting audio, including ordinary claims after admin revocation;
heartbeat reports keep the new lease alive during that wait. Another device must
wait for expiry or be authorized by admin revocation of the previous device.

`controller.ts` reconciles full desired snapshots, owns the single native audio
and Web Audio chain, and publishes through `shared/audio-tap.ts`. The server owns
scheduling, retry budgets, refunds, retention and checkpoints. The controller does
not download provider media, calculate turns or mark requests played on load.
Load/seek/play waits are bounded to eight seconds each; technical errors go to the
service, which gives the specified two total load attempts. Autoplay denials report
`needs_activation` rather than consuming a playback-failure attempt.

Lease deadlines use both monotonic and wall clocks, conservatively from the start
of each accepted claim/report request. A separate 100 ms watchdog silences expiry;
SSE fencing and STALE_LEASE silence immediately when observed. Stale asynchronous
media events cannot restart unowned playback. A service interruption may continue
within the remaining lease; beyond it this tab stops and requires a new local
claim/activation. A frozen/sleeping event loop can execute its silence check only
when the browser resumes JavaScript; real laptop sleep/wake and HDMI remain venue
gates. The browser cannot control OS/HDMI volume.

Run `./scripts/check` and `.venv/bin/python scripts/verify-player.py`. The latter
uses independent Firefox profiles and actual Python-worker fixture media. It
retains production lease/heartbeat constants and injects due scheduling through a
loopback-only test fixture, never through the production service.
