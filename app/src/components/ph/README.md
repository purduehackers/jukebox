# Official Purdue Hackers components

Copied from the React registry at https://components.purduehackers.com/r/react/
on 2026-11-05, following `.claude/skills/purdue-hackers-ui/SKILL.md`.
The registry files include their required dependencies (`icon`, `icons`, `cn`,
and `dither`). Icons are from HackerNoon Pixel Icons (CC BY 4.0).

`../../shared/ph.css` is the official `/r/ph.css`, with font families renamed
to `PH UI …` so they cannot override the display's existing fonts.
`dither-button.css` is imported through `../../shared/ph-ui.css` instead of
the component so all PH CSS passes through the same selector scoping.
The shuffle's indexed reads have non-null assertions for this project's strict
TypeScript configuration; its algorithm is unchanged.

Tailwind v4 uses its theme and utilities without global Preflight. The PostCSS
configuration prefixes the resulting PH entry's selectors with `.ph-ui`.
Keep `dark` on each UI route wrapper, never on `html` or `body`.
