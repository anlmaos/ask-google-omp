/**
 * Content script running on https://www.google.com/search*
 *
 * Receives a { type: "run-search", requestId, query, timeoutMs } message from
 * the background script, waits for AI Mode to complete, runs the SERPO
 * click-based citation extraction in the DOM (must run in-page), and returns
 * the raw { html, citations } to the background script. The client process then
 * converts to markdown using cheerio+turndown.
 *
 * selectors.js is loaded BEFORE this file (see manifest content_scripts.js),
 * exposing constants on globalThis.ANIMA_SELECTORS.
 */

const {
 CITATION_SELECTORS,
 AI_COMPLETION_BUTTON_SVG,
 AI_COMPLETION_BUTTON_ARIA,
 AI_MODE_NOT_AVAILABLE,
 OVERALL_COMPLETION_TIMEOUT,
 AI_COMPLETION_TEXT_INDICATORS,
 SCROLL_STABILITY_MS,
 SCROLL_POLL_MS,
 MAIN_CONTAINER,
 SIDE_CONTAINER,
 SKIP_DOMAINS,
} = globalThis.ANIMA_SELECTORS;

const extensionApi = globalThis.browser || globalThis.chrome;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isVisible(el) {
 if (!el) return false;
 const style = window.getComputedStyle(el);
 const rect = el.getBoundingClientRect();
 return (
  style.display !== "none" &&
  style.visibility !== "hidden" &&
  style.opacity !== "0" &&
  el.offsetParent !== null &&
  rect.width > 0 &&
  rect.height > 0
 );
}

function checkAiModeAvailable() {
 const body = document.body ? document.body.innerText : "";
 for (const indicator of AI_MODE_NOT_AVAILABLE) {
  if (body.includes(indicator)) return false;
 }
 return true;
}

