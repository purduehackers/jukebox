# Repository, infrastructure, and playback findings

Observed 2026-10-30. No DNS, hosting, or auth configuration was changed. Initial
research was read-only; the separate Jukebox repo was subsequently created after
the user chose it. Repo claims and verified public behavior are distinguished below.

## Workspace and GitHub

- Origin: <https://github.com/purduehackers/hack-night-dashboard>.
- Original local branch: `dashboard-audio-stuff` at `9d59001`.
- Fetched upstream and created `feat/jukebox-planning` from current `origin/master`,
  commit `d0ca5177638d11bca158cb78468b2ce85105dedd`.
- Existing untracked `demos/` was preserved and is outside this plan's changes.
- GitHub reports `viewerPermission: READ`. `git push -u origin
  feat/jukebox-planning` failed with HTTP 403: permission denied to `patiowizard`.
  At that point the dashboard planning branch could not be published. Future
  dashboard changes require write access or a maintainer-approved contribution
  route. The user subsequently chose and authorized the separate repo below.
- Update: the user chose a separate org repo. GitHub's org-level
  `viewerCanCreateRepositories` was true; creation of
  <https://github.com/purduehackers/jukebox> succeeded, with ADMIN access.
  The dashboard's read-only restriction does not block the new repository.

## Dashboard code map

| Area | Current implementation |
| --- | --- |
| Framework | Next.js 16.1.6 App Router, React 19.2.3, TypeScript, Tailwind 4, Bun lockfile |
| Main route | `src/app/page.tsx` dynamically renders `Dash` |
| Composition | `src/components/dash/dash.tsx`: title/shader, lightning and ordinary clocks, Discord feed, sessions, countdown, wake lock |
| Styling/layout | `src/app/layout.tsx` supplies fonts, full viewport layout, and fixed outer padding; large fixed text/spacing in dashboard components |
| Live chat | `discord-feed.tsx` uses reconnecting WebSockets at `wss://api.purduehackers.com/discord/dashboard`; chat side can be changed locally |
| Announcements | `sessions.tsx`, notification provider, and `coordinator.tsx` coordinate overlays/checkpoints inside this React tree |
| Midnight sound | `countdown.tsx` plays `/clock.mp3`; `useSound` wraps browser audio |
| Doorbell | Files remain, but current upstream comments out dashboard wiring and activation UI; do not assume it is active |
| Config | `src/lib/config.ts` reads Vercel Edge Config for metadata/version/defaults |
| Config refresh | `/api/update-hash` plus `use-update-checker.tsx`: checks on mount, then 30 seconds after each completed check, with 10-second timeout; refreshes server components while preserving client state |
| Sessions API | `/api/sessions` proxies CMS sessions and optionally hydrates Discord user information |
| Observability | Sentry client/server/edge configuration and `/observe` tunnel |

There is no jukebox queue, music transport, attendee identity flow, or admin panel
in the inspected dashboard code. The current React coordinator does not cross
tabs, origins, or devices. It cannot alone coordinate a separate jukebox browser.

The reference dashboard has existing sounds besides future music. The user's
later scope clarification excludes cross-dashboard coordination; Jukebox owns its
own playback controls. HDMI alone does not coordinate the two pages' volume.

## Local development evidence

The README describes `bun dev` on port 3000. `playwright.config.mjs` builds and runs
the production app on 4117 against local Edge Config/CMS fixtures on 4118. Tests
mock the Discord socket and client telemetry. This gives a good pattern for
isolated development. Plain `bun dev` is not demonstrated to work without config:
`getConfig` calls the Edge Config SDK before applying value defaults.

No `node_modules/` or `bun` executable was available on the current shell PATH at
inspection. Node and npm were present. No packages were installed for this
documentation task and no application tests were run. The deployment phase must
document repeatable setup; avoid requiring production secrets to get started.

## Hosting: confirmed and unknown

- `https://night.purduehackers.com` returned HTTP 200 with Vercel response headers.
- GitHub's latest observed successful Production deployment points to commit
  `d0ca517...`, matching this planning branch's base, and a Vercel deployment URL.
- `next.config.ts` configures Sentry for `purduehackers/hack-night-dashboard`.
- There is no checked-in dashboard deployment workflow or project-specific
  Vercel routing configuration. The README's generic deployment section alone
  does not prove Git integration settings, deployment permissions, or branch rules.
- `mac-mini/playbook.yml` sets up Ubuntu basics, firewall, and Tailscale. It does
  not provision the browser kiosk, HDMI routing, app hosting, or wall windows;
  inventory contains an empty host. It is not evidence that the proposed laptop
  is the same machine or already configured.
- Live dashboard browser inspection was attempted twice; both snapshots timed
  out with `Preview automation snapshot timed out after 15000ms.` Visual layout
  conclusions above come from code, not a successful live screenshot.

## DNS

