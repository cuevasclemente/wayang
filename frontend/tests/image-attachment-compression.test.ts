import assert from "node:assert/strict";
import test from "node:test";
import { shouldCompressImageForAttachment } from "../src/panels/imageAttachmentCompression.ts";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2000;

test("high-resolution phone photos are compressed even when their encoded size is under the byte limit", () => {
  assert.equal(shouldCompressImageForAttachment({
    size: 2.3 * 1024 * 1024,
    width: 3072,
    height: 4080,
    maxBytes: MAX_IMAGE_BYTES,
    maxDimension: MAX_IMAGE_DIMENSION,
  }), true);
});

test("images within both the byte and dimension limits retain their original encoding", () => {
  assert.equal(shouldCompressImageForAttachment({
    size: 2 * 1024 * 1024,
    width: 1600,
    height: 1200,
    maxBytes: MAX_IMAGE_BYTES,
    maxDimension: MAX_IMAGE_DIMENSION,
  }), false);
  assert.equal(shouldCompressImageForAttachment({
    size: MAX_IMAGE_BYTES,
    width: MAX_IMAGE_DIMENSION,
    height: MAX_IMAGE_DIMENSION,
    maxBytes: MAX_IMAGE_BYTES,
    maxDimension: MAX_IMAGE_DIMENSION,
  }), false);
});

test("encoded size still triggers compression independently of dimensions", () => {
  assert.equal(shouldCompressImageForAttachment({
    size: MAX_IMAGE_BYTES + 1,
    width: 1600,
    height: 1200,
    maxBytes: MAX_IMAGE_BYTES,
    maxDimension: MAX_IMAGE_DIMENSION,
  }), true);
});
