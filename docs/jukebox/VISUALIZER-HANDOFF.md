# Audio visualizer chat handoff

This handoff accompanies the committed universal-display baseline on `main`.
The next chat must be bound to an isolated worktree of that exact pushed commit.
The user wants to work on the audio visualizer next; no new visual design or
behavior change has been specified yet. Start the normal local app in the new
worktree, report readiness, then ask what visualizer change the user wants.

Read AGENTS.md, docs/jukebox/README.md, DECISIONS.md, PHASE-4C-DISPLAY.md and
DESIGN-REFERENCE.md. Main visualizer files: app/src/display/Visualizer.tsx,
signal.ts, Tuner.tsx and display.css. `/display?tune` exposes existing tuning.
The current visualizer is real audio-driven purple/black dithered geometry,
mirrored waveform with integrated tapered wisps and high-frequency bounce.
Reuse the actual fonts, colors and analyser; do not invent signal or request a mic.

## Preserve this baseline

- Universal automatic display, no pairing, linking, exclusive playback gate,
  15-second startup wait or app Enable sound button. Firefox site autoplay
  permission still applies. Start/End night starts/stops sound; closed night
  reads Night not started. Reloads resume near durable checkpoints.
- One ordered state subscription. Native audio drives each display's local
  progress/status. Paused shared checkpoints stay fixed across heartbeats.
  Do not reintroduce the two-display paused-time flicker.
- Display request panel keeps its QR, Song requests heading, URL and original
  dimensions. Only PH ID / three-per-night helper copy was removed.
- Queue page hides Getting ready badges. Preserve the existing minimal UI.
- Keep admin/queue official dark PH components separate from display styling.
- See PLAYER-CONNECTION-AUDIT.md for playback changes and measured evidence.

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
