import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSearchQuery, buildFtsExpression, SearchQueryError,
  MAX_QUERY_CHARS, MAX_QUERY_UNITS, MAX_UNIT_CHARS,
} from "./query-parser.js";

const fails = (query: string, code: SearchQueryError["code"]) => {
  assert.throws(() => parseSearchQuery(query), (error: unknown) =>
    error instanceof SearchQueryError && error.code === code && !error.message.includes(query));
};

test("words and quoted phrases are independent optional literal units without prefixes", () => {
  assert.equal(buildFtsExpression('alpha "beta gamma" delta'),
    'text : "alpha" OR text : "beta gamma" OR text : "delta"');
  assert.equal(buildFtsExpression('"alpha beta" "gamma delta"'),
    'text : "alpha beta" OR text : "gamma delta"');
  assert.equal(buildFtsExpression('OR AND NOT NEAR title:foo (bar) baz*'),
    'text : "or" OR text : "and" OR text : "not" OR text : "near" OR text : "title foo" OR text : "bar" OR text : "baz"');
});

test("NFC/case/whitespace and equivalent punctuation units deduplicate", () => {
  assert.equal(parseSearchQuery('CAFÉ cafe\u0301 "café"').units.length, 1);
  assert.equal(parseSearchQuery('alpha-beta "alpha  beta"').units.length, 1);
  assert.equal(parseSearchQuery('"東京 地図" 東京').units.length, 2);
  assert.equal(buildFtsExpression("  \t\n "), null);
});

test("distinct units use actual unicode61 token sequences, including accents and Unicode punctuation", () => {
  assert.deepEqual(parseSearchQuery("cafe café beta").units.map(unit => unit.text), ["cafe", "beta"]);
  assert.equal(parseSearchQuery('"alpha—beta" "alpha beta" "alpha、beta"').units.length, 1);
  assert.equal(parseSearchQuery('"café café" "cafe cafe"').units.length, 1);
  assert.equal(parseSearchQuery('"alpha beta" "beta alpha" "alpha alpha"').units.length, 3);
  assert.equal(parseSearchQuery('"cafe" "cafe cafe"').units.length, 2,
    "phrase repetition is significant even though duplicate whole units are not");
  assert.equal(parseSearchQuery("ł l").units.length, 2, "do not invent folds absent from unicode61");
});

test("malformed input never becomes a truncated or silently broadened query", () => {
  fails('"private canary', "unmatched_quote");
  fails('""', "empty_unit");
  fails('alpha "  "', "empty_unit");
  fails('alpha "beta"gamma', "invalid_query");
  fails('al"pha', "invalid_query");
  fails('***', "empty_unit");
  fails('alpha\u0000beta', "invalid_query");
});

test("query, supplied-unit and phrase/word ceilings reject instead of truncating", () => {
  fails("x".repeat(MAX_QUERY_CHARS + 1), "query_too_long");
  fails(Array(MAX_QUERY_UNITS + 1).fill("alpha").join(" "), "too_many_units");
  fails("x".repeat(MAX_UNIT_CHARS + 1), "unit_too_long");
  fails(`"${"x".repeat(MAX_UNIT_CHARS + 1)}"`, "unit_too_long");
  assert.equal(parseSearchQuery("x".repeat(MAX_UNIT_CHARS)).units.length, 1);
  assert.equal(parseSearchQuery(Array(MAX_QUERY_UNITS).fill("alpha").join(" ")).units.length, 1);
});
