import {
  buildCurl,
  buildSearchText,
  copyText,
  formatDuration,
  getDisplayUrl,
  getServiceName,
  makeElement,
  normalize,
  parseJson,
  prettyValue,
  statusLabel,
} from "./panel-utils.mjs";

const MAX_REQUESTS = 1000;
const KEEPALIVE_INTERVAL = 20000;
const DURATION_UPDATE_INTERVAL = 250;
const SEARCHABLE_FIELDS = new Set([
  "method", "httpMethod", "url", "status", "statusCode", "error", "requestBody", "responseBody",
]);
const LIST_FIELDS = new Set(["method", "url", "status", "statusCode", "duration", "startedAt"]);
const RESPONSE_FIELDS = new Set(["responseBody", "status", "error"]);
const INFO_FIELDS = new Set([
  "url", "httpMethod", "method", "status", "statusCode", "statusLine", "duration", "error",
  "requestHeaders", "responseHeaders",
]);

const state = {
  requests: new Map(),
  searchIndex: new Map(),
  listItems: new Map(),
  services: new Set(),
  selectedId: null,
  activeTab: "request",
  search: "",
  service: "",
};

const elements = {
  clearButton: document.querySelector("#clear-button"),
  copyCurlButton: document.querySelector("#copy-curl-button"),
  copyJsonButton: document.querySelector("#copy-json-button"),
  count: document.querySelector("#request-count"),
  details: document.querySelector("#details-content"),
  empty: document.querySelector("#empty-state"),
  infoPanel: document.querySelector("#info-panel"),
  list: document.querySelector("#request-list"),
  requestPanel: document.querySelector("#request-panel"),
  responsePanel: document.querySelector("#response-panel"),
  searchInput: document.querySelector("#search-input"),
  serviceInput: document.querySelector("#service-input"),
  serviceOptions: document.querySelector("#service-options"),
  tabs: [...document.querySelectorAll(".tab")],
};

let port = null;
let reconnectTimer = null;

function connectBackground() {
  if (port) return;

  const connection = chrome.runtime.connect({ name: "jrpc-viewer-panel" });
  port = connection;
  connection.onMessage.addListener(handleBackgroundMessage);
  connection.onDisconnect.addListener(() => {
    if (port !== connection) return;
    port = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectBackground, 500);
  });
  connection.postMessage({ type: "subscribe", tabId: chrome.devtools.inspectedWindow.tabId });
}

function sendToBackground(message) {
  if (!port) return;
  try {
    port.postMessage(message);
  } catch {
    // onDisconnect reconnects the panel if the MV3 worker was restarted.
  }
}

function visibleRequests() {
  return [...state.requests.values()]
    .filter((request) => !state.search || state.searchIndex.get(request.id)?.includes(state.search))
    .filter((request) => !state.service || normalize(request.url).includes(state.service))
    .sort((left, right) => right.startedAt - left.startedAt);
}

function createRequestItem() {
  const item = makeElement("button", "request-item");
  item.type = "button";

  const top = makeElement("span", "request-item-top");
  const method = makeElement("span", "request-method");
  const status = makeElement("span", "status");
  top.append(method, status);

  const bottom = makeElement("span", "request-item-bottom");
  const url = makeElement("span", "request-url");
  const duration = makeElement("span", "request-duration");
  bottom.append(url, duration);
  item.append(top, bottom);
  item.requestParts = { method, status, url, duration };
  return item;
}

function updateRequestItem(item, request) {
  const { method, status, url, duration } = item.requestParts;
  item.dataset.requestId = request.id;
  item.classList.toggle("active", request.id === state.selectedId);
  method.textContent = request.method;
  status.className = `status status-${request.status}`;
  status.textContent = statusLabel(request);
  url.textContent = getDisplayUrl(request.url);
  url.title = request.url;
  duration.textContent = formatDuration(request);
}

