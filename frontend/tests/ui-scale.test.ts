import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_UI_SCALE,
  MAX_UI_SCALE,
  MIN_UI_SCALE,
  clampUiScale,
  formatUiScalePercent,
  parseUiScale,
} from "../src/lib/uiScale.ts";

test("ui scale falls back to the default for missing or invalid values", () => {
  assert.equal(parseUiScale(null), DEFAULT_UI_SCALE);
  assert.equal(parseUiScale(undefined), DEFAULT_UI_SCALE);
  assert.equal(parseUiScale(""), DEFAULT_UI_SCALE);
  assert.equal(parseUiScale("   "), DEFAULT_UI_SCALE);
  assert.equal(parseUiScale("not-a-number"), DEFAULT_UI_SCALE);
  assert.equal(clampUiScale(Number.NaN), DEFAULT_UI_SCALE);
});

test("ui scale is clamped to the supported range and rounded", () => {
  assert.equal(clampUiScale(0.1), MIN_UI_SCALE);
  assert.equal(clampUiScale(0.05), MIN_UI_SCALE);
  assert.equal(clampUiScale(9), MAX_UI_SCALE);
  assert.equal(clampUiScale(1.234), 1.23);
  assert.equal(clampUiScale(1.125), 1.13);
  assert.equal(parseUiScale("5"), MAX_UI_SCALE);
});

test("ui scale percent formatting matches the applied root font size", () => {
  assert.equal(formatUiScalePercent(DEFAULT_UI_SCALE), "100%");
  assert.equal(formatUiScalePercent(1.15), "115%");
  assert.equal(formatUiScalePercent(MIN_UI_SCALE), "50%");
  assert.equal(formatUiScalePercent(MAX_UI_SCALE), "200%");
});
