# Link compatibility and queue controls workstreams

Authorized by the user on 2026-11-02, from the consolidated app at `b24cdd3`.
The coordinating thread is `mcp:14aa214f-a4db-4bc6-bc84-eca837a69fce`.

## Integration and delivery

The coordinator owns final integration on `feat/jukebox-integration`. Two focused
chats use isolated worktrees and feature branches from this same committed
baseline; they do not concurrently edit one checkout. Each chat commits, tests,
and pushes its own feature branch, then reports its exact head SHA, changed
interfaces, checks, and limitations to the coordinator. Neither independently
updates `feat/jukebox-phid`, `feat/jukebox-display`, `main`, or the integration
branch. The coordinator combines both branches, resolves conflicts, verifies the
complete app, and pushes the combined integration/PH ID/display branches together.
No production deployment is authorized by this work.

## Link compatibility

Branch: `feat/jukebox-link-compatibility`. Covers YouTube URL handling, metadata
resolution, real audio-worker wiring, and live Spotify/Apple Music metadata and
recording matching. Owns source validation, worker/provider adapters, matching,
`src/server/main.ts` runtime wiring, and necessary queue submission feedback.

A video URL with a valid video ID plus playlist/radio/navigation parameters must
still identify one recording. Actual playlist-only imports remain a separate
feature. Time/share parameters must not break song resolution or bypass duration
limits. Investigate clean share-link failures separately; do not assume all
unavailable-source errors are URL parsing failures. Preserve audio-only media,
bounded provider work, server-side validation, and honest matching provenance.
Use fixtures routinely and report real-source results separately. Live catalog
credentials, if needed, are a configuration requirement, not implemented support.

## Queue playback and admin UI

Branch: `feat/jukebox-queue-playback-controls`. Model: Claude Sonnet 5.5, high.
This is an interactive product/implementation chat with the user. Explore a simple
way to play a particular request next, take one request turn on demand, choose
master/automatic/request-only playback, and change the request interval.
Those controls are requested capabilities; exact labels, switching semantics,
empty-request behavior and timer-reset behavior are not yet user decisions.
Preserve saved mix positions, single-player authority, actual acknowledgement,
durable state, and admission/refund accounting. New scheduling choices must live
in the service, not in a browser timer. Preserve the existing default 15-minute
policy and normal-song completion rule unless the user explicitly changes them.

Owns admin UI, queue scheduling/control commands, shared snapshot/validation types,
service/DB migrations and tests needed for this feature. This ownership is scoped
to this workstream; the coordinator reviews the shared contract/migration changes
before combining them. Document the proposed command/snapshot/migration contract
before implementation, and notify the coordinator. The link chat must propose any
shared-contract changes rather than changing these files concurrently.

## Running app

Worktrees start from commits; untracked credentials and `.local` state are not
copied. Do not copy credentials or real session databases into commits. Preserve
PH ID configuration and never silently replace real sign-in with fake sign-in.
Use isolated ports/state for automated tests. Do not interrupt the user's existing
5173/8980 processes without explaining a necessary restart.

## Chat references

- [Link compatibility: YouTube, Spotify and Apple Music](t3-thread://v1/mcp:509ee740-1362-4afe-ad3b-fcc85cf230ce)
  uses Codex CLI Main / `gpt-6.1-sol`, high effort.
- [Queue playback controls and timer](t3-thread://v1/mcp:24c48184-a2f6-4dd9-8425-1f344ee00724)
  uses Claude / `claude-sonnet-5-5`, high effort (selection verified at launch).

Both launched from the committed coordination baseline `f9de59b`. Completion and
contract proposals must be sent to the coordinator named above, so the final
combined push is reviewed rather than left as unrelated feature branches.


## Integration review in progress

The link branch completed at `fc5c383` (commits `d554586`, `fc5c383`) and is merged
locally into integration. Its routine suite passed 21 Python, five policy and 126
TypeScript tests, both typechecks/build, plus 47 Firefox admin checks. Actual source
proof covered the reported mix and a matched Spotify/Apple recording as audio-only
Opus 251 with Firefox analysis/seek/resume; a later network-script master admission
hit intermittent upstream format unavailability. The full network app script is
not recorded as a pass. Optional authenticated catalog API paths remain fixture
verified only; public catalog paths were live-tested. Details are in
[Link compatibility](LINK-COMPATIBILITY.md).

An unchanged player verification exposed a closed-night display/audio race after
reconnect. A baseline rerun measured closure but did not reproduce that exact
ordering. A controlled Firefox comparison then withheld private closed-night
snapshots: baseline failed the immediate paused assertion, while integration's
public-session stop bridge passed. The bridge preserves revision/time fencing;
public data can stop audio but cannot grant it authority. The regression is added
to the full player verifier. Full merged verification and combined push still
await the queue-control branch.
