'use strict';
/**
 * Prototype: derive the annotation vocabulary from `extend google.protobuf.*Options`
 * blocks. No hardcoded names, no registry — everything comes from the .proto source.
 */
const fs = require('node:fs'), path = require('node:path');

const RE_PACKAGE = /^\s*package\s+([A-Za-z0-9_.]+)\s*;/m;
const RE_EXTEND  = /^\s*extend\s+google\.protobuf\.(\w+)Options\s*\{/;
const RE_XFIELD  = /^\s*(?:(optional|repeated)\s+)?([A-Za-z_][\w.]*)\s+([a-z_]\w*)\s*=\s*(\d+)\s*;/;
const RE_MESSAGE = /^\s*message\s+([A-Za-z_]\w*)\s*\{/;

/** Leading `//` comment block immediately above `idx`, godoc-style. */
function leadingComment(lines, idx) {
  const out = [];
  for (let i = idx - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === '') { if (out.length) break; continue; }
    if (!t.startsWith('//')) break;
    out.unshift(t.replace(/^\/\/\s?/, ''));
  }
  return out;
}

/** Split a comment into prose and indented code samples (tab/4-space = code). */
function splitDoc(commentLines) {
  const prose = [], code = [];
  for (const l of commentLines) {
    if (/^(\t| {4})/.test(l)) code.push(l.replace(/^(\t| {4})/, ''));
    else prose.push(l);
  }
  return { prose: prose.join(' ').trim(), code: code.join('\n').trim() };
}

function parseFile(file, rel) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const pkg = (text.match(RE_PACKAGE) || [])[1] || '';
  const annotations = [], messages = new Map();

  for (let i = 0; i < lines.length; i++) {
    const ext = RE_EXTEND.exec(lines[i]);
    if (ext) {
      const target = ext[1];                       // Service | Method | Field | Enum | ...
      const blockDoc = splitDoc(leadingComment(lines, i));
      let depth = 1;
      for (let j = i + 1; j < lines.length && depth > 0; j++) {
        depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
        const f = RE_XFIELD.exec(lines[j]);
        if (!f) continue;
        const doc = splitDoc(leadingComment(lines, j));
        annotations.push({
          fqn: pkg ? `${pkg}.${f[3]}` : f[3],
          target, label: f[3], type: f[2], number: Number(f[4]),
          repeated: f[1] === 'repeated',
          doc: doc.prose || blockDoc.prose,
          example: doc.code || blockDoc.code,
          file: rel, line: j + 1,
        });
      }
      continue;
    }
    const msg = RE_MESSAGE.exec(lines[i]);
    if (msg) {
      const fields = [];
      let depth = 1;
      for (let j = i + 1; j < lines.length && depth > 0; j++) {
        depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
        if (depth < 1) break;
        const f = RE_XFIELD.exec(lines[j]);
        if (f) fields.push({ name: f[3], type: f[2], number: Number(f[4]),
                             repeated: f[1] === 'repeated', doc: splitDoc(leadingComment(lines, j)).prose });
      }
      messages.set(pkg ? `${pkg}.${msg[1]}` : msg[1], { fields, file: rel, line: i + 1 });
    }
  }
  return { pkg, annotations, messages };
}

function walk(d, o = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, o); else if (e.name.endsWith('.proto')) o.push(p);
  }
  return o;
}

function indexRoots(roots) {
  const annotations = [], messages = new Map();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const f of walk(root)) {
      const r = parseFile(f, path.relative(root, f));
      annotations.push(...r.annotations);
      for (const [k, v] of r.messages) if (!messages.has(k)) messages.set(k, v);
    }
  }
  return { annotations, messages };
}

module.exports = { indexRoots, parseFile };

if (require.main === module) {
  const B = path.join(process.env.HOME, '.cache/buf/v3/modules/b5/buf.build');
  const roots = [];
  for (const org of ['the-protobuf-project', 'googleapis', 'bufbuild']) {
    const o = path.join(B, org);
    if (!fs.existsSync(o)) continue;
    for (const m of fs.readdirSync(o))
      for (const c of fs.readdirSync(path.join(o, m)))
        roots.push(path.join(o, m, c, 'files'));
  }
  const t = Date.now();
  const { annotations, messages } = indexRoots(roots);
  const ms = Date.now() - t;

  const byPkg = new Map();
  for (const a of annotations) {
    const ns = a.fqn.split('.').slice(0, -1).join('.');
    if (!byPkg.has(ns)) byPkg.set(ns, []);
    byPkg.get(ns).push(a);
  }
  console.log(`indexed ${roots.length} dep roots in ${ms}ms`);
  console.log(`discovered ${annotations.length} annotations across ${byPkg.size} namespaces`);
  console.log(`resolved ${messages.size} option-body messages\n`);
  console.log('namespace'.padEnd(26) + 'count  targets');
  console.log('-'.repeat(72));
  for (const [ns, list] of [...byPkg].sort()) {
    const targets = [...new Set(list.map(a => a.target))].sort().join(', ');
    console.log(ns.padEnd(26) + String(list.length).padStart(4) + '   ' + targets);
  }
}
