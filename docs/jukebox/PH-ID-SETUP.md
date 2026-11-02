# PH ID setup and local verification

PH ID's [source](https://github.com/purduehackers/id) at `eacf5a7e46cb091f1825262b538119f409aa56e6` exposes OpenID Connect discovery, authorization code with PKCE, and a member application registration page. Jukebox already had an adapter and routes on the integrated baseline. This phase hardens discovery and redirects and verifies the complete HTTP login and logout against a local provider fixture. On 2026-11-02 the user verified live local sign-in with a registered client; their screenshot shows `/queue` signed in as `patiowizard`. Live organizer/admin access remains pending a PH ID role grant.

## Registration

In PH ID's **Your applications** page create an application named **Purdue Hackers Jukebox**. Use **Confidential**: the Node service keeps its secret on the server. Enter one callback per line, exactly:

```
http://127.0.0.1:5173/auth/callback
https://jukebox.purduehackers.com/auth/callback
```

The first is for the local Vite development origin; the second is the intended production origin, not a claim that it is deployed. If PH ID rejects a callback, do not substitute a different URL without also configuring that exact origin in Jukebox. Select `openid`, `profile`, and `roles`; the last supplies the organizer/admin claim used by the existing Jukebox admin rule. Email, offline access, device sign-in, and user-data scopes are unnecessary. PH ID's application page creates confidential clients with `client_secret_basic`; Jukebox uses that method and PKCE S256. PH ID's source currently allows members to register applications; this supersedes the older phase-2 note that an ID admin must create clients.

Store the resulting client secret privately on the server; do not commit it or send it in chat. For local use set these environment variables in your shell or a private, untracked environment file:

```
JUKEBOX_PHID_CLIENT_ID=<client id>
JUKEBOX_PHID_CLIENT_SECRET=<client secret>
JUKEBOX_PHID_REDIRECT_URI=http://127.0.0.1:5173/auth/callback
JUKEBOX_SESSION_SECRET=<random secret of at least 32 characters>
```

Generate the session secret locally with `openssl rand -base64 32`. Run `npm run dev`, visit `http://127.0.0.1:5173/queue`, and sign in. The development script selects PH ID when a client ID is set; without it, it uses the clearly labelled local fake identity. The service remains loopback-only and is not a production deployment. For production, use the production callback and origin only after the separately planned hosting and ingress work.

The service stores opaque session identifiers as hashes and keeps identity and role claims server-side for 12 hours. Roles are captured at login and do not refresh during that session. `organizer` or `admin` grants Jukebox admin under the existing phase-2 implementation choice; an explicit admin-key allowlist is also supported. Discovery and endpoint requests are restricted to the configured PH ID origin, HTTPS except loopback fixtures, without HTTP redirects. Userinfo over that trusted connection is authoritative; the ID token is not signature-verified and is not used as authentication proof. Automated coverage uses fixtures; the user separately verified live local sign-in. Production deployment and live admin-role access remain unverified.

Existing integration limitation: an already-open event stream retains its initial role after session expiry or logout until it disconnects. Do not expose this local service to untrusted networks; stream reauthorization is required before deployment. The admin page polls session status, but that does not protect the stream itself.

## Live token exchange failure, 2026-11-02

The first real login returned `invalid_request` HTTP 403 during code exchange. A credential-free probe reproduced this with Node `fetch`: PH ID returned `Cross-site POST form submissions are forbidden`. Node's automatic `Sec-Fetch-Mode: cors` header triggers PH ID's browser CSRF guard (`src/lib/server/csrf.ts` in the ID repository). The adapter now uses Node's server HTTP transport without browser Fetch Metadata. The same live probe reaches OAuth validation and returns the expected HTTP 400 `unsupported_grant_type` for its deliberately invalid grant. This proves the transport clears the CSRF rejection; the user subsequently verified a fresh live sign-in on the local queue page. The local provider fixture now enforces this guard, and regression coverage reproduces the old failure before verifying login with the new transport.

For infrastructure, DNS, production callback ownership, and operator questions, see [Deployment handoff](DEPLOYMENT-HANDOFF.md). After PH ID grants an organizer/admin role, sign out and back in to refresh the server session before testing `/admin`.
