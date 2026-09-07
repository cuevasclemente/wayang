// Synthetic diagnosis only: no Wayang/Pi runtime modules or private state loaded.
// Usage: node <this-file> <absolute Wayang checkout with installed backend deps>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');

async function main() {
  const root = process.argv[2];
  if (!root || !path.isAbsolute(root)) throw new Error('Pass an absolute Wayang checkout path');
  const ts = require(path.join(root, 'backend/node_modules/typescript/lib/typescript.js'));
  const source = fs.readFileSync(path.join(root, 'backend/src/search/chunker.ts'), 'utf8');
  const js = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const nativeRequire = createRequire(__filename);
  const context = {
    exports: {}, Buffer,
    require(name) {
      if (name !== 'node:fs') throw new Error('Probe refuses runtime module: ' + name);
      return nativeRequire(name);
    },
  };
  vm.runInNewContext(js, context);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayang-synthetic-search-probe-'));
  console.log(JSON.stringify({ fixture_dir: dir, scope: 'synthetic isolated chunker only' }));
  for (const mb of [1, 4, 16]) {
    const file = path.join(dir, 'tool-line-' + mb + 'MiB.jsonl');
    fs.writeFileSync(file,
      JSON.stringify({ type: 'message', id: 'excluded-tool', message: {
        role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(mb * 1024 * 1024) }],
      } }) + '\n' + JSON.stringify({ type: 'message', id: 'user', message: {
        role: 'user', content: 'Synthetic searchable sentence.',
      } }) + '\n', { mode: 0o600 });
    const lag = monitorEventLoopDelay({ resolution: 5 });
    lag.enable();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const start = performance.now();
    const result = await context.exports.chunkJsonlFile(file, { title: 'Synthetic fixture', cwd: dir });
    const elapsed = performance.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 25));
    lag.disable();
    console.log(JSON.stringify({
      excluded_line_MiB: mb, elapsed_ms: Math.round(elapsed),
      event_loop_max_ms: Math.round(lag.max / 1e6), chunks: result.chunks.length,
      parse_errors: result.stats.skippedParseErrors,
    }));
  }
  // Fixtures are intentionally retained, not destructively cleaned up.
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
