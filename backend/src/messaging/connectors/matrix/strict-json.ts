function syntax(): never {
  throw new Error("Invalid strict JSON");
}

/** JSON.parse plus bounded nesting and duplicate-object-key rejection. */
export function parseStrictJson(text: string, maxDepth = 64): unknown {
  let offset = 0;

  function whitespace(): void {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[offset]!)) offset++;
  }

  function string(): string {
    if (text[offset] !== '"') syntax();
    const start = offset++;
    let escaped = false;
    while (offset < text.length) {
      const character = text[offset++]!;
      if (!escaped && character === '"') {
        try {
          return JSON.parse(text.slice(start, offset)) as string;
        } catch {
          syntax();
        }
      }
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
    }
    syntax();
  }

  function value(depth: number): void {
    if (depth > maxDepth) syntax();
    whitespace();
    const character = text[offset];
    if (character === '"') {
      string();
      return;
    }
    if (character === "{") {
      offset++;
      whitespace();
      const keys = new Set<string>();
      if (text[offset] === "}") {
        offset++;
        return;
      }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) syntax();
        keys.add(key);
        whitespace();
        if (text[offset++] !== ":") syntax();
        value(depth + 1);
        whitespace();
        const delimiter = text[offset++];
        if (delimiter === "}") return;
        if (delimiter !== ",") syntax();
      }
    }
    if (character === "[") {
      offset++;
      whitespace();
      if (text[offset] === "]") {
        offset++;
        return;
      }
      while (true) {
        value(depth + 1);
        whitespace();
        const delimiter = text[offset++];
        if (delimiter === "]") return;
        if (delimiter !== ",") syntax();
      }
    }
    const rest = text.slice(offset);
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(rest)?.[0];
    if (!token) syntax();
    offset += token.length;
  }

  value(0);
  whitespace();
  if (offset !== text.length) syntax();
  return JSON.parse(text) as unknown;
}
