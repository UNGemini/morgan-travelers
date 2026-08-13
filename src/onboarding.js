/**
 * First-run onboarding: 5 steps + success screen, localStorage-backed
 * completion state, fully localized via t(). The app keeps initializing
 * underneath (opaque cover on first run, blurred modal sheet on re-run from
 * Settings), so the map/router are ready the moment the flow ends.
 */
import { getLang, LANG_META, setLang, t } from "./lang.js";
import {
  loadDataCachePref,
  loadLiveBusMorePref,
  loadLiveBusPref,
  saveDataCachePref,
  saveLiveBusMorePref,
  saveLiveBusPref,
} from "./preferences.js";
import { FARE_TYPE_LABELS, loadFareType, saveFareType } from "./fares.js";

export const ONBOARDED_STORAGE_KEY = "morgan.onboarded.v1";
const TERMS_AGREED_STORAGE_KEY = "morgan.termsAgreed.v1";
/** Prediction-accuracy slot for the live-position engine (balanced|high). */
const LIVE_BUS_ACCURACY_STORAGE_KEY = "morgan.liveBusAccuracy";

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
  "Welcome to MORGAN Travelers",
  "Terms & Privacy",
  "Ticket type",
  "Offline data",
  "Beta features",
  "All done!",
];

/** Fare types offered in onboarding (compact subset of FARE_TYPES). */
const TICKET_OPTIONS = [
  { id: "octopus_adult", labelKey: FARE_TYPE_LABELS.octopus_adult },
  { id: "octopus_student", labelKey: FARE_TYPE_LABELS.octopus_student },
  { id: "octopus_joyyou_65", labelKey: FARE_TYPE_LABELS.octopus_joyyou_65 },
  { id: "octopus_child", labelKey: FARE_TYPE_LABELS.octopus_child },
];

