const fs = require('node:fs');
const path = require('node:path');

const ROOT = '/Users/srikanthkandarp/Projects/personal/protobuf-fhir/protobuf';
const mb = b => (b / 1024 / 1024).toFixed(1);
const rss = () => process.memoryUsage().rss;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.proto')) out.push(p);
  }
  return out;
}

const base = rss();
let t = Date.now();
const files = walk(ROOT);
console.log(`walk: ${files.length} files in ${Date.now() - t}ms, rss +${mb(rss() - base)} MB`);

// Simulate the extension's regex parse, but from fs + discard text (streaming index build)
const RE_MESSAGE = /^\s*(message|extend)\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\{?/;
const RE_SERVICE = /^\s*service\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\{?/;
const RE_ENUM = /^\s*enum\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\{?/;
const RE_RPC = /^\s*rpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

t = Date.now();
let symbolCount = 0, bytes = 0;
// index: name -> [fileIdx, line] packed, text NEVER retained
const index = [];
for (let fi = 0; fi < files.length; fi++) {
  const text = fs.readFileSync(files[fi], 'utf8');
  bytes += text.length;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = RE_MESSAGE.exec(l) || RE_SERVICE.exec(l) || RE_ENUM.exec(l) || RE_RPC.exec(l);
    if (m) { index.push(fi, i, 0); symbolCount++; }
  }
}
const afterParse = rss();
console.log(`read+parse: ${mb(bytes)} MB of text, ${symbolCount} symbols in ${Date.now() - t}ms`);
console.log(`rss after full index build: ${mb(afterParse)} MB total, +${mb(afterParse - base)} MB over baseline`);
console.log(`index entries: ${index.length / 3}`);
