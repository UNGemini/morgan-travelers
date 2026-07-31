/**
 * Morgan — Acrylic Sayram lighting (slim port from morgandev.cc acrylic.js)
 * Tracks cursor against [data-acrylic] elements and sets --mouse-x / --mouse-y.
 */

export function initAcrylic() {
  let acrylicEls = document.querySelectorAll("[data-acrylic]");

  function refreshAcrylic() {
    acrylicEls = document.querySelectorAll("[data-acrylic]");
  }

  let pendingEvent = null;
  let rafScheduled = false;
  let lastPointerX = null;
  let lastPointerY = null;
  let hasPointer = false;

  function recomputeLighting() {
    rafScheduled = false;
    const e = pendingEvent;
    pendingEvent = null;
    if (!acrylicEls?.length) return;

    let px;
    let py;
    if (e && typeof e.clientX === "number") {
      px = e.clientX;
      py = e.clientY;
      lastPointerX = px;
      lastPointerY = py;
      hasPointer = true;
    } else if (hasPointer) {
      px = lastPointerX;
      py = lastPointerY;
    } else {
      return;
    }

    for (const el of acrylicEls) {
      if (!el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      el.style.setProperty("--mouse-x", `${px - rect.left}px`);
      el.style.setProperty("--mouse-y", `${py - rect.top}px`);
    }
  }

  function scheduleLighting(e) {
    if (e) pendingEvent = e;
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(recomputeLighting);
  }

  document.addEventListener("mousemove", scheduleLighting, { passive: true });

  function onScrollOrResize() {
    if (!hasPointer) return;
    scheduleLighting(null);
  }

  window.addEventListener("scroll", onScrollOrResize, {
    passive: true,
    capture: true,
  });
  window.addEventListener("resize", onScrollOrResize, { passive: true });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refreshAcrylic, 150);
  });
  window.addEventListener("load", refreshAcrylic);

  // Mobile: skip Sayram rings (matches Morgandev mobile-ui behaviour)
  if (!document.body.classList.contains("mobile-ui")) {
    const mobileMQ = window.matchMedia("(max-width: 768px)");
    const applyMobile = (v) => {
      document.body.classList.toggle("mobile-ui", v.matches);
    };
    mobileMQ.addEventListener("change", applyMobile);
    applyMobile(mobileMQ);
  }

  return { refreshAcrylic };
}