function renderList({ keepContentAnchor = false, resetScroll = false } = {}) {
  const requests = visibleRequests();
  const oldScrollTop = elements.list.scrollTop;
  const oldScrollHeight = elements.list.scrollHeight;
  const nextItems = new Map();
  const fragment = document.createDocumentFragment();

  for (const request of requests) {
    const item = state.listItems.get(request.id) || createRequestItem();
    updateRequestItem(item, request);
    nextItems.set(request.id, item);
    fragment.append(item);
  }

  if (!requests.length) {
    fragment.append(makeElement(
      "div",
      "no-results",
      state.requests.size ? "Ничего не найдено" : "Запросов пока нет",
    ));
  }

  elements.list.replaceChildren(fragment);
  state.listItems = nextItems;
  elements.count.textContent = `${requests.length}/${state.requests.size}`;

  if (resetScroll) {
    elements.list.scrollTop = 0;
  } else if (keepContentAnchor && oldScrollTop > 0) {
    elements.list.scrollTop = oldScrollTop + elements.list.scrollHeight - oldScrollHeight;
  } else {
    elements.list.scrollTop = oldScrollTop;
  }
}

function hasChanged(changedFields, relevantFields) {
  return !changedFields || changedFields.some((field) => relevantFields.has(field));
}

function refreshListItem(request, changedFields) {
  // Search results may change after a response/status update; without search a keyed update is enough.
  if (state.search && hasChanged(changedFields, SEARCHABLE_FIELDS)) {
    renderList();
    return;
  }
  if (!hasChanged(changedFields, LIST_FIELDS)) return;
  const item = state.listItems.get(request.id);
  if (item) updateRequestItem(item, request);
}

function addServiceOption(url) {
  const service = getServiceName(url);
  if (!service || state.services.has(service)) return;
  state.services.add(service);
  const option = document.createElement("option");
  option.value = service;
  elements.serviceOptions.append(option);
}

function rebuildServiceOptions() {
  state.services.clear();
  elements.serviceOptions.replaceChildren();
  for (const request of state.requests.values()) addServiceOption(request.url);
}

function renderJsonPanel(container, value, emptyMessage) {
  const pre = makeElement("pre", "json-view");
  pre.textContent = value === null || value === undefined || value === "" ? emptyMessage : prettyValue(value);
  container.replaceChildren(pre);
}

function addInfoRow(container, label, value, className = "") {
  const row = makeElement("div", "info-row");
  const content = makeElement("dd", `info-value${className ? ` ${className}` : ""}`, value || "—");
  row.append(makeElement("dt", "info-key", label), content);
  container.append(row);
  return content;
}

function renderHeaders(title, headers) {
  const section = makeElement("section", "headers-section");
  section.append(makeElement("h3", "section-title", `${title} (${headers?.length || 0})`));
  if (!headers?.length) {
    section.append(makeElement("div", "headers-empty", "Нет доступных заголовков"));
    return section;
  }

  const table = makeElement("div", "headers-table");
  for (const header of headers) {
    const row = makeElement("div", "header-row");
    row.append(
      makeElement("div", "header-name", header.name),
      makeElement("div", "header-value", header.value),
    );
    table.append(row);
  }
  section.append(table);
  return section;
}

function renderInfo(request) {
  const scrollTop = elements.infoPanel.scrollTop;
  elements.infoPanel.replaceChildren();
  const summary = makeElement("dl", "info-summary");
  addInfoRow(summary, "Request URL", request.url);
  addInfoRow(summary, "HTTP-метод", request.httpMethod);
  addInfoRow(summary, "JSON-RPC метод", request.method);
  addInfoRow(summary, "Статус", `${statusLabel(request)}${request.statusLine ? ` · ${request.statusLine}` : ""}`);
  addInfoRow(summary, "Длительность", formatDuration(request), "live-info-duration");
  if (request.error) addInfoRow(summary, "Ошибка", request.error);

  elements.infoPanel.append(
    summary,
    renderHeaders("Request Headers", request.requestHeaders),
    renderHeaders("Response Headers", request.responseHeaders),
  );
  elements.infoPanel.scrollTop = scrollTop;
}

