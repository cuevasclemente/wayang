import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldForwardAppProxyRequestHeader,
  shouldForwardAppProxyResponseHeader,
} from "../routes/apps.js";

test("app proxy does not disclose browser credentials upstream", () => {
  for (const header of [
    "Cookie",
    "Authorization",
    "Proxy-Authorization",
    "Forwarded",
    "X-Forwarded-For",
    "X-Forwarded-Host",
    "X-Forwarded-Proto",
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
