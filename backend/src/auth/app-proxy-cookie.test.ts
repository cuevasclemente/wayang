import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldForwardAppProxyRequestHeader,
  shouldForwardAppProxyResponseHeader,
} from "../routes/apps.js";

test("app proxy does not disclose browser credentials or internal capabilities upstream", () => {
  for (const header of [
    "Cookie",
    "Authorization",
    "Proxy-Authorization",
    "Forwarded",
    "X-Forwarded-For",
    "X-Forwarded-Host",
    "X-Forwarded-Proto",
    "X-Wayang-Apps-Actor",
    "X-Wayang-Apps-Agent-Token",
    "X-Wayang-Browser-Actor",
    "X-Wayang-Browser-Agent-Token",
    "X-Wayang-Source-Session-Id",
  ]) {
    assert.equal(shouldForwardAppProxyRequestHeader(header), false, header);
  }
  assert.equal(shouldForwardAppProxyRequestHeader("Accept"), true);
  assert.equal(shouldForwardAppProxyRequestHeader("User-Agent"), true);
});

test("app proxy does not let an app set cookies on the Wayang origin", () => {
  assert.equal(shouldForwardAppProxyResponseHeader("Set-Cookie"), false);
  assert.equal(shouldForwardAppProxyResponseHeader("Content-Type"), true);
  assert.equal(shouldForwardAppProxyResponseHeader("Cache-Control"), true);
});
