const assert = require("node:assert/strict");
const test = require("node:test");

test("tracks 504 and canceled JSON-RPC requests", () => {
  const listeners = {};
  const event = (name) => ({ addListener(callback) { listeners[name] = callback; } });
  global.chrome = {
    runtime: { onConnect: event("connect") },
    webRequest: {
      onBeforeRequest: event("beforeRequest"),
      onBeforeSendHeaders: event("beforeSendHeaders"),
      onHeadersReceived: event("headersReceived"),
      onCompleted: event("completed"),
      onErrorOccurred: event("errorOccurred"),
    },
    action: { onClicked: event("action") },
    tabs: { create() {}, onRemoved: event("tabRemoved") },
  };

  require("../background.js");

  const messages = [];
  let receiveFromPanel;
  const port = {
    name: "jrpc-viewer-panel",
    onMessage: { addListener(callback) { receiveFromPanel = callback; } },
    onDisconnect: { addListener() {} },
    postMessage(message) { messages.push(structuredClone(message)); },
  };
  listeners.connect(port);
  receiveFromPanel({ type: "subscribe", tabId: 7 });

  const body = JSON.stringify({ jsonrpc: "2.0", method: "users.find", id: 1 });
  listeners.beforeRequest({
    requestId: "request-1",
    tabId: 7,
    method: "POST",
    url: "https://users.example/rpc",
    timeStamp: 1000,
    requestBody: { raw: [{ bytes: new TextEncoder().encode(body).buffer }] },
  });
  assert.equal(messages.at(-1).request.method, "users.find");
  assert.equal(messages.at(-1).request.status, "pending");

  listeners.headersReceived({
    requestId: "request-1",
    statusCode: 504,
    statusLine: "HTTP/2 504 Gateway Timeout",
    responseHeaders: [{ name: "server", value: "gateway" }],
  });
  listeners.completed({ requestId: "request-1", statusCode: 504, timeStamp: 1350 });
  assert.equal(messages.at(-1).changes.status, "error");
  assert.equal(messages.at(-1).changes.duration, 350);

  const canceledBody = JSON.stringify({ jsonrpc: "2.0", method: "reports.cancelable", id: 2 });
  listeners.beforeRequest({
    requestId: "request-2",
    tabId: 7,
    method: "POST",
    url: "https://reports.example/rpc",
    timeStamp: 2000,
    requestBody: { raw: [{ bytes: new TextEncoder().encode(canceledBody).buffer }] },
  });
  listeners.errorOccurred({ requestId: "request-2", error: "net::ERR_ABORTED", timeStamp: 2125 });
  assert.equal(messages.at(-1).changes.status, "canceled");
  assert.equal(messages.at(-1).changes.duration, 125);
});
