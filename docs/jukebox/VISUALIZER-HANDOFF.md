# Approved soundbar display handoff

Final user decision (2026-11-05): put the original approved stationary soundbar
on `/display` and push it to `main`. Keep `/visual` for future tuning. All wisp,
extra-gradient, outline, cutout and warp experiments were rejected and removed.
Do not reintroduce them without a new request.

## Implementation

- `app/src/visual/soundbar.ts`: approved 14-value preset, stationary logarithmic
  spectrum, explicit attack/release, scalar field and 4x4 Bayer threshold.
- `app/src/visual/Soundbar.tsx`: shared Canvas renderer consuming the player's
  analyser. FFT 4096, built-in smoothing disabled, no extra audio graph/player.
- `/display` imports the fixed approved preset. Its behaviour is independent of
  browser lab storage. Preserve exact reaction settings and flush side edges.
- `/visual` keeps the original sliders, Reset, Copy settings and underlying-field
  toggle. Lab settings save locally and do not alter the main display preset.
- `references/soundbar-approved-settings.json` archives the user's exact values.
  `VISUALIZER-RESEARCH.md` is background research, not a replacement preset.

## Preserve player and presentation behaviour

Universal automatic display; Start/End night starts/stops sound. No pairing,
linking, lease gate, startup delay or app sound-enable button. Native autoplay
is attempted; Firefox site permission still applies. Closed nights show Night
not started. Reloads resume near checkpoints. Keep local progress and paused
checkpoint handling stable (see PLAYER-CONNECTION-AUDIT.md).

Keep the request QR, Song requests heading and URL. Preserve the removed
PH ID/three-per-night helper line and hidden Getting ready queue badges.
Admin/queue styling remains separate from the display identity.

Use isolated muted audio or silent display fixtures for verification. Avoid
opening another live player tab while the user is listening. Never infer HDMI
or venue behaviour from software checks alone.

## Local runtime handoff

The user explicitly requested stopping the old worktree's localhost app and
starting the normal app from the new visualizer worktree. The old launcher must
be stopped before starting the new one. Existing normal ports: app 5173,
service 8980, real worker 8971. Do not change the night, queue or quota for setup.

Private configuration source (not committed):
`/home/patio/.t3/worktrees/purdue-hackers-jukebox/feat-jukebox-dark-ph-components/.env.local`.
The new chat is authorized to reuse/copy this file privately into its worktree.
Never print secrets or switch to fixture auth for the normal preview.

Preserve both state paths together:
- Service data: `/home/patio/.t3/worktrees/purdue-hackers-jukebox/feat-jukebox-phid/.local/service`
- Worker/cache: `/home/patio/.t3/worktrees/purdue-hackers-jukebox/feat-jukebox-phid/.local/dev-worker`

The private configuration pins JUKEBOX_WORKER_DATA to the original cache. An
empty/new worker directory previously made persisted audio assets return 404;
do not repeat that mistake. Start `scripts/run-dev --data <service path>` from
the new worktree, with private logs/PID under that worktree's .local directory.
Keep PH ID configured and the real worker. Confirm health, /admin, /display and
an existing media asset remain available. Use the canonical local origin
http://127.0.0.1:5173; localhost redirects there before auth cookies are set.

A T3 preview is a separate live playback instance from the user's Firefox tab.
The old chat's preview has been closed. Do not leave a new live display preview
running after your check. For layout-only checks, `/display?displayFixture=master`
is explicitly a silent fixture with no player; close it afterward. Use isolated
Firefox workflows for actual media changes and make no HDMI hardware claim.
