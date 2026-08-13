/**
 * First-run onboarding: 5 steps + success screen, localStorage-backed
 * completion state, fully localized via t(). Full-screen iOS-style setup
 * wizard; on first run the app keeps initializing underneath the opaque
 * cover, so the map/router are ready the moment the flow ends.
 */
import { getLang, LANG_META, setLang, t } from "./lang.js";
import {
  BETA_BANNER_STORAGE_KEY,
  LIVE_BUS_MORE_STORAGE_KEY,
  loadBetaBannerPref,
  loadDataCachePref,
  loadDataSourcePref,
  loadLiveBusMorePref,
  loadLiveBusPref,
  saveBetaBannerPref,
  saveDataCachePref,
  saveDataSourcePref,
  saveLiveBusPref,
} from "./preferences.js";
import {
  FARE_TYPE_HINTS,
  FARE_TYPE_LABELS,
  FARE_TYPES,
  loadFareType,
  saveFareType,
} from "./fares.js";

export const ONBOARDED_STORAGE_KEY = "morgan.onboarded.v1";
const TERMS_AGREED_STORAGE_KEY = "morgan.termsAgreed.v1";

const TERMS_URL = "https://www.morgandev.cc/terms";
const PRIVACY_URL = "https://www.morgandev.cc/privacy-policy";

