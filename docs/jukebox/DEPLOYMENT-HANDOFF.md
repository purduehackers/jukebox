# Deployment and DNS operator handoff

Updated 2026-11-06. See [current status](CURRENT-STATUS.md) for the implementation and verified release gates. Preparation for the infrastructure discussion; no message has
been sent and no hosting, DNS, or production change is authorized by this document.
Canonical app: `purduehackers/jukebox`, intended hostname
`jukebox.purduehackers.com`. The existing Hack Night dashboard is independent.
This checklist supersedes speculative options in ENGINEER-QUESTIONS.md where the
local implementation now supplies an answer.

## Questions to ask the operator

1. Who owns deploying, reviewing, and operating Jukebox, and who can approve the
   DNS change in `purduehackers/dns`? What is the current PR/apply procedure?
2. Can we use the existing server the user reported? Confirm OS/architecture,
   Node runtime, Python/ffmpeg/source-tool support, CPU/RAM, persistent disk size,
   network egress/source availability, SSH/deploy access, and process supervision.
   The app needs a long-running queue service and audio preparation worker;
   static frontend hosting alone is insufficient. Evaluate this server before
   proposing new paid infrastructure.
3. What public ingress/reverse proxy will terminate HTTPS and serve the built app,
   `/auth/*`, `/api/*`, and `/media/*` under the same origin? Confirm SSE streaming
   without proxy buffering, suitable timeouts, and audio Range/HEAD support.
   Keep worker management endpoints and service ports private. The local service
   currently binds loopback; agree how the proxy reaches it.
4. What exact DNS record type, target, TTL, proxy mode, and any ownership/certificate
   verification records does that hosting/ingress setup require? Obtain the actual
   assigned values; do not invent an IP/CNAME or copy another app's target. Who
   owns certificate issuance and renewal?
5. Where will the SQLite state and media cache persist across deploys/restarts?
   Agree one queue-service writer, storage/cache limits, backup/restore, cleanup,
   logs, restart policy, and migration/rollback procedure. Separate preview data,
   credentials, display registrations, and worker/cache resources from production.
6. Who manages the PH ID application's production callback, client secret, and
   organizer/admin roles? Confirm whether the current application should remain
   personally owned or be transferred/recreated under an organization operator.
   Who rotates credentials and handles loss of access?
7. Who can rehearse on the real venue laptop/Firefox/HDMI and own the first night,
   fallback music, emergency stop, and rollback?

## Values and configuration to bring

- Hostname: `jukebox.purduehackers.com`; public pages `/queue`, `/admin`, `/display`.
- Production OIDC callback: `https://jukebox.purduehackers.com/auth/callback`.
- Local callback: `http://127.0.0.1:5173/auth/callback`.
- PH ID confidential client, authorization code + PKCE, `client_secret_basic`;
  requested scopes `openid profile roles`. No email, device-flow, or offline
  access requirement. Stable identity key is issuer plus subject.
- Server-only variables: `JUKEBOX_PHID_CLIENT_ID`,
  `JUKEBOX_PHID_CLIENT_SECRET`, `JUKEBOX_PHID_REDIRECT_URI`,
  `JUKEBOX_SESSION_SECRET`, and `JUKEBOX_ORIGIN`.
  Production origin is `https://jukebox.purduehackers.com` and redirect URI is the
  production callback above. Keep the session secret stable across restarts.
  `JUKEBOX_ADMIN_KEYS` is an optional existing explicit identity allowlist.
  Supply actual secrets through private operator configuration, never DNS,
  frontend bundles, repository files, tickets, or chat.
- Build/start commands, internal ports, worker URL, persistent paths, resource
  limits, and QR public-origin configuration must be finalized with the selected
  deployment. `npm run dev` is the local Vite workflow, not a production launcher.

## Gates before asking to apply DNS

Choose the hosting target first, then prepare the DNS change in its own repository
using that repository's current instructions and validation/plan procedure.
The planned file is `zones/purduehackers.com/jukebox.yaml`; verify the layout when
working there. Do not add a `music` alias or change dashboard DNS as part of this.

Before public operation: fix event-stream reauthorization after logout/session
expiry and protect the public automatic-display connect/report boundary, complete production ingress and abuse controls, verify durable restart
and backup behavior, test real audio-source access from the server, and rehearse
Firefox audio/seek/recovery with the venue output. After DNS/HTTPS are ready, test
production sign-in, organizer permissions, attendee rejection from admin actions,
QR reachability, same-origin media/range seeking, and automatic display connection/playback. Local
success does not verify production or hardware behavior.

## Current identity evidence

On 2026-11-02 the user supplied a screenshot of `/queue` signed in as
`patiowizard` after the token-transport fix. This verifies user-observed live PH ID
sign-in to the local app. The user is obtaining organizer/admin privileges;
live role-based admin access is pending. Roles are captured at login, so sign out
and sign in again after a role is granted, then visit `/admin`. No client ID or
secret is recorded here. See PH-ID-SETUP.md for integration details and regression
coverage.

## Current display and baseline correction

Automatic displays no longer pair or hold an exclusive lease. They remain
connected between nights; Start/End night starts/stops audio, and multiple tabs
may play. Preserve this UX when protecting report routes for public deployment.
The latest reviewed source is `32c265a` on `origin/main`; do not deploy an old phase
branch or a stale local main. `./scripts/run-dev` starts real worker/media by
default and loads private `.env.local`. Production still needs a separate process,
proxy, persistent-storage and operations configuration; see CURRENT-STATUS.md.
