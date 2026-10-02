/* Builds dist/satisfunction-offline.html: the whole app in one file, to
 * download and open by double-clicking. No server, no internet needed (the
 * font falls back to the system's when offline).
 *
 *   node tools/build-offline.mjs
 *
 * Browsers won't load ES modules from a file opened off disk, so the modules
 * in public/js are joined back into one script, in the order the browser
 * would run them. They share no top-level names, so nothing clashes. The
 * stylesheet, scripts and every icon go inside the file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(here, '..', 'public');
const OUT = path.join(here, '..', 'dist', 'satisfunction-offline.html');

const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
// Script text inside <script>: a closing tag in it would end the element early.
const safe = (js) => js.replace(/<\/(script)/gi, '<\\/$1');
const dataUri = (f, type) => 'data:' + type + ';base64,' + fs.readFileSync(path.join(PUB, f)).toString('base64');

// The modules, in evaluation order: each module's imports first, depth first,
// starting from main.js (as the browser does).
const IMPORT = /^import\s*\{[^}]*\}\s*from\s*'\.\/([a-z]+\.js)';\s*$/gm;
const order = [];
const seen = new Set();
(function visit(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = read('js/' + file);
  for (const m of src.matchAll(IMPORT)) visit(m[1]);
  order.push(file);
})('main.js');

const names = new Map();
const modules = order.map((file) => {
  let src = read('js/' + file);
  // Top-level names must be unique across modules once they share a scope.
  for (const m of src.matchAll(/^(?:var|function)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (names.has(m[1])) throw new Error(m[1] + ' is declared in both ' + names.get(m[1]) + ' and ' + file);
    names.set(m[1], file);
  }
  const before = src;
  src = src.replace(IMPORT, '').replace(/^export\s*\{[^}]*\};\s*$/gm, '');
  if (/^\s*(import|export)\b/m.test(src)) throw new Error(file + ': an import or export this build doesn\'t understand');
  if (src === before && file !== 'main.js') console.warn(file + ': no imports or exports?');
  return '// ---- ' + file + '\n' + src.trim() + '\n';
});
const app = "(function () {\n'use strict';\n" + modules.join('\n') + '})();\n';

// Every icon, by the id iconOf asks for.
const icons = {};
for (const f of fs.readdirSync(path.join(PUB, 'icons')).sort()) {
  if (f.endsWith('.png')) icons[f.slice(0, -4)] = dataUri('icons/' + f, 'image/png');
}

let html = read('index.html');
const swap = (pattern, replacement) => {
  if (!pattern.test(html)) throw new Error('index.html no longer has ' + pattern);
  html = html.replace(pattern, () => replacement);
};
swap(/<link rel="stylesheet" href="styles\.css[^"]*">/, '<style>\n' + read('styles.css') + '\n</style>');
swap(/href="favicon\.svg[^"]*"/, 'href="' + dataUri('favicon.svg', 'image/svg+xml') + '"');
swap(/href="favicon-32\.png[^"]*"/, 'href="' + dataUri('favicon-32.png', 'image/png') + '"');
swap(/src="favicon\.svg[^"]*"/, 'src="' + dataUri('favicon.svg', 'image/svg+xml') + '"');
for (const f of ['data.js', 'solver.js', 'lp.js', 'optimise.js', 'examples.js']) {
  swap(new RegExp('<script src="' + f.replace('.', '\\.') + '[^"]*"></script>'), '<script>\n' + safe(read(f)) + '\n</script>');
}
swap(/<script type="module" src="js\/main\.js[^"]*"><\/script>/,
  '<script>window.SF_ICONS = ' + JSON.stringify(icons) + ';</script>\n<script>\n' + safe(app) + '</script>');
if (/(src|href)="(?!data:|https?:|#)[^"]+\.(js|css|png|svg)/.test(html)) throw new Error('index.html still points at a local file');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log('Wrote ' + path.relative(process.cwd(), OUT) + ' (' + (html.length / 1048576).toFixed(1) + ' MB, ' +
  order.length + ' modules, ' + Object.keys(icons).length + ' icons)');
