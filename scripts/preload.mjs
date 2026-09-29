#!/usr/bin/env node
/**
 * 生成 index.html 里的 <link rel="modulepreload"> 列表。
 *
 * 零构建意味着浏览器要顺着 import 一层层发现模块：main.js → grid.js → calc.js → …
 * 每一层都要等上一层下载完才知道下一层是谁，跨境链路上 5 层就是好几秒。
 * 把整棵静态 import 树预先列在 HTML 里，浏览器第一轮就能并行全部拉下来。
 *
 *   node scripts/preload.mjs          改写 public/index.html
 *   node scripts/preload.mjs --check  只检查是否过期（测试里用）
 *
 * 只收静态 import；动态 import()（看板、XLSX、附件等）本来就是按需加载的。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
const INDEX = join(PUB, 'index.html');
const START = '<!-- modulepreload:start -->';
const END = '<!-- modulepreload:end -->';

/** 顶层静态 import / export … from 的说明符。 @param {string} src */
function staticImports(src) {
  const out = [];
  const re = /^\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

/** 从入口出发收集整棵静态依赖树（不含入口本身），按发现顺序。 @param {string} entry */
export function moduleGraph(entry) {
  const seen = new Set();
  const order = [];
  const walk = (file) => {
    for (const spec of staticImports(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
      const dep = spec.startsWith('/') ? join(PUB, spec) : resolve(dirname(file), spec);
      if (seen.has(dep)) continue;
      seen.add(dep);
      order.push(dep);
      walk(dep);
    }
  };
  walk(entry);
  return order.map((f) => '/' + relative(PUB, f).split(sep).join('/'));
}

/** 当前应有的 index.html 全文。 */
export function expectedIndex() {
  const html = readFileSync(INDEX, 'utf8');
  const a = html.indexOf(START), b = html.indexOf(END);
  if (a < 0 || b < a) throw new Error('index.html 里找不到 ' + START + ' … ' + END);
  const indent = html.slice(html.lastIndexOf('\n', a) + 1, a);
  // 入口是 boot.js（先加载语言词典），它再动态 import main.js：两棵树连同 main.js 本身都要列上
  const paths = [...new Set([...moduleGraph(join(PUB, 'js', 'boot.js')), '/js/main.js', ...moduleGraph(join(PUB, 'js', 'main.js'))])];
  const links = paths.map((p) => indent + '<link rel="modulepreload" href="' + p + '">');
  return { html, next: html.slice(0, a) + START + '\n' + links.join('\n') + '\n' + indent + html.slice(b) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { html, next } = expectedIndex();
  if (process.argv.includes('--check')) {
    if (html !== next) { console.error('index.html 的 modulepreload 列表过期了，运行 node scripts/preload.mjs'); process.exit(1); }
    console.log('modulepreload 列表是最新的');
  } else {
    writeFileSync(INDEX, next);
    console.log(html === next ? '无变化' : '已更新 public/index.html');
  }
}