function responseEmptyMessage(request) {
  if (request.status === "pending") return "Ожидается ответ...";
  if (request.status === "canceled") return "Запрос отменён";
  return request.error || "Тело ответа пустое или недоступно";
}

function renderResponse(request) {
  renderJsonPanel(elements.responsePanel, request.responseBody, responseEmptyMessage(request));
}

function getActiveJsonValue(request) {
  if (!request || state.activeTab === "info") return null;
  return state.activeTab === "request" ? request.requestBody : request.responseBody;
}

function updateCopyActions() {
  const request = state.requests.get(state.selectedId);
  const jsonValue = getActiveJsonValue(request);
  elements.copyCurlButton.disabled = !request;
  elements.copyJsonButton.disabled = jsonValue === null || jsonValue === undefined || jsonValue === "";
  elements.copyJsonButton.title = state.activeTab === "info"
    ? "JSON доступен на вкладках «Запрос» и «Ответ»"
    : "";
}

function renderDetails() {
  const request = state.requests.get(state.selectedId);
  elements.empty.classList.toggle("hidden", Boolean(request));
  elements.details.classList.toggle("hidden", !request);
  if (!request) {
    updateCopyActions();
    return;
  }

  renderJsonPanel(elements.requestPanel, request.requestBody, "Тело запроса недоступно");
  renderResponse(request);
  renderInfo(request);
  showTab(state.activeTab);
}

function refreshSelectedDetails(request, changedFields) {
  if (request.id !== state.selectedId) return;
  if (hasChanged(changedFields, RESPONSE_FIELDS)) renderResponse(request);
  if (hasChanged(changedFields, INFO_FIELDS)) renderInfo(request);
  updateCopyActions();
}

function showTab(tabName) {
  state.activeTab = tabName;
  for (const tab of elements.tabs) tab.classList.toggle("active", tab.dataset.tab === tabName);
  for (const name of ["request", "response", "info"]) {
    document.querySelector(`#${name}-panel`).classList.toggle("hidden", name !== tabName);
  }
  updateCopyActions();
}

function selectRequest(requestId) {
  if (!state.requests.has(requestId) || requestId === state.selectedId) return;
  const previousItem = state.listItems.get(state.selectedId);
  state.selectedId = requestId;
  if (previousItem) previousItem.classList.remove("active");
  state.listItems.get(requestId)?.classList.add("active");
  renderDetails();
}

function trimPanelRequests() {
  while (state.requests.size > MAX_REQUESTS) {
    const oldestId = state.requests.keys().next().value;
    state.requests.delete(oldestId);
    state.searchIndex.delete(oldestId);
    state.listItems.delete(oldestId);
    if (state.selectedId === oldestId) state.selectedId = null;
  }
}

function mergeRequest(request, changedFields) {
  const previous = state.requests.get(request.id);
  const merged = { ...previous, ...request };
  if (request.responseBody === null && previous?.responseBody != null) {
    merged.responseBody = previous.responseBody;
  }
  state.requests.set(request.id, merged);
  if (!previous || hasChanged(changedFields, SEARCHABLE_FIELDS)) {
    state.searchIndex.set(request.id, buildSearchText(merged));
  }
  return { request: merged, isNew: !previous };
}

function upsertRequest(incomingRequest, changedFields = null) {
  const { request, isNew } = mergeRequest(incomingRequest, changedFields);
  if (isNew) {
    addServiceOption(request.url);
    trimPanelRequests();
    if (!state.selectedId) state.selectedId = request.id;
    renderList({ keepContentAnchor: true });
    if (request.id === state.selectedId) renderDetails();
    return;
  }

  refreshListItem(request, changedFields);
  refreshSelectedDetails(request, changedFields);
}

function updateRequest(requestId, changes) {
  const previous = state.requests.get(requestId);
  if (!previous) return;
  upsertRequest({ ...previous, ...changes }, Object.keys(changes));
}

