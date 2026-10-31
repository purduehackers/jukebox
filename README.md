# Purdue Hackers Jukebox

An audio-only music queue and venue player for Hack Night.

Intended origin: `https://jukebox.purduehackers.com`.

This repository currently contains the planning baseline. There is no implemented
runtime, production deployment, or configured jukebox domain yet.

**For review:** [the consolidated plan for approval](docs/jukebox/APPROVAL-PLAN.md)
summarizes confirmed requirements, proposed remaining defaults, and phase order.
Implementation and phase-chat launches wait for the user's approval.

- `/display`: designated laptop music player and wall presentation, with HDMI audio.
- `/admin`: remote organizer controls and queue management.
- `/queue`: attendee requests reached through a QR code.

The master queue supports ordinary songs and long mixes. Ordinary songs finish
before a due user request; mixes longer than six minutes may be interrupted and
resumed at the saved position. After requested music, the next turn follows another
15 minutes of master playback. Exactly one user song plays per turn. Attendees
sign in with Purdue Hackers ID and get three songs per person per admin-managed
night session. Valid requests enter automatically; admins can remove them.
Empty request turns wait for another 15-minute interval. Quota accounting and
some failure/timer edge cases are still being decided. The display uses Firefox.
No video media should be downloaded, streamed, or embedded.

Start with [the project plan](docs/jukebox/README.md),
[decisions](docs/jukebox/DECISIONS.md),
[audio pipeline research](docs/jukebox/AUDIO-RESEARCH.md), and
[exact dashboard design reference](docs/jukebox/DESIGN-REFERENCE.md).
Ordered implementation prompts and separate phase briefs are included.

The [Hack Night dashboard](https://github.com/purduehackers/hack-night-dashboard)
is the visual reference. It runs on a separate independent monitor and is outside
the implementation scope. Jukebox uses the dashboard's actual fonts, colors,
borders, and dithering in its own application and display.
