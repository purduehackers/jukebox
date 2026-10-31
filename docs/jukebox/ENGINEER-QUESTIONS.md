# Questions for the infrastructure engineer

Draft for the user to send or discuss. No external message has been sent.

## Needed before choosing the implementation home

1. The user chose a separate `purduehackers/jukebox` repo, now created. Who should
   own the app and production operation? Which frontend hosting and audio-worker
   runtime/storage should it use?
2. `patiowizard` has ADMIN on the new repo but read-only on the dashboard. What
   contribution route should we use for eventual dashboard integration changes?
3. Which coordination service currently serves `api.purduehackers.com`? API v4
   describes Vercel/Hono + Redis/Turso, but the DNS repo's `api.yaml` is marked
   Workers-managed. Is it migrated, routed through Cloudflare, or still on v3?
4. Should Jukebox reuse that service/database infrastructure, use a Cloudflare
   Durable Object like Lunar, or own isolated storage? What runtime, quotas, and
   cost constraints should we design for?

## Needed before identity and remote-control integration

5. What is the current supported PH ID OIDC integration and process for registering
   local, preview, and production callback URLs? How should organizer privileges
   be checked? Which claim is a stable user identifier?
6. How should a venue playback browser be enrolled/paired and revoked? Is there
   an existing device credential pattern we should reuse?
7. Is there an existing signal for announcements/checkpoints/midnight across
   systems, or does it currently exist only in the dashboard browser? Who defines
   audio priority and when music should pause or duck?

## Needed before staging and production

8. Is `night.purduehackers.com` deployed from `master` through the Vercel Git
   integration? Who controls preview protection, environment variables, domain
   setup, and rollback? Which credentials should this new service receive?
9. Is DNS repo GitOps the required path for `jukebox`? Should we also set up a
   `music` redirect? Public DNS currently returns no A/CNAME for either name.
   What domain target/verification should the hosting project supply?
10. What is the wall's actual laptop/OS/browser, resolution, display topology,
    fullscreen/window arrangement, HDMI audio path, and startup procedure?
    Does the checked-in Ubuntu Mac Mini playbook relate to that device?
11. How does Lunar's wall display run today? Is iframe embedding supported, and
    who owns changes involving its layout, camera controls, or play windows?
12. Who can run a preview rehearsal and the first production night, and what is
    the expected fallback if the jukebox is unavailable?
13. Where should the audio-only preparation/cache worker run: the venue laptop
    or hosted compute? Are there existing media services to reuse, and who will
    maintain source extraction updates and event-end cleanup?
14. Which dashboard font assets should be shared into Jukebox? We have inventoried
    the precise colors/fonts/shader settings and should preserve the org's actual
    assets and intended font weights.

Do not request secrets in chat. Use private credential entry/configuration when
implementation actually needs them; docs should contain names and purposes only.
