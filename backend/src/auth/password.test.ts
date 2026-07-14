import assert from "node:assert/strict";
import test from "node:test";
import { createPasswordHash, isPasswordHashRecord, verifyPassword } from "./password.js";

test("scrypt password records are salted, versioned, and verify through equal-length comparison", async () => {
  const first = await createPasswordHash("correct horse battery staple");
  const second = await createPasswordHash("correct horse battery staple");

  assert.match(first, /^scrypt\$1\$16384\$8\$1\$32\$/);
  assert.notEqual(first, second);
  assert.equal(isPasswordHashRecord(first), true);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("correct horse battery staplf", first), false);
});

test("malformed or resource-amplifying scrypt records fail closed", async () => {
  const valid = await createPasswordHash("password");
  const records = [
    "",
    "not-scrypt",
    valid.replace("scrypt$1$", "scrypt$2$"),
    valid.replace("$16384$", "$32768$"),
    valid.replace("$8$1$", "$9$1$"),
    valid.replace(/[^$]+$/, "bad+base64"),
  ];
  for (const record of records) {
    assert.equal(isPasswordHashRecord(record), false);
    assert.equal(await verifyPassword("password", record), false);
  }
  assert.equal(await verifyPassword("x".repeat(1_025), valid), false);
  assert.equal(await verifyPassword(null, valid), false);
});
