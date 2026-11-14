Purdue Hackers UI primitives live in two forms, both sourced verbatim from
`https://components.purduehackers.com`:

- Static Astro templates live under `src/components/ph/*.astro`.
- Client/DOM string builders and pure helpers (`cn.ts`, `dither.ts`, `icons.ts`,
  `html.ts`) live here, styled via `app/src/shared/ph-ui.css` so PostCSS scopes
  all PH rules under `.ph-ui`.
- `dither-button.css` is imported inside `app/src/shared/ph-ui.css` rather than
  inside individual components so `.ph-ui` scoping stays intact and `/display`
  and `/visual` remain uncontaminated.
