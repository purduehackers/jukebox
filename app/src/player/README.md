# Session-driven Firefox player

`/display` owns one native audio element and a Web Audio analyser. It attempts
sound activation when the page opens and shows **Enable sound** if Firefox blocks
it. No pairing code, device claim, local storage setup, or admin action on the
display is required. Autoplay permission cannot be granted by a remote admin.

The page watches the shared session in the background. During an open session it
uses `display.connect` to receive page-scoped player credentials and a lease. Only
one display can hold that lease; other tabs remain silent and retry without
stealing a live player. Refresh/checkpoint/release is automatic, with the normal
15-second lease expiry as the fallback if unloading cannot reach the service.
Each new connection waits out one 15-second lease before producing sound, while
renewing its own lease, to cover a disconnected player after admin revocation.
A session end immediately stops local audio and leaves the empty session screen.
Browser sound activation survives session changes and reconnection in the same
document; a refreshed document follows the browser's existing autoplay permission.

Commands, checkpoints, bounded media retries, asset pinning, epoch acknowledgement
and the independent lease watchdog remain authoritative. Admin and attendee pages
contain no audio player. No source video is used. The controller publishes actual
local analysis via `shared/audio-tap.ts`; remote display state does not fabricate
a music visualization.

Verify with `./scripts/check`, `.venv/bin/python scripts/verify-player.py`, and
`.venv/bin/python scripts/verify-display.py`. They use isolated local state,
synthetic audio, and fresh Firefox profiles. HDMI output and physical wall checks
remain venue tests.

The display's public closed-session snapshot also stops the local controller in
the same render commit as the empty-night screen. It uses the controller's existing
revision/time fences and can only stop sound, never grant playback authority.
This prevents the visual screen and native audio from diverging when the separate
bearer stream is delayed after reconnect. The Firefox player verifier deliberately
holds private closed-session snapshots while leaving the public feed live and
keeps its immediate paused assertion.
