const MINUTE_MS = 60_000;

interface CronField {
  any: boolean;
  values: Set<number>;
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const FIELD_LIMITS: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

export function validateCronExpression(expr: string): void {
  parseCron(expr);
}

export function nextCronOccurrence(expr: string, afterMs: number = Date.now()): number | null {
  const parsed = parseCron(expr);
  let cursor = startOfNextMinute(afterMs);
  // Search up to two years. This keeps invalid impossible expressions bounded.
  const max = cursor + 366 * 2 * 24 * 60 * MINUTE_MS;
  while (cursor <= max) {
    if (matches(parsed, new Date(cursor))) return cursor;
    cursor += MINUTE_MS;
  }
  return null;
}

export function previousCronOccurrence(expr: string, beforeMs: number = Date.now()): number | null {
  const parsed = parseCron(expr);
  let cursor = startOfPreviousMinute(beforeMs);
  const min = cursor - 366 * 2 * 24 * 60 * MINUTE_MS;
  while (cursor >= min) {
    if (matches(parsed, new Date(cursor))) return cursor;
    cursor -= MINUTE_MS;
  }
  return null;
}

function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("cron_expr must have exactly 5 fields: minute hour day month day-of-week");
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((part, idx) =>
    parseField(part, FIELD_LIMITS[idx][0], FIELD_LIMITS[idx][1], idx === 4),
  );
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function parseField(part: string, min: number, max: number, dayOfWeek: boolean): CronField {
  const values = new Set<number>();
  const tokens = part.split(",");
  if (tokens.length === 0) throw new Error(`invalid cron field: ${part}`);

  for (const token of tokens) {
    if (!token) throw new Error(`invalid cron field: ${part}`);
    const [rangePart, stepPart] = token.split("/");
    if (token.split("/").length > 2) throw new Error(`invalid cron field: ${part}`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step: ${token}`);

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [rawStart, rawEnd] = rangePart.split("-");
      start = parseCronNumber(rawStart, min, max, dayOfWeek);
      end = parseCronNumber(rawEnd, min, max, dayOfWeek);
      if (start > end) throw new Error(`invalid cron range: ${token}`);
    } else {
      start = parseCronNumber(rangePart, min, max, dayOfWeek);
      end = start;
    }

    for (let value = start; value <= end; value += step) {
      values.add(dayOfWeek && value === 7 ? 0 : value);
    }
  }

  const normalizedMax = dayOfWeek && max === 7 ? 6 : max;
  const fullCount = normalizedMax - min + 1;
  return { any: values.size >= fullCount, values };
}

function parseCronNumber(raw: string, min: number, max: number, dayOfWeek: boolean): number {
  if (!/^\d+$/.test(raw)) throw new Error(`invalid cron value: ${raw}`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`cron value ${raw} outside ${min}-${max}`);
  }
  return dayOfWeek && value === 7 ? 0 : value;
}

function matches(parsed: ParsedCron, date: Date): boolean {
  if (!fieldMatches(parsed.minute, date.getMinutes())) return false;
  if (!fieldMatches(parsed.hour, date.getHours())) return false;
  if (!fieldMatches(parsed.month, date.getMonth() + 1)) return false;

  const domMatches = fieldMatches(parsed.dayOfMonth, date.getDate());
  const dowMatches = fieldMatches(parsed.dayOfWeek, date.getDay());
  if (!parsed.dayOfMonth.any && !parsed.dayOfWeek.any) {
    // Vixie cron semantics: when both are restricted, either can match.
    return domMatches || dowMatches;
  }
  return domMatches && dowMatches;
}

function fieldMatches(field: CronField, value: number): boolean {
  return field.any || field.values.has(value);
}

function startOfNextMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
}

function startOfPreviousMinute(ms: number): number {
  return Math.floor((ms - 1) / MINUTE_MS) * MINUTE_MS;
}
