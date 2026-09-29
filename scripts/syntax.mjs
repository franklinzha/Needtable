#!/usr/bin/env node
/**
 * 所有 .js / .mjs 过一遍 node --check。浏览器端很多模块没有单元测试会 import 到
 * （顶栏、主页、对话框……），语法错误只有线上打开页面才会发现 —— 这里提前拦住。
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.m?js$/.test(name)) files.push(p);
  }
})(join(ROOT, 'public'));
for (const d of ['worker', 'scripts']) {
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.m?js$/.test(name)) files.push(p);
    }
  })(join(ROOT, d));
}

let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { bad++; console.error('  FAIL ' + relative(ROOT, f) + '\n' + String(e.stderr ?? e.message)); }
}
console.log(bad ? `\n${bad} 个文件有语法错误` : `  ok   ${files.length} 个文件语法正确`);
process.exit(bad ? 1 : 0);
