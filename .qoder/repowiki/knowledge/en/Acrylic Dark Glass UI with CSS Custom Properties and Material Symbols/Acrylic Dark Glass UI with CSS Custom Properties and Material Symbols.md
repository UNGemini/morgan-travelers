---
kind: frontend_style
name: Acrylic Dark Glass UI with CSS Custom Properties and Material Symbols
category: frontend_style
scope:
    - '**'
source_files:
    - src/style.css
    - index.html
    - vite.config.js
---

## What system/approach is used

The project uses a **single-file, vanilla CSS** styling approach built on **CSS custom properties (design tokens)** to implement a dark "acrylic" glass aesthetic. There is no CSS framework (no Tailwind, Bootstrap, etc.) — all styles live in one stylesheet at `src/style.css` (~6400 lines), imported by the Vite build. The visual identity is explicitly aligned with the Morgandev acrylic theme (`/* MORGAN Travelers — Acrylic UI (aligned with morgandev.cc) */`).

Typography comes from Google Fonts: **Montserrat** for body/heading text and **Material Symbols Outlined** for icons, both preloaded via `<link>` in `index.html`. No icon component library beyond the Material Symbols font.

Responsive behavior is achieved through **CSS media queries** and **CSS container/layout variables** rather than a grid framework. The layout adapts between mobile bottom-sheet mode and desktop left-panel mode using `data-*` attributes on `.app-shell` (`data-ui-mode`, `data-toolbar`, `data-detail`, `data-sheet`) toggled by JavaScript.

## Key files and packages

- `src/style.css` — the entire visual style sheet; defines design tokens, resets, map chrome, panels, sheets, buttons, forms, animations, and responsive rules.
- `index.html` — shell HTML that declares PWA meta tags, loads Montserrat + Material Symbols fonts, injects a critical inline style to prevent FOUC, and wires the DOM structure consumed by `style.css`.
- `vite.config.js` — Vite build config; no CSS preprocessor plugins are configured, so this is plain CSS processed by Vite's default pipeline. It also sets dev server headers for COOP/COEP required by the WASM router.
- `public/manifest.webmanifest`, `public/icon-*.png`, `public/siteicon.png` — PWA assets referenced from the shell.

## Architecture and conventions

### Design tokens
All colors, spacing, radii, heights, and font families are declared as CSS custom properties under `:root` in `src/style.css`. Examples include `--bg-root`, `--bg-card`, `--text-primary`, `--accent` (#c0aefc purple), `--radius-sm/md/lg/xl`, `--panel-radius`, `--glass`, `--glass-border`, `--safe-top/bottom`, `--sheet-open-h/closed-h/full-h`, `--map-tools-bottom`, and `--glass-rgb`. Components consume these tokens instead of hard-coded values, ensuring consistent look-and-feel across the app.

### Glass/acrylic surface system
A reusable "liquid glass" effect is applied via:
- `backdrop-filter: blur(28px) saturate(1.35)` on `.main-toolbar`, `.profile-menu`, and other floating surfaces.
- A shared gradient background using `rgba(var(--glass-rgb), …)` with varying opacity stops to create a fade-through effect on the bottom dock (`.panel-bottom-stack::before`).
- An interactive border-lighting effect driven by `[data-acrylic]` elements that track mouse position via `--mouse-x` / `--mouse-y` CSS variables, producing a radial-gradient glow around hovered cards.

### Layout model
- The root `html`/`body` are fixed to `inset: 0` with `overflow: hidden` to support an edge-to-edge PWA experience (Dynamic Island, home indicator safe areas via `env(safe-area-inset-*)`).
- The map (`#map`) fills the viewport absolutely; UI chrome (left panel, bottom dock, route badge, status chip) overlays it with explicit z-index layering.
- The main toolbar (`#main-toolbar.main-toolbar`) is a rounded glass panel whose width is fluid (`min-width`/`max-width` based on `--panel-w` and viewport). On mobile it sits at the bottom as a sheet; on desktop it pins to the left side.
- The bottom dock (`.panel-bottom-stack`) is a sibling of the panel and contains mode pills, search toggle, and navigation — its visibility is controlled by `data-ui-mode` and page selectors.

### State-driven styling
Visual state is encoded in `data-*` attributes on `.app-shell` and toggled by JS:
- `data-ui-mode="eta"` vs trip-plan modes controls which sidebar pages and bottom-chrome sections are visible.
- `data-toolbar="open|closed"` slides the panel off-screen.
- `data-detail="open|closed"` pins the panel to full height.
- `data-sheet="open|closed"` controls sheet height via `--sheet-h`.
- Active states use `.is-active` classes on tabs/buttons.

### MapLibre integration
MapLibre GL controls are restyled via class selectors (`.maplibregl-ctrl-bottom-right`, `.maplibregl-ctrl-top-left`, `.maplibregl-ctrl-attrib`) to match the glass aesthetic — compact attribution, repositioned scale widget, and custom route-number badge (`.map-route-badge`) positioned relative to `--map-tools-bottom`.

### Responsive strategy
- Mobile-first base styles with `@media (max-width: 640px)` overrides for the route badge and tool positions.
- `clamp()` and `calc()` expressions drive fluid typography and sizing (e.g., `font-size: clamp(2.6rem, 12vw, 3.6rem)`).
- Safe-area insets (`env(safe-area-inset-top/bottom)`) ensure content avoids notches/home bars on iOS.
- `prefers-reduced-motion` media query disables transitions/animations for accessibility.

### Accessibility
- Semantic roles (`role="application"`, `role="menu"`, `role="listbox"`, `role="status"`) and ARIA attributes (`aria-expanded`, `aria-hidden`, `aria-live`, `aria-label`) are used throughout the shell HTML.
- Visually hidden status elements use the standard clip-based pattern (`.is-visually-hidden`).
- Keyboard shortcuts are documented in `title` attributes and `<kbd>` hints.

## Conventions and constraints

- **Single stylesheet**: All UI styling lives in `src/style.css`; there are no per-component CSS modules or SCSS/Sass preprocessing.
- **Token-only colors/sizes**: New UI elements should reference `:root` custom properties rather than introducing new hardcoded color/spacing values.
- **Glass surfaces via backdrop-filter**: Floating panels consistently use `backdrop-filter: blur(...) saturate(...)` with matching `--glass`/`--glass-border` tokens.
- **State via data attributes**: Visual state changes are driven by `data-*` attributes on `.app-shell` and sibling elements, not by adding/removing classes on the root.
- **Material Symbols Outlined**: Icons are rendered as `<span class="material-symbols-outlined">...</span>` with the Google Fonts variable font; no SVG icon set is used.
- **PWA shell**: The `index.html` includes critical inline CSS to avoid flash-of-unstyled-content before the main stylesheet loads, and sets `theme-color` to match the glass background.
- **No CSS framework**: The project does not import or configure any CSS framework; all components are hand-authored.
- **Reduced motion respected**: Transitions and animations are wrapped in `@media (prefers-reduced-motion: reduce)` blocks to disable them when requested.