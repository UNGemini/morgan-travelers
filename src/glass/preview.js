/**
 * ?glass=preview — internal comparison sheet for the 2.0 glass components.
 *
 * Side-by-side of the controls we ship today (app CSS) and the vendored
 * liquidglass components themed to Glisse's spec, so parity and the lens
 * effect can be judged on a real device (iOS PWA included).
 */

import "./presets.js";

/** A photo-ish backdrop the lens can actually bend. */
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
      <g stroke="#ffffff" stroke-width="2" opacity=".25">
        <path d="M0 90 L800 90"/><path d="M0 180 L800 180"/><path d="M0 270 L800 270"/>
        <path d="M120 0 L120 400"/><path d="M300 0 L300 400"/><path d="M520 0 L520 400"/>
      </g>
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

    <h2>2.0 — liquidglass components · glisse theme</h2>
    <div class="row">
      <span class="label">Switch (off / on / disabled)</span>
      <lg-switch></lg-switch>
      <lg-switch checked></lg-switch>
      <lg-switch disabled></lg-switch>
    </div>
    <div class="row">
      <span class="label">Segmented control (lens indicator)</span>
      <lg-segmented value="week">
        <button value="day">Day</button>
        <button value="week">Week</button>
        <button value="month">Month</button>
      </lg-segmented>
    </div>
    <div class="row">
      <span class="label">Buttons (glass / tinted / light)</span>
      <lg-button>Continue</lg-button>
      <lg-button tone="tinted">Pin stop</lg-button>
      <lg-button tone="light">Later</lg-button>
    </div>
    <div class="row">
      <span class="label">Glass panel over a backdrop — should refract the image</span>
      <div class="hero" data-lg-backdrop="img">
        <img src="${BACKDROP}" alt="">
        <lg-panel>
          <strong>Glass panel</strong>
          <div style="font-size:.8rem;opacity:.75">The lens bends the photo behind this card.</div>
        </lg-panel>
      </div>
    </div>
    <div class="row">
      <span class="label">Flat panel (no glass) — for comparison</span>
      <div class="flat">
        <strong>Solid panel</strong>
        <div style="font-size:.8rem;opacity:.75">App surface colour, no lens.</div>
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
