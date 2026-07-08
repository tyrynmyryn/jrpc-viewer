export function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function serialize(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function normalize(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

export function formatDuration(request) {
  const duration = request.duration ?? Math.max(0, Date.now() - request.startedAt);
  if (duration < 1000) return `${Math.round(duration)} мс`;
  if (duration < 60000) return `${(duration / 1000).toFixed(duration < 10000 ? 2 : 1)} с`;
  return `${Math.floor(duration / 60000)} мин ${Math.round((duration % 60000) / 1000)} с`;
}

export function statusLabel(request) {
  if (request.status === "pending") return "выполняется";
  if (request.status === "canceled") return "canceled";
  if (request.statusCode) return String(request.statusCode);
  return request.status === "success" ? "успешно" : "ошибка";
}

export function buildSearchText(request) {
  return normalize([
    request.method,
    request.httpMethod,
    request.url,
    request.status,
    request.statusCode,
    request.error,
    serialize(request.requestBody),
    serialize(request.responseBody),
  ].join(" "));
}

export function getServiceName(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function getDisplayUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return `${parsedUrl.host}${parsedUrl.pathname}`;
  } catch {
    return url;
  }
}

export function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function prettyValue(value) {
  if (typeof value === "string") {
    const parsed = parseJson(value);
    return parsed === null ? value : JSON.stringify(parsed, null, 2);
  }
  return JSON.stringify(value, null, 2);
}

function quoteShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildCurl(request) {
  const parts = [`curl ${quoteShell(request.url)}`, `  -X ${request.httpMethod || "POST"}`];
  for (const header of request.requestHeaders || []) {
    parts.push(`  -H ${quoteShell(`${header.name}: ${header.value}`)}`);
  }
  if (request.requestBodyText) parts.push(`  --data-raw ${quoteShell(request.requestBodyText)}`);
  return parts.join(" \\\n");
}

export async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  const originalText = button.copyOriginalText || button.textContent;
  button.copyOriginalText = originalText;
  clearTimeout(button.copyFeedbackTimer);
  button.textContent = "Скопировано";
  button.copyFeedbackTimer = setTimeout(() => {
    button.textContent = originalText;
    button.copyFeedbackTimer = null;
  }, 1200);
}
