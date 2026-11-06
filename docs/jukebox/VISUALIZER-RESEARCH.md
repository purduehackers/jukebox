# Stationary soundbar research — 2026-11-05

The final display uses the user-approved preset in
[references/soundbar-approved-settings.json](references/soundbar-approved-settings.json).
Tuning values below are research starting points and do not override that preset.

Scope: a fixed bass-to-treble spectrum, mirrored vertically, with the measured
scalar field passed through the dashboard's purple/black Bayer dithering.
The goal is readable drum-and-bass movement without scrolling, autonomous motion,
beat-synchronised decoration, microphone capture, or changes to playback.

## What caused the left-only appearance

Code inspection found three compounding mechanisms:

1. The old mapping converted FFT dB to linear amplitude. At sensitivity 12,
   a −60 dB component produces only 0.012 height, versus 0.38 at −30 dB.
   Raising sensitivity cannot usefully balance that contrast before bass clips.
2. Each logarithmic band averaged its FFT-bin powers. High-frequency bands span
   more bins, so a narrow component is diluted more on the right than on the left.
   Broadband components also retain the music's falling per-bin spectrum.
3. A tiny height can disappear entirely through the soft edge and Bayer threshold.
   Increasing contour smoothing can further reduce a narrow isolated peak.

These explain a plausible failure path from the code and screenshot. No live
spectrum of the user's particular track was captured; they do not establish
that the track contains equally strong content at every frequency.

## Evidence and implications

### Use logarithmic frequency and compressed display levels

