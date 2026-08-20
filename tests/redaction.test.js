import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSensitiveBody } from "../src/browser.js";
import { networkEntryForDebug } from "../src/tools.js";

test("network request bodies redact credentials recursively", () => {
  const result = redactSensitiveBody({
    username: "29130",
    password: "do-not-log",
    nested: { access_token: "token-value", credential: "turn-secret", harmless: "kept" },
    items: [{ apiKey: "key-value", session_id: "session-value" }],
  });

  assert.deepEqual(result, {
    username: "[redacted]",
    password: "[redacted]",
    nested: { access_token: "[redacted]", credential: "[redacted]", harmless: "kept" },
    items: [{ apiKey: "[redacted]", session_id: "[redacted]" }],
  });
});

test("network debug entries omit bodies by default", () => {
  const entry = {
    url: "http://localhost/api/login",
    method: "POST",
    status: 200,
    requestBody: { username: "[redacted]", password: "[redacted]" },
    responseBody: { token: "[redacted]", success: true },
  };

  assert.deepEqual(networkEntryForDebug(entry), {
    url: "http://localhost/api/login",
    method: "POST",
    status: 200,
  });
  assert.deepEqual(networkEntryForDebug(entry, { includeBodies: true }), entry);
});
