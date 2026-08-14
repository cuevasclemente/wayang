import { Buffer } from "node:buffer";

export const MAX_INTENT_BYTES = 16 * 1024;
export const INTENT_SCHEMA = "wayang-maintenance-run/v1";
// M1 initializes and tests SHA-1 object databases only. SHA-256 support must
// be added with dedicated fixtures before 64-character IDs are accepted.
const OID = /^[0-9a-f]{40}$/;
const RUN_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaError";
  }
}

// JSON.parse silently accepts duplicate object keys. This small parser rejects them,
// excessive nesting, trailing data, and non-JSON numbers before schema validation.
export function parseStrictJson(input, { maxBytes = MAX_INTENT_BYTES, maxDepth = 12 } = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  if (bytes.length === 0) throw new SchemaError("JSON input is empty");
  if (bytes.length > maxBytes) throw new SchemaError(`JSON input exceeds ${maxBytes} bytes`);
  const text = bytes.toString("utf8");
  if (Buffer.byteLength(text, "utf8") !== bytes.length || text.includes("\uFFFD")) {
    throw new SchemaError("JSON input is not valid UTF-8");
  }

  let offset = 0;
  const fail = (message) => { throw new SchemaError(`${message} at byte ${offset}`); };
  const whitespace = () => { while (/[\t\n\r ]/.test(text[offset] || "")) offset += 1; };

  function string() {
    const start = offset;
    if (text[offset++] !== '"') fail("expected string");
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '"') {
        try { return JSON.parse(text.slice(start, offset)); }
        catch { fail("invalid string escape"); }
      }
      if (character === "\\") {
        if (offset >= text.length) fail("unterminated string escape");
        const escape = text[offset++];
        if (escape === "u") {
          const hex = text.slice(offset, offset + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid Unicode escape");
          offset += 4;
        } else if (!'"\\/bfnrt'.includes(escape)) fail("invalid string escape");
      } else if (character.charCodeAt(0) < 0x20) fail("unescaped control character");
    }
    fail("unterminated string");
  }

  function value(depth) {
    if (depth > maxDepth) fail(`JSON nesting exceeds ${maxDepth}`);
    whitespace();
    const character = text[offset];
    if (character === '"') return string();
    if (character === "{") {
      offset += 1;
      const result = Object.create(null);
      const keys = new Set();
      whitespace();
      if (text[offset] === "}") { offset += 1; return result; }
      while (true) {
        whitespace();
        if (text[offset] !== '"') fail("expected object key");
        const key = string();
        if (keys.has(key)) throw new SchemaError(`duplicate object key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (text[offset++] !== ":") fail("expected colon");
        result[key] = value(depth + 1);
        whitespace();
        if (text[offset] === "}") { offset += 1; return result; }
        if (text[offset++] !== ",") fail("expected comma or closing brace");
      }
    }
    if (character === "[") {
      offset += 1;
      const result = [];
      whitespace();
      if (text[offset] === "]") { offset += 1; return result; }
      while (true) {
        result.push(value(depth + 1));
        whitespace();
        if (text[offset] === "]") { offset += 1; return result; }
        if (text[offset++] !== ",") fail("expected comma or closing bracket");
      }
    }
    for (const [literal, result] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return result; }
    }
    const match = text.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (match) {
      offset += match[0].length;
      const result = Number(match[0]);
      if (!Number.isFinite(result)) fail("number is not finite");
      return result;
    }
    fail("unexpected token");
  }

  const result = value(0);
  whitespace();
  if (offset !== text.length) fail("trailing data");
  return result;
}

function object(value, path, allowed, required = allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SchemaError(`${path} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new SchemaError(`${path} contains unknown field ${JSON.stringify(key)}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new SchemaError(`${path} is missing field ${JSON.stringify(key)}`);
  }
}

function exactString(value, expected, path) {
  if (value !== expected) throw new SchemaError(`${path} must be ${JSON.stringify(expected)}`);
}

export function validateIntent(value) {
  object(value, "intent", ["schema", "runId", "operation", "repository", "expected"]);
  exactString(value.schema, INTENT_SCHEMA, "intent.schema");
  if (typeof value.runId !== "string" || !RUN_ID.test(value.runId)) {
    throw new SchemaError("intent.runId must be 1-64 lowercase safe characters");
  }
  exactString(value.operation, "prepare", "intent.operation");
  exactString(value.repository, "pi", "intent.repository");
  object(value.expected, "intent.expected", ["upstream", "downstream"]);
  for (const name of ["upstream", "downstream"]) {
    if (typeof value.expected[name] !== "string" || !OID.test(value.expected[name])) {
      throw new SchemaError(`intent.expected.${name} must be a lowercase 40-character SHA-1 Git object ID`);
    }
  }
  return Object.freeze({
    schema: value.schema,
    runId: value.runId,
    operation: value.operation,
    repository: value.repository,
    expected: Object.freeze({ ...value.expected }),
  });
}

export function parseIntent(input) {
  return validateIntent(parseStrictJson(input));
}

export function isFullOid(value) {
  return typeof value === "string" && OID.test(value);
}
