import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const contentSource = readFileSync(
  new URL("../extension/content.js", import.meta.url),
  "utf8"
);

function createHarness() {
  let messageListener = null;
  const sentMessages = [];
  const visibleElement = {
    offsetParent: {},
    getBoundingClientRect() {
      return { width: 1, height: 1 };
    },
    closest() {
      return visibleElement;
    },
  };

  const context = vm.createContext({
    console: {
      error() {},
      warn() {},
      log() {},
    },
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
    URL,
    ANIMA_SELECTORS: {
      CITATION_SELECTORS: ['[aria-label="View related links"]'],
      AI_COMPLETION_BUTTON_SVG: "ai-complete-svg",
      AI_COMPLETION_BUTTON_ARIA: "ai-complete-aria",
      OVERALL_COMPLETION_TIMEOUT: 40000,
      AI_COMPLETION_TEXT_INDICATORS: ["AI-generated"],
      AI_MODE_NOT_AVAILABLE: ["AI Mode is not available"],
      MAIN_CONTAINER: "main-col",
      SIDE_CONTAINER: "rhs-col",
      SKIP_DOMAINS: ["google.com"],
    },
    window: {
      getComputedStyle() {
        return { display: "block", visibility: "visible", opacity: "1" };
      },
    },
    document: {
      body: { innerText: "AI-generated answer" },
      querySelector(selector) {
        if (selector === "ai-complete-svg") return visibleElement;
        if (selector === "main-col") throw new Error("DOM extraction exploded");
        return null;
      },
      createElement() {
        return {
          appendChild() {},
          set className(value) {
            this._className = value;
          },
          set textContent(value) {
            this._textContent = value;
          },
        };
      },
    },
    browser: {
      runtime: {
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          },
        },
        sendMessage(message) {
          sentMessages.push(JSON.parse(JSON.stringify(message)));
        },
      },
    },
    Date,
    Promise,
  });

  vm.runInContext(contentSource, context, { filename: "content.js" });
  assert.equal(typeof messageListener, "function");

  return {
    sentMessages,
    dispatch(message) {
      messageListener(message);
    },
    async flushAsync() {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

test("content script reports a structured error when runSearch throws", async () => {
  const harness = createHarness();

  harness.dispatch({ type: "run-search", requestId: 21, query: "boom", timeoutMs: 60000 });
  await harness.flushAsync();

  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0], {
    type: "search-result",
    requestId: 21,
    ok: false,
    error: "Content script failed: DOM extraction exploded",
    html: null,
    citations: null,
  });
});
