const requests = new Map();
const requestIdsByTab = new Map();
const subscribers = new Map();

const JSON_RPC_PATTERN = /"jsonrpc"\s*:/i;
const MAX_REQUESTS_PER_TAB = 1000;

function decodeRequestBody(requestBody) {
  if (!requestBody) return "";

  if (requestBody.raw) {
    const chunks = requestBody.raw
      .map((part) => part.bytes && new Uint8Array(part.bytes))
      .filter(Boolean);
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const decoder = new TextDecoder("utf-8");
    return decoder.decode(bytes);
  }

  if (requestBody.formData) {
    return new URLSearchParams(
      Object.entries(requestBody.formData).flatMap(([key, values]) =>
        values.map((value) => [key, value]),
      ),
    ).toString();
  }

  return "";
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isJsonRpc(bodyText, parsedBody) {
  if (Array.isArray(parsedBody)) {
    return parsedBody.some((item) => item && item.jsonrpc);
  }
  return Boolean(parsedBody && parsedBody.jsonrpc) || JSON_RPC_PATTERN.test(bodyText);
}

function getMethod(parsedBody) {
  if (Array.isArray(parsedBody)) {
    const methods = parsedBody.map((item) => item && item.method).filter(Boolean);
    return methods.join(", ") || "JSON-RPC batch";
  }
  return (parsedBody && parsedBody.method) || "JSON-RPC";
}

function normalizeHeaders(headers = []) {
  return headers.map(({ name, value, binaryValue }) => ({
    name,
    value: value ?? (binaryValue ? `[binary: ${binaryValue.length} bytes]` : ""),
  }));
}

function notify(tabId, message) {
  for (const port of subscribers.get(tabId) || []) {
    try {
      port.postMessage(message);
    } catch {
      // The disconnect listener removes stale ports.
    }
  }
}

function trackRequest(request) {
  requests.set(request.id, request);
  const requestIds = requestIdsByTab.get(request.tabId) || new Set();
  requestIds.add(request.id);
  requestIdsByTab.set(request.tabId, requestIds);

  while (requestIds.size > MAX_REQUESTS_PER_TAB) {
    const oldestId = requestIds.values().next().value;
    requestIds.delete(oldestId);
    requests.delete(oldestId);
    notify(request.tabId, { type: "request-remove", requestId: oldestId });
  }
}

function clearTabRequests(tabId) {
  for (const requestId of requestIdsByTab.get(tabId) || []) requests.delete(requestId);
  requestIdsByTab.delete(tabId);
}

function updateRequest(request, changes) {
  Object.assign(request, changes);
  notify(request.tabId, {
    type: "request-update",
    requestId: request.id,
    changes,
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "jrpc-viewer-panel") return;

  let inspectedTabId = null;
  port.onMessage.addListener((message) => {
    if (message.type === "subscribe" && Number.isInteger(message.tabId)) {
      if (inspectedTabId !== null && inspectedTabId !== message.tabId) {
        const previousPorts = subscribers.get(inspectedTabId);
        previousPorts?.delete(port);
        if (!previousPorts?.size) subscribers.delete(inspectedTabId);
      }
      inspectedTabId = message.tabId;
      const ports = subscribers.get(inspectedTabId) || new Set();
      ports.add(port);
      subscribers.set(inspectedTabId, ports);

      const snapshot = [...(requestIdsByTab.get(inspectedTabId) || [])]
        .map((requestId) => requests.get(requestId))
        .filter(Boolean);
      port.postMessage({ type: "snapshot", requests: snapshot });
    }

    if (message.type === "clear" && inspectedTabId !== null) {
      clearTabRequests(inspectedTabId);
    }
  });

  port.onDisconnect.addListener(() => {
    if (inspectedTabId === null) return;
    const ports = subscribers.get(inspectedTabId);
    ports?.delete(port);
    if (!ports?.size) subscribers.delete(inspectedTabId);
  });
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;

    const bodyText = decodeRequestBody(details.requestBody);
    const parsedBody = parseJson(bodyText);
    if (!isJsonRpc(bodyText, parsedBody)) return;

    const request = {
      id: details.requestId,
      tabId: details.tabId,
      method: getMethod(parsedBody),
      httpMethod: details.method,
      url: details.url,
      requestBodyText: bodyText,
      requestBody: parsedBody ?? bodyText,
      requestHeaders: [],
      responseHeaders: [],
      responseBody: null,
      status: "pending",
      statusCode: null,
      statusLine: "",
      error: "",
      startedAt: details.timeStamp,
      finishedAt: null,
      duration: null,
    };

    trackRequest(request);
    notify(details.tabId, { type: "request", request });
  },
  { urls: ["<all_urls>"] },
  ["requestBody"],
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const request = requests.get(details.requestId);
    if (!request) return;
    updateRequest(request, { requestHeaders: normalizeHeaders(details.requestHeaders) });
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"],
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const request = requests.get(details.requestId);
    if (!request) return;
    updateRequest(request, {
      statusCode: details.statusCode,
      statusLine: details.statusLine || "",
      responseHeaders: normalizeHeaders(details.responseHeaders),
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"],
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const request = requests.get(details.requestId);
    if (!request) return;
    updateRequest(request, {
      status: details.statusCode >= 400 ? "error" : "success",
      statusCode: details.statusCode,
      finishedAt: details.timeStamp,
      duration: Math.max(0, details.timeStamp - request.startedAt),
    });
  },
  { urls: ["<all_urls>"] },
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    const request = requests.get(details.requestId);
    if (!request) return;
    updateRequest(request, {
      status: details.error === "net::ERR_ABORTED" ? "canceled" : "error",
      error: details.error || "Network error",
      finishedAt: details.timeStamp,
      duration: Math.max(0, details.timeStamp - request.startedAt),
    });
  },
  { urls: ["<all_urls>"] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabRequests(tabId);
  subscribers.delete(tabId);
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: "https://github.com/tyrynmyryn/jrpc-viewer" });
});