/**
 * Beta-feature sections — extend this array to add new options; each renders
 * as an expandable <details> with an Enable toggle plus sub-option selects.
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
        id: "accuracy",
        labelKey: "Prediction accuracy",
        storageKey: LIVE_BUS_ACCURACY_STORAGE_KEY,
        defaultValue: "balanced",
        options: [
          ["balanced", "Balanced"],
          ["high", "High accuracy"],
        ],
      },
      {
        // Maps straight onto the existing "Fetch more live data" pref:
        // High = extra ETA fetches for tighter position stitching.
        id: "frequency",
        labelKey: "Update frequency",
        storageKey: "morgan.liveBusPositionsMore",
        defaultValue: loadLiveBusMorePref() ? "1" : "0",
        options: [
          ["0", "Standard"],
          ["1", "High (more data)"],
        ],
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
        <span id="onb-progress" class="onboarding-progress"></span>
      </div>
      <div id="onb-body" class="onboarding-body"></div>
      <div class="onboarding-foot">
        <button type="button" id="onb-back" class="btn btn-ghost"></button>
        <span class="onboarding-foot-spacer"></span>
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
  const progressEl = document.getElementById("onb-progress");
  const bodyEl = document.getElementById("onb-body");
  const backBtn = document.getElementById("onb-back");
  const skipBtn = document.getElementById("onb-skip");
  const nextBtn = document.getElementById("onb-next");
  const foot = overlay.querySelector(".onboarding-foot");
  if (titleEl) titleEl.textContent = t(STEP_TITLES[Math.min(stepIndex, STEP_TITLES.length - 1)]);
  if (progressEl) {
    progressEl.textContent = isSuccess
      ? ""
      : t("Step {n} of {m}", { n: stepIndex + 1, m: STEP_COUNT });
    progressEl.hidden = isSuccess;
  }
  if (bodyEl) bodyEl.innerHTML = stepBodyHtml(stepIndex);
  if (backBtn) {
    backBtn.textContent = t("Back");
    backBtn.hidden = isSuccess || stepIndex === 0;
  }
  if (skipBtn) {
    skipBtn.textContent = t("Skip");
    skipBtn.hidden = isSuccess;
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
        <div class="onb-lang-grid" role="radiogroup" aria-label="${esc(t("Language"))}">
          ${Object.entries(LANG_META)
            .map(
              ([code, meta]) => `
            <label class="onb-opt">
              <input type="radio" name="onb-lang" value="${code}" ${code === getLang() ? "checked" : ""} />
              <span class="onb-opt-card">${esc(meta.label)}</span>
            </label>`,
            )
            .join("")}
        </div>
      </div>`;
  }
  if (idx === 1) {
    return `
      <div class="onb-step onb-terms">
        <p class="onb-desc">${esc(t("Please review and accept our Terms of Service and Privacy Policy to continue."))}</p>
        <div class="onb-terms-links">
          <a class="btn btn-ghost" href="${TERMS_URL}" target="_blank" rel="noopener noreferrer">
            <span class="btn-row">
              <span class="material-symbols-outlined" aria-hidden="true">description</span>
              ${esc(t("Terms of Service"))}
            </span>
          </a>
          <a class="btn btn-ghost" href="${PRIVACY_URL}" target="_blank" rel="noopener noreferrer">
            <span class="btn-row">
              <span class="material-symbols-outlined" aria-hidden="true">privacy_tip</span>
              ${esc(t("Privacy Policy"))}
            </span>
          </a>
        </div>
        <label class="onb-consent">
          <input type="checkbox" id="onb-terms-agree" />
          <span>${esc(t("I agree to the Terms of Service and Privacy Policy"))}</span>
        </label>
      </div>`;
  }
  if (idx === 2) {
    const current = loadFareType();
    return `
      <div class="onb-step onb-ticket">
        <p class="onb-desc">${esc(t("Choose your default fare ticket type for trip plans."))}</p>
        <div class="onb-ticket-grid">
          ${TICKET_OPTIONS.map(
            (o) => `
            <label class="onb-opt">
              <input type="radio" name="onb-ticket" value="${o.id}" ${o.id === current ? "checked" : ""} />
              <span class="onb-opt-card">${esc(t(o.labelKey))}</span>
            </label>`,
          ).join("")}
        </div>
      </div>`;
  }
  if (idx === 3) {
    const cacheOn = loadDataCachePref();
    return `
      <div class="onb-step onb-cache">
        <p class="onb-desc">${esc(t("Cache transit data on this device for offline use and mobile data savings."))}</p>
        <div class="onb-opt-list">
          <label class="onb-opt">
            <input type="radio" name="onb-cache" value="yes" ${cacheOn ? "checked" : ""} />
            <span class="onb-opt-card">${esc(t("Yes, cache all data"))}</span>
          </label>
          <label class="onb-opt">
            <input type="radio" name="onb-cache" value="no" ${!cacheOn ? "checked" : ""} />
            <span class="onb-opt-card">${esc(t("No, use cloud only"))}</span>
          </label>
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
        <div class="onb-sub-row">
          <span class="onb-sub-label">${esc(t("Enable"))}</span>
          <div class="pref-segment pref-segment-2" role="group" aria-label="${esc(t("Enable"))}">
            <label class="pref-opt">
              <input type="radio" name="onb-${section.id}-enable" value="on" ${enabled ? "checked" : ""} />
              <span>${esc(t("On"))}</span>
            </label>
            <label class="pref-opt">
              <input type="radio" name="onb-${section.id}-enable" value="off" ${!enabled ? "checked" : ""} />
              <span>${esc(t("Off"))}</span>
            </label>
          </div>
        </div>
        ${subs}
      </div>
    </details>`;
}

/** Wire per-step behaviour (language re-render, consent gating, success). */
function wireStep(idx) {
  const bodyEl = document.getElementById("onb-body");
  const nextBtn = document.getElementById("onb-next");
  if (!bodyEl || !nextBtn) return;
  if (idx === 0) {
    bodyEl.querySelectorAll('input[name="onb-lang"]').forEach((el) => {
      el.addEventListener("change", () => {
        if (!el.checked) return;
        setLang(el.value); // persists; t() now resolves in the new language
        render();
      });
    });
  } else if (idx === 1) {
    const agree = bodyEl.querySelector("#onb-terms-agree");
    if (agree) {
      nextBtn.disabled = !agree.checked;
      agree.addEventListener("change", () => {
        nextBtn.disabled = !agree.checked;
      });
    }
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
    const sel = document.querySelector('input[name="onb-ticket"]:checked');
    if (sel) saveFareType(sel.value);
  } else if (stepIndex === 3) {
    const sel = document.querySelector('input[name="onb-cache"]:checked');
    if (sel) saveDataCachePref(sel.value === "yes");
  } else if (stepIndex === 4) {
    for (const section of BETA_SECTIONS) {
      const on = document.querySelector(`input[name="onb-${section.id}-enable"]:checked`);
      if (on) section.saveEnabled(on.value === "on");
      for (const sub of section.subs) {
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