function handleBackgroundMessage(message) {
  if (message.type === "snapshot") {
    for (const incomingRequest of message.requests) {
      const previous = state.requests.get(incomingRequest.id);
      const request = {
        ...incomingRequest,
        responseBody: previous?.responseBody ?? incomingRequest.responseBody,
      };
      state.requests.set(request.id, request);
      state.searchIndex.set(request.id, buildSearchText(request));
    }
    trimPanelRequests();
    if (!state.selectedId && state.requests.size) {
      state.selectedId = [...state.requests.keys()].at(-1);
    }
    rebuildServiceOptions();
    renderList();
    renderDetails();
    return;
  }

  if (message.type === "request") upsertRequest(message.request);
  if (message.type === "request-update") updateRequest(message.requestId, message.changes);
  if (message.type === "request-remove") removeRequest(message.requestId);
}

function removeRequest(requestId) {
  if (!state.requests.delete(requestId)) return;
  state.searchIndex.delete(requestId);
  state.listItems.delete(requestId);
  if (state.selectedId === requestId) {
    state.selectedId = visibleRequests()[0]?.id || null;
    renderDetails();
  }
  renderList();
}

function findRequestForEntry(entry) {
  const bodyText = entry.request?.postData?.text || "";
  const startedAt = Date.parse(entry.startedDateTime) || Date.now();
  let closestRequest = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const request of state.requests.values()) {
    if (request.url !== entry.request?.url) continue;
    if (bodyText && request.requestBodyText !== bodyText) continue;
    const distance = Math.abs(request.startedAt - startedAt);
    if (distance < closestDistance) {
      closestRequest = request;
      closestDistance = distance;
    }
  }
  return closestRequest;
}

// webRequest provides lifecycle/error data; the DevTools API complements it with response bodies.
chrome.devtools.network.onRequestFinished.addListener((entry) => {
  const request = findRequestForEntry(entry);
  if (!request) return;

  entry.getContent((content) => {
    const changes = {
      responseBody: parseJson(content) ?? content ?? "",
      statusCode: entry.response?.status || request.statusCode,
      statusLine: entry.response?.statusText || request.statusLine,
    };
    if (!request.responseHeaders?.length && entry.response?.headers) {
      changes.responseHeaders = entry.response.headers.map(({ name, value }) => ({ name, value }));
    }
    updateRequest(request.id, changes);
  });
});

elements.list.addEventListener("click", (event) => {
  const item = event.target.closest(".request-item");
  if (item) selectRequest(item.dataset.requestId);
});

elements.copyCurlButton.addEventListener("click", () => {
  const request = state.requests.get(state.selectedId);
  if (request) copyText(buildCurl(request), elements.copyCurlButton);
});

elements.copyJsonButton.addEventListener("click", () => {
  const value = getActiveJsonValue(state.requests.get(state.selectedId));
  if (value !== null && value !== undefined && value !== "") {
    copyText(prettyValue(value), elements.copyJsonButton);
  }
});

elements.searchInput.addEventListener("input", (event) => {
  state.search = normalize(event.target.value);
  renderList({ resetScroll: true });
});

elements.serviceInput.addEventListener("input", (event) => {
  state.service = normalize(event.target.value);
  renderList({ resetScroll: true });
});

elements.clearButton.addEventListener("click", () => {
  state.requests.clear();
  state.searchIndex.clear();
  state.listItems.clear();
  state.services.clear();
  state.selectedId = null;
  elements.serviceOptions.replaceChildren();
  sendToBackground({ type: "clear" });
  renderList({ resetScroll: true });
  renderDetails();
});

for (const tab of elements.tabs) {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
}

setInterval(() => {
  for (const request of state.requests.values()) {
    if (request.status !== "pending") continue;
    const item = state.listItems.get(request.id);
    if (item) item.requestParts.duration.textContent = formatDuration(request);
  }
  const selected = state.requests.get(state.selectedId);
  const infoDuration = elements.infoPanel.querySelector(".live-info-duration");
  if (selected?.status === "pending" && infoDuration) {
    infoDuration.textContent = formatDuration(selected);
  }
}, DURATION_UPDATE_INTERVAL);

setInterval(() => sendToBackground({ type: "keepalive" }), KEEPALIVE_INTERVAL);

connectBackground();
renderList();
