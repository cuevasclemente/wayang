import test from "node:test";
import assert from "node:assert/strict";
import { nextCronOccurrence, previousCronOccurrence, validateCronExpression } from "./cron.js";

test("cron validates five-field expressions", () => {
  assert.doesNotThrow(() => validateCronExpression("*/15 9-17 * * 1-5"));
  assert.throws(() => validateCronExpression("* * *"), /5 fields/);
  assert.throws(() => validateCronExpression("61 * * * *"), /outside/);
});

test("cron computes next and previous occurrences on minute boundaries", () => {
  const base = new Date(2026, 0, 1, 9, 7, 30).getTime();
  assert.equal(nextCronOccurrence("*/15 * * * *", base), new Date(2026, 0, 1, 9, 15, 0).getTime());
  assert.equal(previousCronOccurrence("*/15 * * * *", base), new Date(2026, 0, 1, 9, 0, 0).getTime());
});

test("cron uses Vixie OR semantics when day-of-month and day-of-week are both restricted", () => {
  const base = new Date(2026, 0, 1, 0, 0, 0).getTime();
  // Friday Jan 2 2026 matches day-of-week even though day-of-month is not 15.
  assert.equal(nextCronOccurrence("0 9 15 * 5", base), new Date(2026, 0, 2, 9, 0, 0).getTime());
});