[DNS repo](https://github.com/purduehackers/dns), inspected at
`46fdc987013ceeac30921d9bd009e2562fdf88d6`, stores YAML under
`zones/purduehackers.com/`. Public NS lookup returned Cloudflare nameservers
`harlee.ns.cloudflare.com` and `vin.ns.cloudflare.com`.

[`night.yaml`](https://github.com/purduehackers/dns/blob/46fdc987013ceeac30921d9bd009e2562fdf88d6/zones/purduehackers.com/night.yaml)
contains CNAME `327fcb04983df083.vercel-dns-016.com`; public DNS matched it.
The inspected tree had no `music.yaml` or `jukebox.yaml`. Public Google DNS queries
for both A and CNAME returned no answer for either hostname, and HTTPS fetches
failed name resolution. This describes the observed public state; it does not
establish who reserved a name or whether an internal/draft service exists.

The checked-in [deployment workflow](https://github.com/purduehackers/dns/blob/46fdc987013ceeac30921d9bd009e2562fdf88d6/.github/workflows/deploy.yml)
runs a plan followed by an apply job in the `production` environment on pushes to
`main` affecting zone/config files, or manual dispatch. The exact environment
approval policy is not visible here. Current package scripts are `cli:validate`,
`cli:plan`, `cli:apply`, and `cli:pull`; the README uses some older short names.

For a Vercel-hosted jukebox, first obtain the **new project's actual** assigned
domain target and any verification instructions, then propose the corresponding
`jukebox.yaml` change. Do not copy the dashboard's project-specific CNAME. DNS
routes hostnames; `/admin`, `/queue`, and `/display` routing belongs to the app.
Whether `music` should redirect to `jukebox` is a separate product/hosting choice.

## Related systems worth evaluating

- [API v4](https://github.com/purduehackers/api-v4/tree/efa341cb4e8cb3153070431c8b49698deddc2506):
  Hono service; README and code describe a Node HTTP/WebSocket server on Vercel,
  Redis coordination, and Turso/Drizzle durable records. Good candidate pattern
  for queue coordination. No jukebox routes exist in the inspected entrypoint.
  DNS currently marks `api` as Cloudflare Workers-managed, while this repo
  describes Vercel. The active production version/routing needs engineer
  confirmation; do not assume this repo is what serves the dashboard today.
- [Lunar](https://github.com/purduehackers/lunar/tree/4903bbc1c660d3094205d7f4eb96c3d0475a6a62):
  Astro, canvas, PartyServer, Cloudflare Durable Objects. Has `/display`, remote
  `/camera`, persistent display/session options, and Hack Night play windows.
  README says Hack Night play pauses for the first 45 minutes of each hour from
  9 p.m. and opens for the final 15, using Purdue local time. Verify current
  behavior before integration; this schedule is not the jukebox schedule.
- [Purdue Hackers ID](https://github.com/purduehackers/id): current README describes
  an OIDC provider with discovery at
  `https://id.purduehackers.com/api/auth/.well-known/openid-configuration`, client
  registration, and PKCE. A separate old NextAuth example uses different legacy
  endpoints and disables checks. Do not copy it as current production auth.
  Verify discovery, supported claims, organizer authorization, and callbacks.

## Playback constraints and implications

Update after user answers: audio only is mandatory, and any visible/hidden video
playback is ruled out. The iframe findings below remain background research, not
the selected architecture. See [audio pipeline research](AUDIO-RESEARCH.md) for
the current extraction, cache, and native browser audio proposal.

- The [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference)
  supports play/pause, volume, position queries, seeking, and playback/error
  events. These are suitable primitives to **test** master pause/resume. An embed
  is not guaranteed to play every video; verify blocked autoplay, unavailable
  items, embed-disabled videos, and the target browser.
- YouTube's [player requirements](https://developers.google.com/youtube/terms/required-minimum-functionality)
  and [developer policies](https://developers.google.com/youtube/terms/developer-policies)
  constrain player visibility and hiding/obscuring controls. These requirements
  do not meet the user's chosen audio-only experience; extraction feasibility
  must be investigated separately rather than hiding the official video player.
- [Spotify's Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk)
  plays Spotify in a browser, and its [getting-started guide](https://developer.spotify.com/documentation/web-playback-sdk/tutorials/getting-started)
  requires a personal Premium access token. This would add a playback-account
  and authorization dependency. A Spotify link used as a song request does not
  by itself supply a playable YouTube match.
- Link resolution requires provider-specific metadata access, matching the right
  recording/version, duration checks, failure handling, and possibly credentials
  and quotas. Availability for Spotify/Apple Music metadata is not yet proven.
  Start with a bounded list of URL types and prove each claimed capability.
- The [Web Audio visualization model](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Visualizations_with_Web_Audio_API)
  needs access to an audio source. The YouTube IFrame API does not expose a PCM
  audio stream for an `AnalyserNode`. Therefore a true reactive visualizer needs
  a separately demonstrated capture/source approach. A decorative animation is
  a different capability and must be described honestly.
- Current [Vercel WebSocket docs](https://vercel.com/docs/functions/websockets)
  describe support, maximum-duration disconnects, reconnection, and external
  shared state. Do not rely on the outdated blanket claim that Vercel cannot
  host sockets. Whether we use this path, API v4, or a Durable Object is open.

## Suggested boundaries to discuss

The user confirmed a separately deployable Jukebox repo, with the dashboard used
as the exact visual reference. They explicitly excluded changes to the existing
dashboard/chat/layout and confirmed two independent monitors. Do not add dashboard
widgets or cross-dashboard announcement coordination. Jukebox runs independently
in Firefox on its own monitor. Hosting and media worker placement
still need decisions. The wider website review is in
[the design reference](DESIGN-REFERENCE.md).

For the scheduler, prefer a persisted next-deadline plus atomic state transitions
and player acknowledgements. A page interval or function-local 15-minute timer
cannot provide reliable state across restarts and concurrent clients. The
remaining timer/accounting edge cases are tracked in the decision log. Confirmed:
one user song per turn, a fresh 15-minute master period afterward, and waiting a
new interval after an empty turn.
