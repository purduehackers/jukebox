# Exact dashboard visual reference

The user explicitly selected the Hack Night dashboard as the UI reference, even
though Jukebox will be a separate repo. Match the real assets/tokens rather than
approximating the brand. Reference revision:
`purduehackers/hack-night-dashboard@d0ca5177638d11bca158cb78468b2ce85105dedd`.

## Colors

From `src/app/globals.css`:

| Token | Exact value |
| --- | --- |
| Background variable | `#171717` |
| Foreground | `#ffffff` |
| PH yellow | `#ffee00` |
| PH amber | `rgb(253, 211, 74)` / `#fdd34a` |
| PH purple | `#7e3cff` |
| PH pink | `#efb9ff` |
| Main dashboard canvas/shader background | `#000000` |

The CSS background variable and the actual black dashboard canvas are distinct.
Preserve their roles; do not replace all surfaces with one near-black color.

## Fonts and structure

`src/app/layout.tsx` loads Inconsolata from Google and these local assets:

- `ABCWhytePlusVariableEdu-Regular.woff2` → Whyte.
- `polysanstrial-neutral.otf` → PolySans.
- `PixelHackers.woff2` → the pixel display face.

The dashboard defaults to Inconsolata for its body, uses PixelHackers for the
Hack Night title, and Whyte for the prominent lightning clock. Inventory also
contains a PolySans bulky italic asset. Use the selected real font files/weights
for the jukebox's corresponding roles; confirm org-provided asset reuse while
setting up the new repo rather than substituting lookalikes.

The source uses sharp rectangular panels with thin borders, purple divisions,
black surfaces, large deliberate spacing, pixel headings, and high-contrast type.
Match these choices while adapting sizes for phone-based admin/queue views.
Do not apply the dashboard's giant wall text sizes directly to mobile controls.

## Dithering

`src/components/dithered-soup.tsx` uses
`@paper-design/shaders-react`'s `Dithering` with:

- background `#000000`, foreground `#7e3cff` by default;
- shape `warp`, type `4x4`;
- size `2`, speed `0.04`, scale `1`;
- full container coverage with absolute positioning.

Reuse these settings as the starting reference. This generated shader motion is
separate from streamed video and from a measured music-reactive visualizer.

## Wider website review

The org's [site2026](https://github.com/purduehackers/site2026) uses Astro 6, React,
Tailwind 4, and a Vercel adapter. It includes Whyte, Inconsolata, PixelHackers,
PolySans weights, and Silkscreen. Its main stylesheet defines purple `#7d3bff`
and an off-white `#fffbf1` canvas, which differ from the dashboard's exact tokens.
Its repo describes hourly homepage ISR and a separately refreshed community feed.

The older [site](https://github.com/purduehackers/site) is a Next.js 13 Pages Router
app with a different Tailwind palette and font set. Repo names alone do not prove
which deployment currently serves the apex hostname. For Jukebox's visual work,
the supplied dashboard remains authoritative; do not mix in the other palette
simply because it is in a Purdue Hackers repo.

## Verification when UI work begins

Compare the real dashboard and jukebox at wall dimensions and on a phone. Check
computed font families/assets, exact color values, border widths/alignment,
spacing hierarchy, QR readability, long titles, errors, reduced-motion behavior,
and animation performance. There is no jukebox mockup or completed UI yet.
