# Ordered phase chat prompts

Approval checkpoint: read APPROVAL-PLAN.md first. Do not launch these chats until
the user approves the consolidated plan. Once approved, align the prompts and
decision log with its accepted defaults; start with playback feasibility only.

These are templates for future chats, not instructions to start implementation
now. The user has returned and chosen a separate repo, audio-only playback,
song/mix interruption, one request per turn, a fresh 15-minute master period,
PH ID, a three-song admin-managed night quota, automatic admission, Firefox,
two independent monitors, and exact dashboard styling. Settle timer edge cases,
quota accounting, source/failure behavior, and worker location before dependent work.

## Workspace and sequencing

- Current planning branch: `feat/jukebox-planning` in `purduehackers/jukebox`,
  based on the new repo's `main`. Docs were carried over from the dashboard
  discovery branch; no dashboard app history or unrelated demos were copied.
- The implementation repo is now <https://github.com/purduehackers/jukebox>, with
  ADMIN access. Bind future implementation chats to that project/repo, not the
  dashboard. The dashboard checkout is a visual reference only; do not modify it.
- Before launching a worktree, commit the accepted planning/contracts baseline:
  separate worktrees begin from commits and do not inherit uncommitted documents.
- Use T3's explicit workspace strategy for ordinary new chats. Choose the actual
  local parent branch with `startFromOrigin: false` for dependent work; later
  stages must include predecessor commits. Do not launch dependent work from
  stale `master`, or ask an agent to change directories as a substitute for binding.
- Use separate worktrees for concurrent implementation. Assign one integration
  owner to shared contracts, migrations, and common app wiring. Each phase reports
  its branch, head commit, validation, limitations, and proposed integration changes.
- Do not start phase 2 until phase 1 resolves feasibility; then integrate contracts
  before phases 3/4. Parallel work is useful only once those dependencies exist.

## First: playback feasibility

> Read AGENTS.md and docs/jukebox/{README,DISCOVERY,DECISIONS}.md, then
> docs/jukebox/phases/01-playback.md. We are implementing the accepted playback
> experiment for Purdue Hackers Jukebox. Check the decision log for the selected
> provider, repository, and hardware; ask about any remaining blocking choice.
> Build the smallest localhost proof of long-master playback, pause and save
> position, play one request, and resume master. Test real provider events and
> autoplay/error behavior. Record observed results and seek accuracy, propose the
> adapter contract, and clearly mark any wall/HDMI tests still pending. Do not
> build the queue/admin system in this phase. Preserve unrelated demos/ work.
> Read AUDIO-RESEARCH.md and prove audio-only extraction/cache delivery. Never
> stream/download video as a fallback. Keep a suspended mix cached through the
> request, support browser seek via the selected media endpoint, and clean up
> unused assets. Ordinary songs finish; mixes over six minutes may be interrupted.
> Test Firefox. Each request turn plays exactly one song, then another 15 minutes
> of master playback. An empty turn waits a new interval; follow the decision log
> for its confirmed reset point and pause/buffering accounting.
> The user confirmed that pauses/buffering do not freeze the elapsed master timer,
> empty turns reset it, and accepted submissions count with technical failure refunds.
> Establish a usable analysis path from the actual playing audio for the required
> dithered visualizer. Leave its final signal/rendering design to the display chat.

## Second: shared contracts, persistence, and scheduling

> Read AGENTS.md, docs/jukebox/README.md, DECISIONS.md, the completed phase-1
> findings, and phases/02-state-and-scheduling.md. Implement the agreed shared
> state/service in the selected repository and runtime. Use the exact recorded
> scheduling, identity, moderation, quota, and recovery policies. Establish one
> typed contract for commands/events/snapshots, durable queue and master checkpoint
> state, device authority, authorization, retry safety, and local fixtures. Prove
> behavior with a fake clock/player and concurrent clients. Be the integration
> owner for shared contracts until parallel phases are integrated. Report a stable
> baseline commit before the UI/player chats start.
> Inspect the existing purduehackers/id repository/code before PH ID integration;
> use the current supported flow rather than building a new identity provider.

## Third group: launch only after the phase-2 baseline

### Player

> Read AGENTS.md, docs/jukebox/DECISIONS.md, the phase-1 results, the shared service
> contract, and phases/03-player.md. Implement the authorized playback browser
> against those contracts. Include local audio activation, real playback reports,
> master checkpoints, command acknowledgement, bounded failure recovery, and lease
> loss handling. Validate remote control from another profile/device and a second
> display without duplicate authorized audio. Own player adapter/device files;
> coordinate shared schema changes with the integration owner. Keep presentation
> minimal while the display phase owns the final layout.

### Admin, parallel

> Read AGENTS.md, docs/jukebox/DECISIONS.md, the shared service contract, and
> phases/04a-admin.md. Implement organizer-only controls and both queue-management
> views with mock player fixtures first. Include play/pause, skip/replay, seek,
> volume, confirmed playback status, reorder/remove, and the accepted source/import
> and moderation features. Test conflicts and offline/failed commands. Own admin
> UI files and coordinate shared schema changes with the integration owner.

### Attendee queue, parallel

> Read AGENTS.md, docs/jukebox/DECISIONS.md, the shared service/resolver contracts,
> and phases/04b-requests.md. Implement the QR destination and accepted identity,
> link preview/resolution, submission, quota, moderation, and queue-status flow.
> Validate duration against the playable version, handle retries, and make all
> server failures understandable. Use fixtures rather than production credentials
> for routine checks. Own attendee UI and assigned resolver integration files;
> coordinate shared schema changes with the integration owner.
> PH ID is required, with three songs per admin-managed night session. Admit valid
> requests automatically; support admin removal without inventing an approval gate.

### Dedicated jukebox display, parallel

> Read AGENTS.md, docs/jukebox/{DISCOVERY,DECISIONS}.md, the shared snapshot contract,
> and phases/04c-display.md. Implement the agreed wall layout using fixture states,
> then connect read-only now-playing/next-slot/QR presentation. Keep playback in
> the player-owned boundary. Use Jukebox's independent monitor and Firefox. The
> existing dashboard is a visual reference only; no widgets, chat/layout edits,
> or cross-dashboard announcement integration are in scope. Implement any Lunar
> sharing only as decided during the dedicated display discussion, and
> inspect any related repo's instructions before changing it. A real playing-audio
> listener driving the dithered visualization is required. Use the user's sketch
> in references/display-sketch.png; discuss the detailed signal/shader/layout design
> in this phase. Do not replace the requirement with decorative looping motion.
> Follow DESIGN-REFERENCE.md precisely for colors, font assets, borders, and the
> dashboard's dithering settings; avoid substituting the wider site's palette.
> The user reports an existing capable server. Consider it when discussing workload
> placement, but do not assume specifications, access, or a server-rendered video path.

## Last: integration and deployment

> Read AGENTS.md and all completed phase results, then
> docs/jukebox/phases/05-integration-and-deployment.md and ENGINEER-QUESTIONS.md.
> Integrate the accepted phase branches into the agreed parent branch; reconcile
> contracts and migrations before deployment. Run the local multi-device/night
> rehearsal, resolve hardware checks, and prepare isolated preview deployment.
> Follow the confirmed org hosting/DNS workflow for jukebox.purduehackers.com.
> Verify domain routes, identity callbacks, device/admin authorization, playback,
> reconnect, and rollback. Deliver a short organizer runbook and state any remaining
> observed limitations. Do not invent DNS targets or reuse production state in
> previews. Register every PR worked on with this thread when T3 PR linking is
> available.
> Evaluate the user's existing capable server before proposing new hosted compute.
