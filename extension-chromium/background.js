/**
 * Chromium MV3 background service worker.
 *
 * Mirrors the Firefox background flow using `chrome.*` APIs. It keeps the same
 * native-host protocol so any local client and the native-host bridge can
 * serve either browser family.
 */

const NATIVE_HOST = "com.ask.google";
const CONTENT_SCRIPT_READY_TIMEOUT_MS = 15000;
const CONTENT_SCRIPT_RETRY_INTERVAL_MS = 250;

let port = null;
let pendingByRequest = new Map(); // requestId -> { tabId, timeoutMs, watchdog }

function chromeCall(fn, ...args) {
 return new Promise((resolve, reject) => {
  fn(...args, (result) => {
   const err = chrome.runtime.lastError;
   if (err) reject(new Error(err.message));
   else resolve(result);
  });
 });
}

function ensurePort() {
 if (port) return port;
 try {
  port = chrome.runtime.connectNative(NATIVE_HOST);
 } catch (err) {
  console.error(`[ask-google] connectNative failed: ${err.message}`);
  port = null;
  return null;
 }

 port.onMessage.addListener((msg) => {
  if (!msg || typeof msg.requestId !== "number") return;
  startSearch(msg.requestId, msg.query, msg.timeoutMs);
 });

 port.onDisconnect.addListener(() => {
  console.warn("[ask-google] native port disconnected");
  port = null;
  for (const [reqId, entry] of pendingByRequest) {
   clearTimeout(entry.watchdog);
   pendingByRequest.delete(reqId);
   closeTab(entry.tabId);
  }
 });

 return port;
}

function buildSearchUrl(query) {
 return `https://www.google.com/search?udm=50&q=${encodeURIComponent(query)}`;
}

async function startSearch(requestId, query, timeoutMs) {
 const searchUrl = buildSearchUrl(query);
 const effectiveTimeoutMs = timeoutMs || 60000;
 let tab;
 try {
  tab = await chromeCall(chrome.tabs.create, { url: searchUrl, active: false });
 } catch (err) {
  sendResult(requestId, false, `failed to open tab: ${err.message}`, null, null);
  return;
 }

 const watchdog = setTimeout(() => {
  const entry = pendingByRequest.get(requestId);
  if (entry) {
   pendingByRequest.delete(requestId);
   closeTab(entry.tabId);
   sendResult(
    requestId,
    false,
    `extension watchdog: no response within ${effectiveTimeoutMs + 10000}ms`,
    null,
    null
   );
  }
 }, effectiveTimeoutMs + 10000);
 pendingByRequest.set(requestId, { tabId: tab.id, timeoutMs, watchdog });

 await waitForTabLoaded(tab.id, 15000);
 if (!pendingByRequest.has(requestId)) return;

 const runSearchMessage = {
  type: "run-search",
  requestId,
  query,
  timeoutMs: effectiveTimeoutMs,
 };

 try {
  await sendRunSearchWhenReady(
   tab.id,
   runSearchMessage,
   CONTENT_SCRIPT_READY_TIMEOUT_MS
  );
 } catch (err) {
  const entry = pendingByRequest.get(requestId);
  if (!entry) return;
  clearTimeout(entry.watchdog);
  pendingByRequest.delete(requestId);
  closeTab(entry.tabId);
  sendResult(
   requestId,
   false,
   `failed to send run-search to content script: ${err.message}`,
   null,
   null
  );
 }
}

async function sendRunSearchWhenReady(tabId, message, timeoutMs) {
 const maxAttempts = Math.max(
  1,
  Math.ceil(timeoutMs / CONTENT_SCRIPT_RETRY_INTERVAL_MS)
 );
 let lastError = null;

 for (let attempt = 0; attempt < maxAttempts; attempt++) {
  try {
   await chromeCall(chrome.tabs.sendMessage, tabId, message);
   return;
  } catch (err) {
   lastError = err;
   if (attempt < maxAttempts - 1) await sleep(CONTENT_SCRIPT_RETRY_INTERVAL_MS);
  }
 }

 throw lastError || new Error("content script did not become ready");
}

function sleep(ms) {
 return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabLoaded(tabId, timeoutMs) {
 return new Promise((resolve) => {
  let done = false;
  const finish = () => {
   if (done) return;
   done = true;
   clearTimeout(timer);
   chrome.tabs.onUpdated.removeListener(listener);
   resolve();
  };
  const listener = (id, changeInfo) => {
   if (id === tabId && changeInfo.status === "complete") finish();
  };
  const timer = setTimeout(finish, timeoutMs);

  chrome.tabs.onUpdated.addListener(listener);
  chromeCall(chrome.tabs.get, tabId)
   .then((currentTab) => {
    if (currentTab && currentTab.status === "complete") finish();
   })
   .catch(finish);
 });
}

function closeTab(tabId) {
 chromeCall(chrome.tabs.remove, tabId).catch(() => { });
}

function sendResult(requestId, ok, error, html, citations) {
 const p = ensurePort();
 if (!p) {
  console.error("[ask-google] cannot send result: no native port");
  return;
 }
 try {
  p.postMessage({
   requestId,
   ok,
   error: error || null,
   html: html || null,
   citations: citations || null,
  });
 } catch (err) {
  console.error(`[ask-google] postMessage to host failed: ${err.message}`);
 }
}

chrome.runtime.onMessage.addListener((msg) => {
 if (!msg || msg.type !== "search-result") return;
 const { requestId, ok, error, html, citations } = msg;
 const entry = pendingByRequest.get(requestId);
 if (entry) {
  clearTimeout(entry.watchdog);
  pendingByRequest.delete(requestId);
  closeTab(entry.tabId);
 }
 sendResult(requestId, ok, error, html, citations);
});

ensurePort();
