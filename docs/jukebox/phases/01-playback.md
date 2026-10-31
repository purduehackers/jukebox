# Phase 1: prove playback

Status: audio-only and separate repo confirmed; worker/hardware choices pending.

## Goal

Demonstrate the intended listening experience before committing to a provider or
building the full interface. Use a minimal local page with two manually supplied
playable items: a long master mix and a short request. Keep source resolution
and the shared backend out of this first experiment.

## Discussion and work

- Read `AUDIO-RESEARCH.md`. Prove an audio-only source resolver and temporary
  seekable audio asset in the new Jukebox repo. No video player/download fallback
  is acceptable. Define supported request link types separately from media sources.
- Test the target OS/browser's activation/autoplay behavior, volume, play/pause,
  seek, end events, and useful errors. A successful play command is not proof of
  audible playback: listen to the HDMI output on the real machine when available.
- Save master mix item and position, switch to a request, let it finish, and resume
  master from the saved position. Measure practical seek accuracy and any gaps.
- Test an unavailable/embed-disabled item, network loss, and refresh. Record
  limitations rather than masking them with fake success.
- Confirm a normal master song finishes before a due request, while a mix longer
  than six minutes is interruptible. After requested music, the next turn follows
  another 15 minutes of master playback. Slot size remains open.
- Keep a suspended master mix pinned in cache and clean up unused assets after
  completion. Validate audio-only source selection and final media stream types.
- Determine whether one audio element swapping items suffices. Do not add simultaneous
  players or crossfades unless behavior requires them and the provider supports it.
- Inspect source APIs and audio access before promising a real visualizer. Keep
  decorative animation and measured audio response distinct.

## Deliverables and exit gate

A runnable local spike, a short feasibility note with observed results and exact
browser/provider, a proposed playback adapter contract, and an accepted source
decision. The core proof is master → request → master at its saved position.
If only development hardware is available, mark wall/HDMI validation pending.

The adapter should describe capabilities such as seek and native volume, and
emit actual ready/playing/paused/buffering/ended/error observations. It should
not contain scheduling, identity, or URL-matching policy. Provider account and
metadata API requirements must be recorded before stage 2 treats them as available.