async function waitForAiCompletion(timeoutMs) {
 const start = Date.now();
 const waitTimeoutMs = Math.min(
  timeoutMs || OVERALL_COMPLETION_TIMEOUT,
  OVERALL_COMPLETION_TIMEOUT
 );
 const deadline = start + waitTimeoutMs;
 const stabilityMs = (typeof SCROLL_STABILITY_MS === "number")
  ? SCROLL_STABILITY_MS
  : 800;
 const pollMs = (typeof SCROLL_POLL_MS === "number") ? SCROLL_POLL_MS : 200;

 let lastY = window.scrollY;
 let lastHeight = document.documentElement.scrollHeight;
 let stableSince = Date.now();
 let mutationOccurred = false;
 let scrollEndAt = 0;
 const mo = new MutationObserver(() => {
  mutationOccurred = true;
  scrollEndAt = 0;
 });
 if (document.body) {
  mo.observe(document.body, { childList: true, subtree: true, attributes: true });
 }
 const onScroll = () => {
  stableSince = Date.now();
  scrollEndAt = 0;
 };
 window.addEventListener("scroll", onScroll, { passive: true });
 const onScrollEnd = () => { scrollEndAt = Date.now(); };
 if ("onscrollend" in window) window.addEventListener("scrollend", onScrollEnd, { passive: true });

 try {
  for (; ;) {
   // Fast path: existing button/text detection.
   const svgEl = document.querySelector(AI_COMPLETION_BUTTON_SVG);
   if (svgEl && isVisible(svgEl.closest("button") || svgEl))
    return { method: "svg", elapsed: Date.now() - start };
   const ariaEl = document.querySelector(AI_COMPLETION_BUTTON_ARIA);
   if (ariaEl && isVisible(ariaEl))
    return { method: "aria-label", elapsed: Date.now() - start };
   const body = document.body ? document.body.innerText : "";
   for (const indicator of AI_COMPLETION_TEXT_INDICATORS) {
    if (body.includes(indicator))
     return { method: "text", elapsed: Date.now() - start };
   }

   // Scroll-stop detection.
   if (mutationOccurred) {
    mutationOccurred = false;
    stableSince = Date.now();
    lastY = window.scrollY;
    lastHeight = document.documentElement.scrollHeight;
   } else {
    const y = window.scrollY;
    const h = document.documentElement.scrollHeight;
    if (y === lastY && h === lastHeight) {
     if (Date.now() - stableSince >= stabilityMs) {
      return { method: "scroll-stable", elapsed: Date.now() - start };
     }
    } else {
     lastY = y;
     lastHeight = h;
     stableSince = Date.now();
    }
   }

   // Native scrollend fast path.
   if (scrollEndAt && Date.now() - scrollEndAt >= 50 && !mutationOccurred) {
    return { method: "scroll-end", elapsed: Date.now() - start };
   }

   if (Date.now() >= deadline)
    return { method: "timeout", elapsed: Date.now() - start };
   await sleep(pollMs);
  }
 } finally {
  if ("onscrollend" in window) window.removeEventListener("scrollend", onScrollEnd);
  window.removeEventListener("scroll", onScroll);
  mo.disconnect();
 }
}

 function extractCitationsAndHtml() {
  const mainCol = document.querySelector(MAIN_CONTAINER);
  if (!mainCol)
   return { error: "AI Overview container (main-col) not found on page" };

  // Expand "Show more" first.
  const showMoreBtns = Array.from(
   mainCol.querySelectorAll('[aria-expanded="false"]')
  );
  for (const btn of showMoreBtns) {
   if (
    isVisible(btn) &&
    /Show more|Mehr anzeigen|Meer weergeven/.test(btn.innerText)
   ) {
    try {
     btn.click();
    } catch { /* ignore */ }
   }
  }

  let buttons = [];
  for (const sel of CITATION_SELECTORS) {
   buttons = Array.from(mainCol.querySelectorAll(sel));
   if (buttons.filter((b) => isVisible(b)).length > 0) break;
  }

  const allCitations = [];
  let markerIndex = 0;

  for (const btn of buttons) {
   if (!isVisible(btn)) continue;

   const markerId = markerIndex++;
   const marker = document.createElement("span");
   marker.className = "citation-marker";
   const codeEl = document.createElement("code");
   codeEl.textContent = `[CITE-${markerId}]`;
   marker.appendChild(codeEl);

   if (btn.nextSibling) btn.parentNode.insertBefore(marker, btn.nextSibling);
   else btn.parentNode.appendChild(marker);

   try {
    btn.scrollIntoView({ behavior: "instant", block: "center" });
    const rhsCol = document.querySelector(SIDE_CONTAINER);
    const countLinks = () =>
     rhsCol
      ? Array.from(rhsCol.querySelectorAll("a[href]")).filter((l) => isVisible(l)).length
      : 0;
    const before = countLinks();
    btn.click();
    for (let i = 0; i < 30; i++) {
     if (countLinks() !== before) break;
     const t = Date.now();
     while (Date.now() - t < 10) { /* wait */ }
    }
   } catch { /* click failure */ }

   const sources = [];
   const seen = new Set();
   const rhsCol = document.querySelector(SIDE_CONTAINER);
   if (rhsCol) {
    for (const link of Array.from(rhsCol.querySelectorAll("a[href]"))) {
     if (!isVisible(link)) continue;
     const url = link.href;
     const title = (link.innerText.trim() || link.getAttribute("aria-label") || "").toString();
     const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
     if (
      url && url.startsWith("http") &&
      !SKIP_DOMAINS.some((d) => url.includes(d)) &&
      !seen.has(url)
     ) {
      seen.add(url);
      sources.push({ title, url, domain: host });
     }
    }
   }
   allCitations.push({ marker_id: markerId, sources });
  }

  return { html: mainCol.innerHTML, citations: allCitations };
 }

 function respond(requestId, ok, error, html, citations) {
  const message = {
   type: "search-result",
   requestId,
   ok,
   error: error || null,
   html: html || null,
   citations: citations || null,
  };
  try {
   const sent = extensionApi.runtime.sendMessage(message);
   if (sent && typeof sent.catch === "function") sent.catch(() => { });
  } catch { /* cannot report without runtime messaging */ }
 }

 async function runSearch(requestId, query, timeoutMs) {
  if (!checkAiModeAvailable()) {
   respond(requestId, false,
    "Google AI Mode is not available in your country or language. Use a proxy/VPN to access from a supported region (e.g. US, UK, Germany).",
    null, null);
   return;
  }

  const completionDeadline = Date.now() + (timeoutMs || 60000);
  let completion;
  try {
   completion = await waitForAiCompletion(timeoutMs || 60000);
  } catch (err) {
   respond(requestId, false, `Completion wait failed: ${err.message}`, null, null);
   return;
  }
  if (Date.now() >= completionDeadline) {
   respond(requestId, false, "Timed out waiting for AI Mode to generate a response", null, null);
   return;
  }

  const extracted = extractCitationsAndHtml();
  if (extracted.error) {
   respond(requestId, false, extracted.error, null, null);
   return;
  }
  respond(requestId, true, null, extracted.html, extracted.citations);
 }

 extensionApi.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "run-search") return;
  sendResponse({ ok: true });
  runSearch(msg.requestId, msg.query, msg.timeoutMs).catch((err) => {
   respond(
    msg.requestId,
    false,
    `Content script failed: ${err && err.message ? err.message : String(err)}`,
    null,
    null
   );
  });
  return true;
 });
