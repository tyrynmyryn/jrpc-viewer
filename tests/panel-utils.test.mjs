import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCurl,
  buildSearchText,
  formatDuration,
  getDisplayUrl,
  normalize,
  parseJson,
  prettyValue,
  statusLabel,
} from "../panel-utils.mjs";

const request = {
  method: "users.find",
  httpMethod: "POST",
  url: "https://users.example/rpc",
  status: "success",
  statusCode: 200,
  error: "",
  requestBody: { jsonrpc: "2.0", method: "users.find", params: { name: "O'Reilly" } },
  requestBodyText: "{\"name\":\"O'Reilly\"}",
  responseBody: { result: true },
  requestHeaders: [{ name: "content-type", value: "application/json" }],
  startedAt: 1000,
  duration: 1250,
};

test("formats and indexes request data", () => {
  assert.deepEqual(parseJson("{\"ok\":true}"), { ok: true });
  assert.equal(parseJson("not json"), null);
  assert.equal(normalize("  USERS.Find "), "users.find");
  assert.match(buildSearchText(request), /users\.find/);
  assert.equal(getDisplayUrl(request.url), "users.example/rpc");
  assert.equal(formatDuration(request), "1.25 с");
  assert.equal(statusLabel(request), "200");
  assert.equal(prettyValue({ ok: true }), "{\n  \"ok\": true\n}");
});

test("builds a shell-safe cURL command", () => {
  const curl = buildCurl(request);
  assert.match(curl, /-H 'content-type: application\/json'/);
  assert.match(curl, /O'\\''Reilly/);
});
