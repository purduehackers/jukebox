Official Purdue Hackers UI components, copied verbatim from
`https://components.purduehackers.com` (see `.agents/skills/purdue-hackers-ui/SKILL.md`).
Never hand-write tokens or components.

Two flavors, each used where it belongs:

- **Astro flavor** (default exports): `src/components/ph/*.astro`, used by `.astro`
  pages and components — e.g. `src/components/SignInGate.astro` renders the
  server-side sign-in gates on `/admin` and `/queue` with no client JavaScript.
- **React flavor** (named exports): the `*.tsx` files and pure helpers (`cn.ts`,
  `dither.ts`, `icons.ts`, `dither-button.css`) in this directory, used only inside
  the React islands (`client:load`) in `app/src`.

Styles: `app/src/shared/ph-ui.css` is the Tailwind v4 entry (official
`@tailwindcss/vite` plugin) for the PH-styled pages; it imports `ph.css` and the
dither-button styles. It is imported by `src/pages/admin.astro` and
`src/pages/queue.astro` only, so `/display` and `/visual` stay uncontaminated.
