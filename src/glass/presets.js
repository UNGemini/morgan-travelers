/**
 * 2.0 glass presets — vanilla custom elements.
 *
 * Presets (switch / segmented control / button / glass panel) follow the
 * visual spec of 0kzh/glisse (MIT); the refraction engine is vendored from
 * gentpan/liquidglass (MIT, see ./engine.js). No React: glisse's wrappers are
 * .tsx, but its engine internals are plain DOM, and so is this port.
 *
 * Usage:  import "./glass/presets.js";
 *         <mv-switch checked></mv-switch>
 *         <mv-segmented value="week"><button value="day">Day</button>…</mv-segmented>
 *         <mv-button tone="tinted">Continue</mv-button>
 *         <mv-glass radius="20">…</mv-glass>
 */

import { createGlass, createSpring } from "./engine.js";
import "./presets.css";

/** Shadow root + inline styles (few instances, so duplication is cheaper than plumbing). */
function mount(host, html, css) {
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${css}</style>${html}`;
  return root;
}

/* ── Switch ─────────────────────────────────────────────────────────── */

const SWITCH_CSS = `
  :host { display: inline-flex; }
  * { box-sizing: border-box; }
  button {
    position: relative;
    width: 51px;
    height: 31px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: var(--gls-track);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    transition: background 0.25s var(--gls-ease);
  }
  button[aria-checked="true"] { background: var(--gls-on); }
  button:disabled { opacity: 0.45; cursor: default; }
  button:focus-visible { outline: 2px solid var(--gls-ring); outline-offset: 2px; }
  span {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 27px;
    height: 27px;
    border-radius: 999px;
    background: #fff;
    box-shadow: 0 3px 8px rgb(0 0 0 / 0.25), 0 0 0 0.5px rgb(0 0 0 / 0.06);
    transition: transform 0.28s var(--gls-ease), width 0.2s var(--gls-ease);
    will-change: transform;
  }
  button[aria-checked="true"] span { transform: translateX(20px); }
  button:active span { width: 33px; }
  button[aria-checked="true"]:active span { width: 33px; transform: translateX(14px); }
  @media (prefers-reduced-motion: reduce) {
    button, span { transition-duration: 0.01ms; }
  }
`;

class MvSwitch extends HTMLElement {
  static observedAttributes = ["checked", "disabled"];
  #btn;

  constructor() {
    super();
    const root = mount(
      this,
      `<button part="track" role="switch" aria-checked="false"><span part="thumb"></span></button>`,
      SWITCH_CSS,
    );
    this.#btn = root.querySelector("button");
    this.#btn.addEventListener("click", () => {
      if (this.hasAttribute("disabled")) return;
      this.checked = !this.checked;
      this.dispatchEvent(
        new CustomEvent("change", {
          detail: { checked: this.checked },
          bubbles: true,
          composed: true,
        }),
      );
    });
  }

  connectedCallback() {
    this.#sync();
  }

  attributeChangedCallback() {
    if (this.#btn) this.#sync();
  }

  get checked() {
    return this.hasAttribute("checked");
  }

  set checked(v) {
    this.toggleAttribute("checked", !!v);
  }

  #sync() {
    this.#btn.setAttribute("aria-checked", this.checked ? "true" : "false");
    this.#btn.disabled = this.hasAttribute("disabled");
  }
}

/* ── Segmented control ──────────────────────────────────────────────── */

const SEGMENTED_CSS = `
  :host { display: inline-block; max-width: 100%; }
  * { box-sizing: border-box; }
  .track {
    position: relative;
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: 10px;
    background: var(--gls-segment-track);
  }
  .thumb {
    position: absolute;
    top: 2px;
    bottom: 2px;
    left: 0;
    border-radius: 8px;
    background: var(--gls-segment-thumb);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.2), 0 0 0 0.5px rgb(255 255 255 / 0.06);
    pointer-events: none;
    will-change: transform, width;
  }
  ::slotted(button) {
    position: relative;
    z-index: 1;
    flex: 1 1 auto;
    min-width: 56px;
    padding: 6px 14px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--gls-fg);
    font: inherit;
    font-size: 0.82rem;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  ::slotted(button:focus-visible) {
    outline: 2px solid var(--gls-ring);
    outline-offset: 1px;
  }
