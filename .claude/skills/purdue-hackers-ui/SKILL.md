---
name: purdue-hackers-ui
description: Build Purdue Hackers websites with the official components, colors and type. Use when making or restyling any Purdue Hackers site, page or event microsite, or when someone mentions Purdue Hackers branding, the dither/pixel button, the glider logo, Pixel Hackers font, or @purduehackers/ui.
---

# Purdue Hackers UI

Components and brand tokens for Astro and React (Next.js, Vite, Remix) sites on Tailwind v4. Code is copied into the project, so edit it freely after install.

## Setup

Everything lives at https://components.purduehackers.com. Needs Tailwind v4.

1. Theme: download `https://components.purduehackers.com/r/ph.css` next to the Tailwind entry CSS and add `@import "./ph.css";` right after `@import "tailwindcss";`.
2. Components: fetch `https://components.purduehackers.com/r/<astro|react>/<name>.json`. Write each entry in `files` to `src/components/ph/<path>` (Astro) or `[src/]components/ph/<path>` (React). Then fetch everything listed in `requires` the same way, and install `dependencies` with the project's package manager. `https://components.purduehackers.com/r/index.json` lists every component.
3. More icons: copy entries from `https://components.purduehackers.com/r/icons.json` into `icons.ts`.

Never hand-write tokens or copy components from other sites. Astro components are default exports (`import Button from "./components/ph/Button.astro"`); React ones are named (`import { Button } from "./components/ph/button"`).

## Components

| name | use | key props |
| --- | --- | --- |
| `dither-button` | the main call to action | `href`, `tone`, `cols`, `rows`. Follows `.dark` |
| `button` | every other action | `variant` solid/outline/ghost, `size` sm/md/lg (lg matches dither-button height), `icon`, `iconEnd`, `href` |
| `navbar` | site header with mobile menu | `links`, `tone`, `current`, `homeHref` |
| `nav-link` | single navbar link | `href`, `tone` |
| `footer` | site footer | `links`, small print as children |
| `event-card` | an event | `title`, `href`, `date`, `time`, `location`, `category`, `image` (list layout) |
| `post-card` | blog post in a list | `title`, `href`, `date`, `description`, `authors` |
| `page-header` | top of an article or section page | `title`, `date`, `updated`, `align`; authors as children |
| `prose` | markdown / MDX article body | wrap the content |
| `author` | person chip | `name`, `avatar`, `size` |
| `callout` | aside or notice | `title`, `icon` |
| `back-link` | return to an index | `href` |
| `video-embed` | YouTube | `id`, `title` |
| `lightning-text` | gradient text in Lightning Time colors | wrap the words |
| `card` | any boxed content | `title`, `href`, `media` |
| `badge` | small label | `color`: default, yellow, purple, pink, blue, lime, teal, orange, outline |
| `input`, `field`, `checkbox` | forms | `Field` takes `label`, `hint`, `error` |
| `tabs` | switch between panels | `tabs`, then `TabPanel value` children |
| `dialog` | modal | Astro: `id` + `data-ph-dialog-open="id"` on a trigger. React: `open`, `onOpenChange` |
| `segmented-toggle` | 2–4 option switch | `options`, `value`. Astro emits `ph:change`; React has `onValueChange` |
| `theme-toggle` | dark mode switch | put `ThemeScript` in `<head>` |
| `marquee` | scrolling announcement strip | `text`, `duration`, `reverse` |
| `skeleton` | loading placeholder | size with classes |
| `link` | inline text links | `href`, `tint` |
| `icon` | pixel icons | `name`, `label` |
| `glider`, `lightning-glider` | logo mark | `tintLinks` on the lightning one |
| `separator`, `numbered-list` | structure | `label` on separator |
| `tile`, `reveal-row` | project grids and lists | `title`, `href`, `meta`, `image`, `description` |
| `logo-grid` | sponsors | `logos: { name, src, href, width, height, transform }[]` (sizes normalized to a 48px base), `tone` |

Event categories map to colors: hack night = yellow, workshop = pink, show = orange, anything else = purple.

## Type

- **Headlines:** `ph-headline` (Pixel Hackers). Big, tight, sentence case.
- **Sub headlines and labels:** `ph-subheadline` (Inconsolata semi-bold, uppercase).
- **Body:** default `font-sans` (PolySans).
- `font-mono` is Inconsolata.

## Color

- **Light (default):** cream `bg-background` with black text. Accent text in `text-ph-purple` or `text-ph-blue`.
- **Dark:** add `dark` to a wrapper. Black background with white text. Accent text in `text-ph-yellow` or `text-ph-pink`.
- **Full palette:** `ph-black`, `ph-cream`, `ph-yellow`, `ph-purple`, `ph-white`, `ph-pink`, `ph-orange`, `ph-lime`, `ph-teal`, `ph-blue`, `ph-periwinkle`. Prefer semantic tokens (`background`, `foreground`, `primary`, `border`) for surfaces.

## Rules

- No gray text on cream. Secondary text stays black. Use size, weight or font for hierarchy, not opacity.
- No eyebrow text (small labels above headings).
- No rounded corners, ever. The theme removes Tailwind's radius scale, so don't add `rounded-*` or `border-radius`. No pill buttons, gradients or glass.
- Buttons press to 0.97 scale.
- Lines are 1px `border-border` hairlines. `dither-field` fills empty image slots. `grid-bg` / `grid-bg-animated` give a graph-paper background.
- Icons come only from the HackerNoon Pixel Icon Library (CC BY 4.0, credit it in the footer).
- Motion is short and purposeful. Use `enter` with `style="--i: n"` to stagger page load. All components already respect reduced motion.
- Text selection is yellow. It's set by the theme, so don't override it.
