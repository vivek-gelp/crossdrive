# Crossdrive brand

**Tagline:** Every drive you own. One safe connection for your AI.

Alternates:
1. All your drives. One URL. Nothing permanently deleted.
2. Many accounts, one connector, rules in code.
3. Your clouds, connected on your terms.

Voice: calm, exact, engineer to engineer. Say what the code does. No hype words, no emoji, no user counts or testimonials.

## Colours

| Token | Light | Dark | Use |
|---|---|---|---|
| `--ink` | `#0E1116` | background | text, dark surfaces |
| `--paper` | `#F7F5F0` | text | page background |
| `--teal` | `#12B5A6` | same | first drive, focus rings |
| `--amber` | `#F5A524` | same | second drive, accent dot |
| `--overlap` | `#0B6B63` | `#0E8F84` | overlap, links, primary buttons |

Defined in `app/ui.css`, with dark values under `prefers-color-scheme: dark`. Do not use Google's four brand colours.

## Type

- Display and wordmark: Space Grotesk 500–700 (`next/font`, CSS variable `--font-space-grotesk`).
- Body: system UI stack.
- Paths and code: system monospace, e.g. `work:/Finance/2026`.

## Logo

Files in `public/brand/`: `crossdrive-mark.svg` (square), `crossdrive-logo.svg` (on light), `crossdrive-logo-dark.svg` (on dark), `social-card.svg` / `.png` (1280×640), `crossdrive-mark-512.png`. Site and MCP icons (`public/favicon.ico`, `icon.svg`, `icon-{32,48,192,512}.png`, `apple-touch-icon.png`) are
generated from `crossdrive-mark.svg` by `node scripts/make-icons.mjs`; `src/lib/brand.ts` lists them for the HTML
`<link>` tags, the web manifest and the MCP `serverInfo.icons`.

- The mark is two rounded squares on a 64 grid (teal 4–40, amber 24–60, radius 9); their overlap is a darker lens that reads as an X. Keep teal top-left, amber bottom-right.
- The wordmark is lowercase `crossdrive`, drawn as monoline paths (no font needed). The dot of the i is amber; everything else is one colour.
- Clear space around the logo: at least half the mark's height. Minimum size: mark 16 px, full logo 96 px wide.
- Don't recolour, rotate, add gradients or shadows, outline, or set the name in another typeface. In running text write "Crossdrive".
