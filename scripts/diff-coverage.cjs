const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const ts = require('typescript');
const base = process.argv[2] || process.env.DIFF_COVERAGE_BASE || 'HEAD';
const changed = new Map();
const diff = execFileSync('git', ['diff', '--no-ext-diff', '--unified=0', base, '--', 'src'], { encoding: 'utf8' });
let path, line;
for (const text of diff.split('\n')) {
  if (text.startsWith('+++ b/')) { path = text.slice(6); if (!changed.has(path)) changed.set(path, new Set()); }
  else if (text.startsWith('@@')) line = Number(text.match(/\+(\d+)/)[1]);
  else if (text.startsWith('+') && path) changed.get(path).add(line++);
  else if (text.startsWith(' ')) line++;
}
for (const path of execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'src'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)) {
  changed.set(path, new Set(readFileSync(path, 'utf8').split('\n').map((_, index) => index + 1)));
}
const coverage = JSON.parse(readFileSync('coverage/coverage-final.json', 'utf8'));
let executable = 0, covered = 0;
const missing = [];
for (const [path, lines] of changed) {
  const file = coverage[resolve(path)];
  if (!file) {
    const output = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.ESNext } }).outputText.trim();
    if (/^(export\s*\{\s*\}\s*;)?$/.test(output)) continue;
    console.error(`Missing coverage for changed source ${path}`); process.exitCode = 1; continue; }
  const hits = new Map();
  for (const [id, location] of Object.entries(file.statementMap)) {
    const line = location.start.line;
    hits.set(line, Math.max(hits.get(line) || 0, file.s[id]));
  }
  for (const line of lines) {
    if (!hits.has(line)) continue;
    executable++;
    if (hits.get(line) > 0) covered++; else missing.push(`${path}:${line}`);
  }
}
const percent = executable ? covered / executable * 100 : 100;
console.log(`Changed source coverage: ${covered}/${executable} lines (${percent.toFixed(2)}%), base ${base}`);
if (percent < 90) { console.error(missing.join('\n')); process.exitCode = 1; }
