import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const backgroundSource = readFileSync(
  new URL("../extension/background.js", import.meta.url),
  "utf8"
);

function createHarness(options = {}) {
  const {
    initialTabStatus = "loading",
    sendMessageError = null,
    sendMessageFailuresBeforeSuccess = 0,
  } = options;

  let nativeMessageListener = null;
  let extensionMessageListener = null;
  const tabId = 100;
  let tabStatus = initialTabStatus;
  let sendMessageFailuresRemaining = sendMessageFailuresBeforeSuccess;
  const portMessages = [];
  const sendMessageCalls = [];
  const removedTabs = [];
  const onUpdatedListeners = new Set();
  const timers = new Map();
  let nextTimerId = 1;

  const port = {
    onMessage: {
      addListener(listener) {
        nativeMessageListener = listener;
      },
    },
    onDisconnect: {
      addListener() {},
    },
    postMessage(message) {
      portMessages.push(JSON.parse(JSON.stringify(message)));
    },
  };

  const context = vm.createContext({
    console: {
      error() {},
      warn() {},
      log() {},
    },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    browser: {
      runtime: {
        connectNative() {
          return port;
        },
        onMessage: {
          addListener(listener) {
            extensionMessageListener = listener;
          },
        },
      },
      tabs: {
        async create() {
          return { id: tabId, status: tabStatus };
        },
        async get(id) {
          assert.equal(id, tabId);
          return { id: tabId, status: tabStatus };
        },
        async sendMessage(id, message) {
          sendMessageCalls.push({ tabId: id, message: JSON.parse(JSON.stringify(message)) });
          if (sendMessageFailuresRemaining > 0) {
            sendMessageFailuresRemaining -= 1;
            throw new Error("Could not establish connection. Receiving end does not exist.");
          }
          if (sendMessageError) throw new Error(sendMessageError);
        },
        async remove(id) {
          removedTabs.push(id);
        },
        onUpdated: {
          addListener(listener) {
            onUpdatedListeners.add(listener);
          },
          removeListener(listener) {
            onUpdatedListeners.delete(listener);
          },
        },
      },
    },
  });

  vm.runInContext(backgroundSource, context, { filename: "background.js" });
  assert.equal(typeof nativeMessageListener, "function");
  assert.equal(typeof extensionMessageListener, "function");

  return {
    portMessages,
    sendMessageCalls,
    removedTabs,
    onUpdatedListeners,
    dispatchNative(message) {
      nativeMessageListener(message);
    },
    fireTabComplete() {
      tabStatus = "complete";
      for (const listener of [...onUpdatedListeners]) {
        listener(tabId, { status: "complete" }, { id: tabId, status: tabStatus });
      }
    },
    runTimerByDelay(delay) {
      const timer = [...timers.entries()].find(([, value]) => value.delay === delay);
      assert.ok(timer, `expected timer with delay ${delay}`);
      timers.delete(timer[0]);
      timer[1].callback();
    },
    async runAllTimersByDelay(delay, limit = 100) {
      let count = 0;
      for (;;) {
        await this.flushAsync();
        const timer = [...timers.entries()].find(([, value]) => value.delay === delay);
        if (!timer) return count;
        timers.delete(timer[0]);
        timer[1].callback();
        count += 1;
        assert.ok(count <= limit, `ran more than ${limit} timers with delay ${delay}`);
      }
    },
    async flushAsync() {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}

test("background sends run-search to the content script after the tab loads", async () => {
  const harness = createHarness();

  harness.dispatchNative({ requestId: 7, query: "capital of France", timeoutMs: 5000 });
  await harness.flushAsync();

  assert.equal(harness.sendMessageCalls.length, 0);

  harness.fireTabComplete();
  await harness.flushAsync();

  assert.deepEqual(harness.sendMessageCalls, [
    {
      tabId: 100,
      message: {
        type: "run-search",
        requestId: 7,
        query: "capital of France",
        timeoutMs: 5000,
      },
    },
  ]);
  assert.equal(harness.onUpdatedListeners.size, 0);
});

test("background sends run-search immediately when the tab is already loaded", async () => {
  const harness = createHarness({ initialTabStatus: "complete" });

  harness.dispatchNative({ requestId: 8, query: "already loaded", timeoutMs: 6000 });
  await harness.flushAsync();

  assert.deepEqual(harness.sendMessageCalls, [
    {
      tabId: 100,
      message: {
        type: "run-search",
        requestId: 8,
        query: "already loaded",
        timeoutMs: 6000,
      },
    },
  ]);
});

test("background returns an explicit error and closes the tab when content dispatch fails", async () => {
  const harness = createHarness({
    sendMessageError: "Could not establish connection. Receiving end does not exist.",
  });

  harness.dispatchNative({ requestId: 9, query: "dispatch fails", timeoutMs: 7000 });
  await harness.flushAsync();
  harness.fireTabComplete();
  await harness.flushAsync();
  await harness.runAllTimersByDelay(250);
  await harness.flushAsync();

  assert.ok(harness.sendMessageCalls.length > 1);
  assert.deepEqual(harness.removedTabs, [100]);
  assert.equal(harness.portMessages.length, 1);
  assert.deepEqual(harness.portMessages[0], {
    requestId: 9,
    ok: false,
    error:
      "failed to send run-search to content script: Could not establish connection. Receiving end does not exist.",
    html: null,
    citations: null,
  });
});

test("background retries run-search dispatch until the content listener is ready", async () => {
  const harness = createHarness({
    initialTabStatus: "complete",
    sendMessageFailuresBeforeSuccess: 1,
  });

  harness.dispatchNative({ requestId: 11, query: "retry", timeoutMs: 8000 });
  await harness.flushAsync();

  assert.equal(harness.sendMessageCalls.length, 1);
  assert.deepEqual(harness.portMessages, []);
  assert.deepEqual(harness.removedTabs, []);

  harness.runTimerByDelay(250);
  await harness.flushAsync();

  assert.equal(harness.sendMessageCalls.length, 2);
  assert.deepEqual(harness.portMessages, []);
  assert.deepEqual(harness.removedTabs, []);
});

test("background closes the tab on watchdog timeout and does not dispatch afterward", async () => {
  const harness = createHarness();

  harness.dispatchNative({ requestId: 10, query: "timeout", timeoutMs: 2000 });
  await harness.flushAsync();

  harness.runTimerByDelay(12000);
  await harness.flushAsync();

  assert.deepEqual(harness.removedTabs, [100]);
  assert.equal(harness.portMessages.length, 1);
  assert.equal(harness.portMessages[0].requestId, 10);
  assert.equal(harness.portMessages[0].ok, false);
  assert.match(harness.portMessages[0].error, /extension watchdog: no response within 12000ms/);

  harness.runTimerByDelay(15000);
  await harness.flushAsync();

  assert.deepEqual(harness.sendMessageCalls, []);
});
