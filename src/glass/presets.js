/**
 * 2.0 glass presets — entry point.
 *
 * The components are vendored **verbatim** from gentpan/liquidglass
 * (`components.js` + `liquid-glass.js`, MIT, © 2026 gentpan) so upstream
 * snapshots drop straight in. The look is Glisse's spec expressed as
 * `--lg-*` tokens in ./presets.css.
 *
 * Why not shadow DOM (the first attempt): these components render into the
 * LIGHT DOM on purpose. The `.lg-refract` lens is positioned *outside* the
 * control's border box, and every glass surface clones its backdrop node into
 * itself so the SVG filter bends real pixels. A shadow root — and `overflow:
 * hidden` — destroys both, which is why that port read as flat CSS pills
 * instead of glass.
 *
 * One unrelated name to keep in mind: the app already owns `--lg-blur`
 * (toolbar backdrop blur). The vendored tokens are `--lg-accent`, `--lg-on`,
 * `--lg-surface`, `--lg-track*`, `--lg-text*`, `--lg-radius*`, `--lg-shadow-*`,
 * `--lg-tint*`, `--lg-indicator`, `--lg-focus`, `--lg-fallback` — no overlap.
 */
import "./components.js";
import "./presets.css";

export * from "./components.js";
