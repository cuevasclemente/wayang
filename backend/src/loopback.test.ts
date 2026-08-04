import assert from "node:assert/strict";
import test from "node:test";

import { isLoopbackAddress, isLoopbackHost } from "./loopback.js";

test("strict loopback parsing accepts canonical IPv4, IPv6, mapped IPv4, and localhost hosts", () => {
  for (const address of ["127.0.0.1", "127.42.3.4", "::1", "[::1]", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("LOCALHOST"), true);
});

test("strict loopback parsing rejects malformed numeric names and non-loopback addresses", () => {
  for (const value of [
    "127.example.test",
    "127.0.0.999",
    "127.00.00.01",
    "::ffff:127.0.0.999",
    "192.0.2.1",
    "::",
    "",
  ]) {
    assert.equal(isLoopbackAddress(value), false, value);
    assert.equal(isLoopbackHost(value), false, value);
  }
  assert.equal(isLoopbackAddress("localhost"), false);
});
