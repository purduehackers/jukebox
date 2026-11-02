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
