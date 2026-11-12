/**
 * ?glass=preview — internal comparison sheet for the 2.0 glass presets.
 *
 * Side-by-side of the controls we ship today (app CSS) and the ported
 * presets, so parity can be judged on a real device (iOS PWA included).
 * Not part of the app UI; removed by closing the sheet or dropping the param.
 */

import "./presets.js";

/** A photo-ish backdrop the engine can actually sample for refraction. */
const BACKDROP =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#2b3f6b"/>
          <stop offset=".45" stop-color="#7b3f8f"/>
          <stop offset=".7" stop-color="#c2603f"/>
          <stop offset="1" stop-color="#e0b45c"/>
        </linearGradient>
      </defs>
      <rect width="800" height="400" fill="url(#g)"/>
      <circle cx="180" cy="110" r="120" fill="#ffffff" opacity=".12"/>
      <circle cx="640" cy="300" r="160" fill="#000000" opacity=".16"/>
      <path d="M0 320 L800 200 L800 400 L0 400 Z" fill="#0b0d12" opacity=".55"/>
    </svg>`,
  );

export function mountGlassPreview() {
  const existing = document.querySelector(".glass-preview");
  if (existing) return existing;

  const sheet = document.createElement("div");
  sheet.className = "glass-preview";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "Glass preset preview");
  sheet.innerHTML = `
    <button class="close" type="button" aria-label="Close preview">✕</button>

    <h2>Today — app CSS</h2>
    <div class="row">
      <span class="label">Onboarding / settings toggle</span>
      <label class="onb-toggle">
        <input type="checkbox" checked>
        <span class="onb-toggle-track"></span>
      </label>
      <button class="btn btn-accent" type="button">
        <span class="btn-label">Continue</span>
      </button>
    </div>

    <h2>2.0 presets — glisse spec · liquidglass engine</h2>
    <div class="row">
      <span class="label">Switch (off / on / disabled)</span>
      <mv-switch></mv-switch>
      <mv-switch checked></mv-switch>
      <mv-switch disabled></mv-switch>
    </div>
    <div class="row">
      <span class="label">Segmented control</span>
      <mv-segmented value="week">
        <button value="day" type="button">Day</button>
        <button value="week" type="button">Week</button>
        <button value="month" type="button">Month</button>
      </mv-segmented>
    </div>
    <div class="row">
      <span class="label">Buttons — filled / tinted / plain</span>
      <mv-button tone="filled">Continue</mv-button>
      <mv-button tone="tinted">Pin stop</mv-button>
      <mv-button tone="plain">Later</mv-button>
    </div>
    <div class="row">
      <span class="label">Glass panel over a backdrop (refraction; frosted blur where the engine can't)</span>
      <div class="hero" data-lg-backdrop="img" style="flex:1 1 100%">
        <img src="${BACKDROP}" alt="">
        <mv-glass radius="18" refraction="24">
          <strong>Glass panel</strong>
          <div style="font-size:.8rem;opacity:.75">Lens bends the backdrop behind this card.</div>
        </mv-glass>
      </div>
    </div>
    <div class="row">
      <span class="label">Flat panel (no refraction) — for comparison</span>
      <div style="flex:1 1 100%;border-radius:18px;padding:12px 14px;background:var(--gls-surface);border:1px solid var(--gls-edge)">
        <strong>Solid panel</strong>
        <div style="font-size:.8rem;opacity:.75">App surface token, no lens.</div>
      </div>
    </div>
  `;

  sheet.querySelector(".close").addEventListener("click", () => {
    sheet.remove();
    const url = new URL(location.href);
    url.searchParams.delete("glass");
    history.replaceState(null, "", url);
  });

  document.body.append(sheet);
  return sheet;
}
