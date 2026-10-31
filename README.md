# Purdue Hackers Jukebox

An audio-only music queue and venue player for Hack Night.

Intended origin: `https://jukebox.purduehackers.com`.

This repository currently contains the planning baseline. There is no implemented
runtime, production deployment, or configured jukebox domain yet.

- `/display`: designated laptop music player and wall presentation, with HDMI audio.
- `/admin`: remote organizer controls and queue management.
- `/queue`: attendee requests reached through a QR code.

The master queue supports ordinary songs and long mixes. Ordinary songs finish
before a due user request; mixes longer than six minutes may be interrupted and
resumed at the saved position. After requested music, the next turn follows another
15 minutes of master playback; the number of requests per turn is still open.
No video media should be downloaded, streamed, or embedded.

Start with [the project plan](docs/jukebox/README.md),
[decisions](docs/jukebox/DECISIONS.md),
[audio pipeline research](docs/jukebox/AUDIO-RESEARCH.md), and
[exact dashboard design reference](docs/jukebox/DESIGN-REFERENCE.md).
Ordered implementation prompts and separate phase briefs are included.

The [Hack Night dashboard](https://github.com/purduehackers/hack-night-dashboard)
is the visual reference and possible integration target. Jukebox is a separate
application; use the dashboard's actual fonts, colors, borders, and dithering.