Ableton's Spectrum plots frequency horizontally and dB vertically; it offers
logarithmic frequency scaling, block size, averaging and display-range controls.
Its documentation explicitly describes the activity-versus-smoothness tradeoff
of averaging. This supports separating frequency mapping, level mapping and time
response instead of asking one sensitivity slider to fix everything.
[Source: Ableton Live manual, Spectrum](https://www.ableton.com/en/manual/live-audio-effect-reference/#spectrum).

For this app, retain logarithmic x positions, integrate linear power in each band,
convert the result back to dB, then map a bounded dB interval to height. The new
starting interval is −80 to −20 analysis dB. This is a visual calibration, not a
calibrated loudness meter or a guarantee about full-scale sine-wave readings.
The analyser's window and the band's bandwidth affect the reported energy.

### Distinguish band energy from spectral density

SciPy explicitly distinguishes power spectral density (units per Hz) from squared
magnitude spectrum. That distinction matters when bins are grouped into bands
whose bandwidth changes with frequency.
[Source: SciPy periodogram documentation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.periodogram.html).

Our recommendation is integrated band energy for this entertainment display.
Sum bin powers with fractional boundary overlap. Do not average dB values, and
do not divide by the number of bins after integrating. A narrow treble tone then
avoids the previous width-dependent dilution. Broad treble percussion can
contribute energy across its band. This is a design choice, not proof that one
aggregation rule is correct for every measurement task.

Analytically, summing over equal-ratio bands also changes the apparent spectral
slope: for an ideal 1/f power density, the integral between f and r·f is constant.
Thus a pink-noise-like signal should be broadly level across resolved bands
without an additional tilt. FFT resolution and window leakage limit that
approximation in the lowest bands.

### Treble tilt is useful, but depends on the measurement

FabFilter documents a 1 kHz pivot and adjustable dB-per-octave tilt, with 4.5 dB/oct
as its default. It also describes faster spectrum release as exposing dynamic
changes more clearly. Voxengo SPAN independently documents its 4.5 dB/oct default
and warns that it elevates the top end relative to other analysers.
[Source: FabFilter spectrum analyser](https://www.fabfilter.com/help/pro-q/using/analyzer),
[Source: Voxengo SPAN manual](https://www.voxengo.com/files/userguides/VoxengoSPAN_en.pdf).

Those are product choices, not a universal DnB standard. Because our display
already integrates widening bands, start additional tilt at zero, then audition
+1 to +3 dB/oct if hats and snare detail need more weight. The lab exposes −3 to
+6 dB/oct around 1 kHz. Weighting affects the picture only. Avoid independently
normalising every band: that can make quiet hiss look as energetic as the drop.

### Balance bass resolution against transient response

The Web Audio specification defines a Blackman window, frequency-domain
smoothing and conversion to dB. Its default smoothing coefficient is 0.8.
Sonic Visualiser explains that larger analysis windows improve frequency
resolution at the expense of time resolution.
[Source: Web Audio analyser specification](https://www.w3.org/TR/webaudio/#fft-windowing-and-smoothing-over-time),
[Source: Sonic Visualiser reference](https://sonicvisualiser.org/doc/reference/5.0.0/en/).

At 48 kHz, 2048 samples cover 42.7 ms with 23.4 Hz bin spacing; 4096 cover
85.3 ms with 11.7 Hz spacing. At 44.1 kHz, 4096 cover 92.9 ms. These are window
spans, not measured end-to-end visual latency; window shape, rendering and device
latency also matter. More plotted bands cannot create missing FFT resolution.

The lab now uses 4096 and disables built-in smoothing, leaving one explicit,
time-based attack/release envelope. This is a compromise to test with music.
If breakbeat attacks feel smeared, compare 2048 before adding onset detection.
A later dual-resolution design could use a longer window for sub-bass and a
shorter window for percussion, but it adds complexity and is not implemented.

### Onset detection is an optional second stage

AudioLabs' spectral novelty tutorial demonstrates logarithmic compression to
expose weak transients, including hats, and spectral flux formed from positive
spectral changes. It also warns that aggressive compression can lift noise.
[Source: Müller and Villar-Corrales, spectral-based novelty](https://www.audiolabs-erlangen.de/resources/MIR/FMP/C6/C6S1_NoveltySpectral.html).

For this basic stationary visualizer, begin with the spectrum envelope. If
sustained bass masks rhythmic movement after tuning, consider a small, local
per-band onset accent. Avoid a global beat pulse that makes all frequencies
move together. BPM estimation is unnecessary for the requested geometry.

## Recommended tuning sequence

These values are engineering starting points, not published optimum settings
or measured preferences from the user's track.

| Parameter | Starting point | What to audition |
| --- | --- | --- |
| Frequency span | 40 Hz–12 kHz | Lower to 30 Hz if useful sub information is missing |
| Bands | 48 | 32–64; fewer bands are usually easier to read at a distance |
| Display floor/range | −80 dB / 60 dB | Lower the floor for missing detail; widen the range if peaks flatten |
| Sensitivity | 1 | Affects visual level only; adjust after the display range |
| Extra tilt | 0 dB/oct | +1 to +3 for a brighter picture if the track needs it |
| Attack/release | 10 / 110 ms | Attack 5–15, release 80–140 for distinct fast drum motion |
| Contour smoothing | 1 neighbouring band | 0–2; heavy averaging removes narrow detail |
| Height | 0.85 | Keep headroom for drops |
| Dither size/density/edge | 2 px / 0.75 / 12 px | Tune only after the underlying function reads well |

For an illustrative 174 BPM track, one beat is about 345 ms and a sixteenth
note about 86 ms. A 110 ms exponential release retains about 46% after 86 ms;
this gives movement without immediately snapping to zero. It will not separate
every fast event, and densely limited music can have little amplitude contrast.
Do not fix missing rhythm by making all bands permanently tall.

First switch to **Show underlying function**. Tune the dB range until bass,
midrange and percussion remain distinguishable without persistent saturation.
Then adjust attack/release. Finally switch dithering back on and tune density,
edge softness and cell size. The undithered view is the same purple scalar field,
including density and edge falloff, before Bayer thresholding. It is not a
separate approximation or a different audio signal.

## Validation and remaining limits

Automated regression coverage checks silence, fixed tone positions, quiet treble,
wide-band tone dilution, energy conservation across fractional boundaries,
weighting, invalid inputs and continuous undithered output. Isolated Firefox
uses real Web Audio tones through a zero-gain destination and the actual lab
component; it does not mount a second live player or change the night/queues.
See the decision log for the measured result.

Representative full-track listening is still necessary: compare a bass-heavy
drop, a sparse breakdown, bright percussion and a dense sustained section.
Do not demand that the whole width light up when the recording lacks that
content. Venue viewing distance, HDMI synchronisation and actual DnB-track
preferences are not established by synthetic tone checks.

The existing analyser downmixes for analysis. Unusual out-of-phase stereo content
can cancel in a mono analysis signal. Separate channel-power analysis is a future
option if a specific recording demonstrates that problem; this change does not
rewire the player's audio graph. The main display transfer remains pending user
review of the lab.
