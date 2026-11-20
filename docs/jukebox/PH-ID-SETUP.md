# PH ID setup

PH ID (`purduehackers/id`) exposes OpenID Connect discovery, authorization code with PKCE, and a member application registration page.

## Registration

In PH ID's **Your applications** page create an application named **Purdue Hackers Jukebox**. Use **Confidential**: the service keeps its secret on the server. Enter one callback per line, exactly:

```
http://127.0.0.1:5173/auth/callback
https://jukebox.purduehackers.com/auth/callback
```

The first is for local development; the second is for production. If PH ID rejects a callback, do not substitute a different URL without also configuring that exact origin in Jukebox. Select `openid`, `profile`, and `roles`; the last supplies the `organizer`/`admin` claim. Email, offline access, device sign-in, and user-data scopes are unnecessary. PH ID's application page creates confidential clients with `client_secret_basic`; Jukebox uses that method and PKCE S256.

Store the resulting client secret privately on the server; do not commit it. For local use copy `.env.example` to `.env.local`, then fill it in once. `bun run dev` and its startup script load `.env.local` automatically (ignored by Git; exported env vars take precedence). Set:

```
JUKEBOX_PHID_CLIENT_ID=<client id>
JUKEBOX_PHID_CLIENT_SECRET=<client secret>
JUKEBOX_PHID_REDIRECT_URI=http://127.0.0.1:5173/auth/callback
JUKEBOX_SESSION_SECRET=<random secret of at least 32 characters>
```

Generate the session secret once with `openssl rand -base64 32` and keep it stable across restarts. Do not prefix private credentials with `VITE_` (those variables are exposed to the browser). Run `bun run dev`, visit `http://127.0.0.1:5173/queue`, and sign in. Startup uses PH ID whenever a client ID is set; without it, `--dev-auth` is required for local fake sign-in.

The service stores opaque session identifiers as hashes and keeps identity and role claims server-side for 12 hours. Roles are captured at login and do not refresh during that session. `organizer` or `admin` grants Jukebox admin; an explicit `JUKEBOX_ADMIN_KEYS` allowlist is also supported. Discovery and endpoint requests are restricted to the configured PH ID origin, HTTPS except loopback tests, without HTTP redirects. Userinfo over that trusted connection is authoritative.

## Organizer display and stream authorization

Organizer/admin PH ID access is required for `/display` and `/visual`. After signing in, the display connects automatically. Automatic player tokens require a current organizer cookie on every request, including SSE; a bearer alone is insufficient. Logout immediately closes affected streams. Expiry/revocation is checked before every snapshot and on the five-second heartbeat via local SQLite lookups without extra PH ID requests.

## Token exchange CSRF guard

PH ID blocks browser-like `Sec-Fetch-Mode: cors` POSTs on token exchange (`Cross-site POST form submissions are forbidden`), so `src/adapters/oidc-http.ts` uses Node HTTP transport without browser Fetch Metadata headers.

## Role changes after sign-in

Jukebox saves the PH ID roles returned at login; checking `/auth/me` or refreshing an admin snapshot does not fetch new provider claims. If PH ID grants a role after login, sign in again via `/auth/login?returnTo=/admin` (the forbidden admin screen's **Check again** button triggers this).

## Local hostname consistency

The development server redirects local aliases to the configured origin (or the registered PH ID callback origin). Use `http://127.0.0.1:5173` consistently so the login state cookie and same-origin CSRF checks match.

When reusing a saved service database from another checkout, also reuse the same worker/cache directory via `JUKEBOX_WORKER_DATA` so cached media asset IDs match.