/** @returns {boolean} true once the user has completed (or skipped) onboarding */
export function isOnboarded() {
  try {
    return localStorage.getItem(ONBOARDED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist completion — the app boot gate reads this key. */
export function markOnboarded() {
  try {
    localStorage.setItem(ONBOARDED_STORAGE_KEY, "1");
  } catch {
    /* private mode */
  }
}

const STEP_COUNT = 5;

const STEP_TITLES = [
  "Welcome!",
  "Terms",
  "Tickets",
  "Offline Data",
  "Beta Features",
  "All done!",
];

/**
 * Beta-feature sections — extend this array to add new options; each renders
 * as an expandable <details> with an Enable toggle plus sub-options, which are
 * either iOS toggles (type: "toggle") or dropdowns (type omitted).
 */
const BETA_SECTIONS = [
  {
    id: "live-pos",
    titleKey: "Live Position Engine (Prediction-based)",
    descKey: "Show live bus markers predicted from nearby ETA countdowns.",
    loadEnabled: loadLiveBusPref,
    saveEnabled: saveLiveBusPref,
    subs: [
      {
        // Same pref as Settings → Live position → “Fetch more live data”:
        // extra ETA fetches for tighter position stitching.
        id: "fetch-more",
        labelKey: "Fetch more live data",
        storageKey: LIVE_BUS_MORE_STORAGE_KEY,
        type: "toggle",
        defaultValue: loadLiveBusMorePref() ? "1" : "0",
      },
      {
        // Same pref as Settings → Live position → “Beta warning banner”.
        id: "beta-banner",
        labelKey: "Beta warning banner",
        storageKey: BETA_BANNER_STORAGE_KEY,
        type: "toggle",
        defaultValue: loadBetaBannerPref() ? "1" : "0",
      },
    ],
  },
];

/** @type {HTMLDivElement | null} */
let overlay = null;
let stepIndex = 0;
let onCompleteCb = () => {};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

/**
 * Launch the onboarding flow. Resolves once the user finishes or skips it.
 * @param {{ firstRun?: boolean, onComplete?: () => void }} [opts]
 * @returns {Promise<void>}
 */
export function startOnboarding(opts = {}) {
  if (overlay) return Promise.resolve();
  overlay = document.createElement("div");
  overlay.className = `onboarding-overlay${opts.firstRun ? " onboarding-overlay--first" : ""}`;
  overlay.innerHTML = `
    <div class="onboarding-scrim"></div>
    <div class="onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onb-title">
      <div class="onboarding-head">
        <h2 id="onb-title" class="onboarding-title"></h2>
      </div>
      <div id="onb-body" class="onboarding-body"></div>
      <div class="onboarding-foot">
        <button type="button" id="onb-back" class="btn btn-ghost"></button>
        <div class="onb-dots" id="onb-dots" role="group"></div>
        <button type="button" id="onb-skip" class="btn btn-ghost"></button>
        <button type="button" id="onb-next" class="btn btn-accent"></button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  overlay.addEventListener("keydown", trapFocus);
  document.getElementById("onb-back")?.addEventListener("click", goBack);
  document.getElementById("onb-skip")?.addEventListener("click", finish);
  document.getElementById("onb-next")?.addEventListener("click", goNext);
  stepIndex = 0;
  onCompleteCb = opts.onComplete || (() => {});
  render();
  return new Promise((resolve) => {
    const prev = onCompleteCb;
    onCompleteCb = () => {
      prev();
      resolve();
    };
  });
}

/** Wrap Tab navigation inside the dialog. */
function trapFocus(e) {
  if (e.key !== "Tab" || !overlay) return;
  const dialog = overlay.querySelector(".onboarding-dialog");
  const els = [...dialog.querySelectorAll("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), summary")].filter(
    (el) => el.offsetParent !== null,
  );
  if (!els.length) return;
  const first = els[0];
  const last = els[els.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function render() {
  if (!overlay) return;
  const isSuccess = stepIndex >= STEP_COUNT;
  const titleEl = document.getElementById("onb-title");
  const bodyEl = document.getElementById("onb-body");
  const backBtn = document.getElementById("onb-back");
  const skipBtn = document.getElementById("onb-skip");
  const nextBtn = document.getElementById("onb-next");
  const foot = overlay.querySelector(".onboarding-foot");
  if (titleEl) titleEl.textContent = t(STEP_TITLES[Math.min(stepIndex, STEP_TITLES.length - 1)]);
  renderDots(isSuccess);
  if (bodyEl) bodyEl.innerHTML = stepBodyHtml(stepIndex);
  if (backBtn) {
    backBtn.textContent = t("Back");
    backBtn.hidden = isSuccess || stepIndex === 0;
  }
  // Steps 1–4 are mandatory (no Skip); only Beta Features is skippable.
  if (skipBtn) {
    skipBtn.textContent = t("Skip");
    skipBtn.hidden = isSuccess || stepIndex !== STEP_COUNT - 1;
  }
  if (nextBtn) {
    nextBtn.textContent = t("Next");
    nextBtn.hidden = isSuccess;
    nextBtn.disabled = false;
  }
  if (foot) foot.hidden = isSuccess;
  wireStep(stepIndex);
  const first = bodyEl?.querySelector("input, select, button, a[href], summary");
  first?.focus();
}

/** Bottom-of-screen progress: 5 dots, active pill highlighted. */
function renderDots(isSuccess) {
  const dotsEl = document.getElementById("onb-dots");
  if (!dotsEl) return;
  dotsEl.innerHTML = "";
  if (isSuccess) return;
  for (let i = 0; i < STEP_COUNT; i++) {
    const dot = document.createElement("span");
    dot.className =
      "onb-dot" +
      (i < stepIndex ? " onb-dot--done" : i === stepIndex ? " onb-dot--active" : "");
    dot.setAttribute("aria-hidden", "true");
    dotsEl.appendChild(dot);
  }
  dotsEl.setAttribute(
    "aria-label",
    t("Step {n} of {m}", { n: stepIndex + 1, m: STEP_COUNT }),
  );
}

/**
 * Step 3 options: the full fare-type taxonomy with localized labels/tooltips
 * (FARE_TYPE_LABELS / FARE_TYPE_HINTS) — the same set as Settings.
 */
function fareTypeOptionsHtml(current) {
  return FARE_TYPES.map((id) => {
    const hintKey = FARE_TYPE_HINTS[id];
    return `<option value="${id}"${String(id) === current ? " selected" : ""}${hintKey ? ` title="${esc(t(hintKey))}"` : ""}>${esc(t(FARE_TYPE_LABELS[id] || FARE_TYPE_LABELS.octopus_adult))}</option>`;
  }).join("");
}

function stepBodyHtml(idx) {
  if (idx >= STEP_COUNT) {
    return `
      <div class="onb-step onb-success">
        <span class="material-symbols-outlined onb-success-icon" aria-hidden="true">check_circle</span>
        <p class="onb-desc">${esc(t("All done! Let's start enjoying your trip with Travelers!"))}</p>
        <button type="button" id="onb-start" class="btn btn-accent onb-start-btn">${esc(t("Start Using App"))}</button>
      </div>`;
  }
  if (idx === 0) {
    return `
      <div class="onb-step onb-welcome">
        <p class="onb-desc">${esc(t("Choose your preferred language"))}</p>
        <div class="onb-field">
          <label class="onb-field-label" for="onb-lang-select">${esc(t("Language"))}</label>
          <select id="onb-lang-select" class="onb-select" aria-label="${esc(t("Language"))}">
            ${Object.entries(LANG_META)
              .map(
                ([code, meta]) =>
                  `<option value="${code}" ${code === getLang() ? "selected" : ""}>${esc(meta.label)}</option>`,
              )
              .join("")}
          </select>
        </div>
      </div>`;
  }
  if (idx === 1) {
    return `
      <div class="onb-step onb-terms">
        <p class="onb-desc">${esc(t("Please review and accept all terms and policies to continue."))}</p>
        <div class="onb-terms-list">
          <a class="onb-term-row onb-term-row--primary" href="${TERMS_URL}" target="_blank" rel="noopener noreferrer">
            <span class="material-symbols-outlined onb-term-icon" aria-hidden="true">verified</span>
            <span class="onb-term-title">${esc(t("UNLOOP MORGAN Universal Terms of Use for Open-Source Software"))}</span>
            <span class="material-symbols-outlined onb-term-open" aria-hidden="true">open_in_new</span>
          </a>
          <a class="onb-term-row" href="${TERMS_URL}" target="_blank" rel="noopener noreferrer">
            <span class="material-symbols-outlined onb-term-icon" aria-hidden="true">description</span>
            <span class="onb-term-title">${esc(t("Terms of Service"))}</span>
            <span class="material-symbols-outlined onb-term-open" aria-hidden="true">open_in_new</span>
          </a>
          <a class="onb-term-row" href="${PRIVACY_URL}" target="_blank" rel="noopener noreferrer">
            <span class="material-symbols-outlined onb-term-icon" aria-hidden="true">privacy_tip</span>
            <span class="onb-term-title">${esc(t("Privacy Policy"))}</span>
            <span class="material-symbols-outlined onb-term-open" aria-hidden="true">open_in_new</span>
          </a>
        </div>
        <div class="onb-toggle-row onb-consent-row">
          <span class="onb-toggle-label">${esc(t("I agree to all terms and policies"))}</span>
          <label class="onb-toggle">
            <input type="checkbox" id="onb-terms-agree" />
            <span class="onb-toggle-track"></span>
          </label>
        </div>
      </div>`;
  }
  if (idx === 2) {
    const current = loadFareType();
    return `
      <div class="onb-step onb-ticket">
        <p class="onb-desc">${esc(t("Choose your default fare ticket type for trip plans."))}</p>
        <div class="onb-field">
          <label class="onb-field-label" for="onb-ticket-select">${esc(t("Ticket type"))}</label>
          <select id="onb-ticket-select" class="onb-select" aria-label="${esc(t("Ticket type"))}">
            ${fareTypeOptionsHtml(current)}
          </select>
        </div>
      </div>`;
  }
  if (idx === 3) {
    const cacheOn = loadDataCachePref();
    const source = loadDataSourcePref();
    return `
      <div class="onb-step onb-cache">
        <p class="onb-desc">${esc(t("Cache transit data on this device for offline use and mobile data savings."))}</p>
        <div class="onb-toggle-row">
          <span class="onb-toggle-label">${esc(t("Cache all data"))}</span>
          <label class="onb-toggle">
            <input type="checkbox" id="onb-cache-toggle" ${cacheOn ? "checked" : ""} />
            <span class="onb-toggle-track"></span>
          </label>
        </div>
        <div class="onb-sub-options" id="onb-cache-subs" ${cacheOn ? "" : "hidden"}>
          <div class="onb-sub-row">
            <span class="onb-sub-label">${esc(t("Prefer data source"))}</span>
            <select class="onb-sub-select" id="onb-data-source-select" aria-label="${esc(t("Prefer data source"))}">
              <option value="cloud" ${source === "cloud" ? "selected" : ""}>${esc(t("Cloud"))}</option>
              <option value="local" ${source === "local" ? "selected" : ""}>${esc(t("Local"))}</option>
            </select>
          </div>
          <p class="onb-sub-note">${esc(t("Cloud: live data first, downloaded copy as the offline fallback. Local: serve the downloaded copy directly to save mobile data."))}</p>
        </div>
      </div>`;
  }
  // idx === 4 — beta features
  return `
    <div class="onb-step onb-beta">
      <p class="onb-desc">${esc(t("Optional experimental features. You can change these anytime in Settings."))}</p>
      ${BETA_SECTIONS.map(betaSectionHtml).join("")}
    </div>`;
}

function betaSectionHtml(section) {
  const enabled = section.loadEnabled();
  const subs = section.subs
    .map((sub) => {
      let current = sub.defaultValue;
      try {
        current = localStorage.getItem(sub.storageKey) ?? sub.defaultValue;
      } catch {
        /* ignore */
      }
      if (sub.type === "toggle") {
        return `
        <div class="onb-toggle-row">
          <span class="onb-toggle-label">${esc(t(sub.labelKey))}</span>
          <label class="onb-toggle">
            <input
              type="checkbox"
              class="onb-sub-toggle"
              data-sub="${sub.id}"
              ${current === "1" ? "checked" : ""}
            />
            <span class="onb-toggle-track"></span>
          </label>
        </div>`;
      }
      return `
        <div class="onb-sub-row">
          <span class="onb-sub-label">${esc(t(sub.labelKey))}</span>
          <select class="onb-sub-select" data-sub="${sub.id}" aria-label="${esc(t(sub.labelKey))}">
            ${sub.options
              .map(
                ([value, label]) =>
                  `<option value="${value}" ${String(current) === String(value) ? "selected" : ""}>${esc(t(label))}</option>`,
              )
              .join("")}
          </select>
        </div>`;
    })
    .join("");
  return `
    <details class="onb-details" ${section.id === "live-pos" ? "open" : ""}>
      <summary>
        <span class="material-symbols-outlined" aria-hidden="true">experiment</span>
        <span class="onb-details-title">${esc(t(section.titleKey))}</span>
      </summary>
      <div class="onb-details-body">
        <p class="onb-desc">${esc(t(section.descKey))}</p>
        <div class="onb-toggle-row">
          <span class="onb-toggle-label">${esc(t("Enable"))}</span>
          <label class="onb-toggle">
            <input
              type="checkbox"
              class="onb-beta-enable"
              data-section="${section.id}"
              ${enabled ? "checked" : ""}
            />
            <span class="onb-toggle-track"></span>
          </label>
        </div>
        <div class="onb-sub-options" ${enabled ? "" : "hidden"}>
          ${subs}
        </div>
      </div>
    </details>`;
}

/** Wire per-step behaviour (language re-render, consent gating, success). */
function wireStep(idx) {
  const bodyEl = document.getElementById("onb-body");
  const nextBtn = document.getElementById("onb-next");
  if (!bodyEl || !nextBtn) return;
  if (idx === 0) {
    const select = bodyEl.querySelector("#onb-lang-select");
    select?.addEventListener("change", () => {
      setLang(select.value); // persists; t() now resolves in the new language
      render();
    });
  } else if (idx === 1) {
    const agree = bodyEl.querySelector("#onb-terms-agree");
    if (agree) {
      nextBtn.disabled = !agree.checked;
      agree.addEventListener("change", () => {
        nextBtn.disabled = !agree.checked;
      });
    }
  } else if (idx === 3) {
    const tgl = bodyEl.querySelector("#onb-cache-toggle");
    const subs = bodyEl.querySelector("#onb-cache-subs");
    if (tgl && subs) {
      tgl.addEventListener("change", () => {
        subs.hidden = !tgl.checked;
      });
    }
  } else if (idx === 4) {
    // Sub-options are hidden while the section's Enable toggle is off.
    bodyEl.querySelectorAll("input.onb-beta-enable").forEach((el) => {
      const container = el.closest(".onb-details-body")?.querySelector(".onb-sub-options");
      if (container) container.hidden = !el.checked;
      el.addEventListener("change", () => {
        if (container) container.hidden = !el.checked;
      });
    });
  } else if (idx === STEP_COUNT) {
    document.getElementById("onb-start")?.addEventListener("click", finish);
  }
}

function goBack() {
  if (stepIndex <= 0) return;
  stepIndex -= 1;
  render();
}

/** Persist the selections of the current step, then advance. */
function goNext() {
  if (stepIndex === 1) {
    try {
      localStorage.setItem(TERMS_AGREED_STORAGE_KEY, "1");
    } catch {
      /* ignore */
    }
  } else if (stepIndex === 2) {
    const sel = document.querySelector("#onb-ticket-select");
    if (sel) saveFareType(sel.value);
  } else if (stepIndex === 3) {
    const tgl = document.querySelector("#onb-cache-toggle");
    if (tgl) saveDataCachePref(tgl.checked);
    const subs = document.getElementById("onb-cache-subs");
    if (subs && !subs.hidden) {
      const sel = document.querySelector("#onb-data-source-select");
      if (sel) saveDataSourcePref(sel.value);
    }
  } else if (stepIndex === 4) {
    for (const section of BETA_SECTIONS) {
      const on = document.querySelector(`input.onb-beta-enable[data-section="${section.id}"]`);
      if (on) section.saveEnabled(on.checked);
      for (const sub of section.subs) {
        if (sub.type === "toggle") {
          const tgl = document.querySelector(`input.onb-sub-toggle[data-sub="${sub.id}"]`);
          if (tgl) {
            try {
              localStorage.setItem(sub.storageKey, tgl.checked ? "1" : "0");
            } catch {
              /* ignore */
            }
          }
          continue;
        }
        const sel = document.querySelector(`select[data-sub="${sub.id}"]`);
        if (sel) {
          try {
            localStorage.setItem(sub.storageKey, sel.value);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  stepIndex = Math.min(stepIndex + 1, STEP_COUNT);
  render();
}

function finish() {
  markOnboarded();
  const done = onCompleteCb;
  overlay?.remove();
  overlay = null;
  document.body.style.overflow = "";
  done();
}
