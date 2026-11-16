Official Purdue Hackers UI components, copied verbatim from
`https://components.purduehackers.com` (see `.agents/skills/purdue-hackers-ui/SKILL.md`).
Never hand-write tokens or components.

Two flavors, each used where it belongs:

- **Astro flavor** (default exports): `*.astro` in this directory, used by `.astro`
  pages and components — e.g. `src/components/SignInGate.astro` renders the
  server-side sign-in gates on `/admin` and `/queue` with no client JavaScript.
- **React flavor** (named exports): `*.tsx` in this directory, used only inside
  the React islands (`client:load`) in `src/{admin,queue}`.
- **Shared assets**: `cn.ts`, `dither.ts`, `icons.ts`, and `dither-button.css` live
  once in this directory and are shared between both flavors.

Styles: `src/shared/ph-ui.css` is the Tailwind v4 entry (official
`@tailwindcss/vite` plugin) for the PH-styled pages; it imports `ph.css` and the
dither-button styles. It is imported by `src/pages/admin.astro` and
`src/pages/queue.astro` only, so `/display` and `/visual` stay uncontaminated.