`;

class MvSegmented extends HTMLElement {
  static observedAttributes = ["value"];
  #track;
  #thumb;
  #spring = null;
  #busy = false;

  constructor() {
    super();
    const root = mount(
      this,
      `<div class="track" part="track" role="tablist"><span class="thumb" aria-hidden="true"></span><slot></slot></div>`,
      SEGMENTED_CSS,
    );
    this.#track = root.querySelector(".track");
    this.#thumb = root.querySelector(".thumb");

    this.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("button[value]");
      if (!btn || !this.contains(btn)) return;
      this.value = btn.getAttribute("value") || "";
    });
    root.querySelector("slot").addEventListener("slotchange", () => {
      this.#markSelected();
      this.#move({ immediate: true });
    });
  }

  connectedCallback() {
    this.#markSelected();
    requestAnimationFrame(() => this.#move({ immediate: true }));
  }

  attributeChangedCallback() {
    this.#markSelected();
    this.#move();
  }

  get value() {
    return this.getAttribute("value") || "";
  }

  set value(v) {
    if (!v || v === this.value) return;
    this.setAttribute("value", v);
  }

  get #buttons() {
    return [...this.querySelectorAll("button[value]")];
  }

  #markSelected() {
    const current = this.value;
    for (const b of this.#buttons) {
      const on = b.getAttribute("value") === current;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.setAttribute("role", "tab");
    }
  }

  /** Animate the thumb to the selected segment (spring in index space). */
  #move({ immediate = false } = {}) {
    const buttons = this.#buttons;
    if (!buttons.length || !this.#track.offsetWidth) return;
    const rects = buttons.map((b) => ({ x: b.offsetLeft, w: b.offsetWidth }));
    const index = Math.max(
      0,
      buttons.findIndex((b) => b.getAttribute("value") === this.value),
    );
    const apply = (pos) => {
      const i = Math.max(0, Math.min(Math.floor(pos), rects.length - 1));
      const j = Math.min(i + 1, rects.length - 1);
      const t = Math.max(0, Math.min(1, pos - i));
      const x = rects[i].x + (rects[j].x - rects[i].x) * t;
      const w = rects[i].w + (rects[j].w - rects[i].w) * t;
      this.#thumb.style.width = `${w}px`;
      this.#thumb.style.transform = `translateX(${x}px)`;
    };
    if (!this.#spring) {
      this.#spring = createSpring(index, apply, { stiffness: 420, damping: 34 });
      apply(index);
      return;
    }
    this.#spring.set(index, { immediate });
  }
}

/* ── Button ─────────────────────────────────────────────────────────── */

const BUTTON_CSS = `
  :host { display: inline-flex; }
  * { box-sizing: border-box; }
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 9px 18px;
    border: 1px solid var(--gls-edge);
    border-radius: 999px;
    background: var(--gls-glass);
    color: var(--gls-fg);
    font: inherit;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.1), 0 6px 18px rgb(0 0 0 / 0.22);
    transition: transform 0.2s var(--gls-ease), background 0.2s var(--gls-ease);
    touch-action: manipulation;
  }
  :host([tone="filled"]) button { background: var(--gls-fill); border-color: transparent; color: #fff; }
  :host([tone="tinted"]) button { background: rgb(0 136 255 / 0.22); border-color: rgb(0 136 255 / 0.4); }
  :host([tone="plain"]) button {
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    color: var(--gls-muted);
  }
  :host([pressed]) button { transform: scale(var(--gls-press-scale)); }
  button:focus-visible { outline: 2px solid var(--gls-ring); outline-offset: 2px; }
  button:disabled { opacity: 0.45; cursor: default; }
  @media (prefers-reduced-motion: reduce) {
    button { transition-duration: 0.01ms; }
  }
`;

class MvButton extends HTMLElement {
  static observedAttributes = ["href", "disabled"];
  #btn;

  constructor() {
    super();
    const root = mount(this, `<button part="button"><slot></slot></button>`, BUTTON_CSS);
    this.#btn = root.querySelector("button");
    const release = () => this.removeAttribute("pressed");
    this.#btn.addEventListener("pointerdown", () => {
      if (!this.hasAttribute("disabled")) this.setAttribute("pressed", "");
    });
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
      this.#btn.addEventListener(ev, release);
    }
    this.#btn.addEventListener("click", () => {
      if (this.hasAttribute("disabled")) return;
      const href = this.getAttribute("href");
      if (href) location.assign(href);
    });
  }

  attributeChangedCallback() {
    if (this.#btn) this.#btn.disabled = this.hasAttribute("disabled");
  }
}

/* ── Glass panel (refraction over a marked backdrop) ────────────────── */

const GLASS_CSS = `
  :host {
    display: block;
    overflow: hidden;
    background: var(--gls-surface);
    border: 1px solid var(--gls-edge);
    box-shadow: 0 18px 48px var(--gls-shadow), inset 0 1px 0 rgb(255 255 255 / 0.08);
    color: var(--gls-fg);
    padding: 12px 14px;
  }
`;

class MvGlass extends HTMLElement {
  #glass = null;

  constructor() {
    super();
    mount(this, `<slot></slot>`, GLASS_CSS);
  }

  connectedCallback() {
    const radius = Number(this.getAttribute("radius")) || 20;
    this.style.borderRadius = `${radius}px`;
    if (this.#glass) return;
    this.#glass = createGlass(this, {
      fit: true,
      radius,
      refraction: Number(this.getAttribute("refraction")) || 20,
      bezel: 0.55,
    });
  }

  disconnectedCallback() {
    this.#glass?.destroy?.();
    this.#glass = null;
  }
}

/* ── Registration ───────────────────────────────────────────────────── */

for (const [name, ctor] of [
  ["mv-switch", MvSwitch],
  ["mv-segmented", MvSegmented],
  ["mv-button", MvButton],
  ["mv-glass", MvGlass],
]) {
  if (!customElements.get(name)) customElements.define(name, ctor);
}

export { MvButton, MvGlass, MvSegmented, MvSwitch };
