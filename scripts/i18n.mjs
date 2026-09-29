#!/usr/bin/env node
/**
 * 界面多语言的维护工具。源文本是中文，词典在 public/shared/i18n/<语言>.js（见那里的 i18n.js）。
 *
 *   node scripts/i18n.mjs check              每个 t('…') 的键在每种语言的词典里都有译文，占位符一致（测试里用）
 *   node scripts/i18n.mjs todo [路径…]        列出还没包进 t() 的中文字符串（注释、console 不算）
 *   node scripts/i18n.mjs merge <片段.json…>  把 { 中文: { en, ja, ko, es, fr } } 并进词典
 *   node scripts/i18n.mjs unused             词典里有、代码里已经不用的键
 *   node scripts/i18n.mjs verify <片段.json> <路径…>   这些文件里的键在片段或词典里都有 5 种译文
 *
 * 不是写在 t('…') 里的键（如函数文档的那张大表）由模块自己 export const I18N_KEYS 列出来。
 * 文件里 t 已经被当成局部变量用的，导入时改名：import { t as tt }，扫描同样认 tt('…')。
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DICT_DIR = join(ROOT, 'public', 'shared', 'i18n');
export const TARGETS = ['en', 'ja', 'ko', 'es', 'fr'];
const SCAN = ['public/js', 'public/shared', 'worker'];
const HAN = /[㐀-鿿]/;

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'vendor' && name !== 'i18n') out.push(...walk(p)); }
    else if (/\.(m?js)$/.test(name) && !/\.test\.m?js$/.test(name) && !name.startsWith('_') && name !== 'login-i18n.js') out.push(p);   // login-i18n.js 是生成的词典
  }
  return out;
}

/**
 * 极简词法扫描：找出所有字符串字面量（跳过注释和正则），并记下它前面紧挨着的是不是 t( / tr(。
 * 模板字符串里有 ${} 的算「动态」，不能当键。
 * @param {string} src
 * @returns {{ value: string, raw: string, line: number, inT: boolean, dynamic: boolean, console: boolean }[]}
 */
export function literals(src) {
  const out = [];
  let i = 0, line = 1, prev = '';   // prev：上一个有意义的记号，用来区分除号和正则
  const lineOf = () => line;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
      i = stop; continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const start = i, l0 = lineOf();
      let dynamic = false, depth = 0;
      i++;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\') { if (src[i + 1] === '\n') line++; i += 2; continue; }
        if (c === '\n') line++;
        if (ch === '`' && c === '$' && src[i + 1] === '{') { dynamic = true; depth = 1; i += 2; while (i < src.length && depth) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; else if (src[i] === '\n') line++; i++; } continue; }
        if (c === ch) { i++; break; }
        i++;
      }
      const raw = src.slice(start, i);
      const before = src.slice(Math.max(0, start - 40), start);
      const inT = /(?:^|[^\w.$])(?:tt|tr|t)\(\s*$/.test(before);   // 文件里 t 已被当局部变量用的，导入成 tt
      const cons = /console\.\w+\([^)]*$/.test(src.slice(Math.max(0, start - 120), start));
      let value = raw;
      if (!dynamic) { try { value = /** @type {string} */ (new Function('return ' + raw)()); } catch { value = raw.slice(1, -1); } }
      out.push({ value, raw, line: l0, inT, dynamic, console: cons });
      prev = 'x';
      continue;
    }
    if (ch === '/' && !/[\w)\]$]/.test(prev)) {
      // 正则字面量
      i++;
      let cls = false;
      while (i < src.length && src[i] !== '\n') {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '[') cls = true; else if (c === ']') cls = false;
        else if (c === '/' && !cls) { i++; break; }
        i++;
      }
      while (/[a-z]/i.test(src[i] ?? '')) i++;
      prev = 'x';
      continue;
    }
    // 标识符 / 关键字：return、typeof 之后的 / 是正则
    if (/[\w$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      prev = /^(return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/.test(word) ? '(' : 'x';
      i = j; continue;
    }
    prev = ch;
    i++;
  }
  return out;
}

const files = () => SCAN.flatMap((d) => walk(join(ROOT, d)));
const rel = (/** @type {string} */ p) => relative(ROOT, p).split(sep).join('/');

/** 代码里用到的全部键（t('…') 里的静态字符串 + HTML 的 data-i18n） */
export async function usedKeys(/** @type {string[] | undefined} */ only = undefined) {
  /** @type {Map<string, string>} */ const keys = new Map();
  for (const f of only ?? files()) {
    const src = readFileSync(f, 'utf8');
    if (/export const I18N_KEYS\b/.test(src)) {
      const mod = await import('file:///' + f.split(sep).join('/'));
      for (const k of mod.I18N_KEYS) if (HAN.test(k)) keys.set(k, rel(f));
    }
    for (const lit of literals(src)) {
      if (lit.inT && !lit.dynamic && HAN.test(lit.value)) keys.set(lit.value, rel(f) + ':' + lit.line);
    }
  }
  // 只检查部分文件（verify）时不管 HTML
  for (const name of only ? [] : readdirSync(join(ROOT, 'public')).filter((n) => n.endsWith('.html'))) {
    const html = readFileSync(join(ROOT, 'public', name), 'utf8');
    const title = /<title>([^<]*)<\/title>/.exec(html);
    if (title && HAN.test(title[1])) keys.set(title[1].trim(), 'public/' + name);
    for (const m of html.matchAll(/<(\w+)[^>]*\sdata-i18n(-html)?(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) keys.set(m[3].trim(), 'public/' + name);
    for (const m of html.matchAll(/<[^>]*\sdata-i18n-attr="([^"]+)"[^>]*>/g)) {
      for (const a of m[1].split(/\s+/)) {
        const v = new RegExp('\\s' + a + '="([^"]*)"').exec(m[0]);
        if (v && HAN.test(v[1])) keys.set(v[1], 'public/' + name);
      }
    }
  }
  return keys;
}

/** @param {string} id @returns {Record<string, string>} */
export function readDict(id) {
  const f = join(DICT_DIR, id + '.js');
  if (!existsSync(f)) return {};
  const src = readFileSync(f, 'utf8');
  const body = src.slice(src.indexOf('export default') + 'export default'.length).trim().replace(/;\s*$/, '');
  return JSON.parse(body);
}

/** @param {string} id @param {Record<string, string>} dict */
function writeDict(id, dict) {
  const head = '// 界面文字译文（' + id + '）。键是中文原文。由 node scripts/i18n.mjs merge 维护，也可以直接改。\n';
  writeFileSync(join(DICT_DIR, id + '.js'), head + 'export default ' + JSON.stringify(dict, null, 1) + ';\n');
}

const holes = (/** @type {string} */ s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

/** 检查结果：每种语言缺哪些键、哪些占位符对不上 */
export async function check(dicts = null, only = undefined) {
  const keys = await usedKeys(only);
  const problems = [];
  for (const id of TARGETS) {
    const d = /** @type {any} */ (dicts)?.[id] ?? readDict(id);
    for (const [k, where] of keys) {
      if (!Object.prototype.hasOwnProperty.call(d, k)) problems.push(`${id} 缺译文：${JSON.stringify(k).slice(0, 80)}（${where}）`);
      else if (holes(d[k]) !== holes(k)) problems.push(`${id} 占位符不一致：${JSON.stringify(k).slice(0, 60)} → ${JSON.stringify(d[k]).slice(0, 60)}`);
    }
  }
  const want = only ? null : await loginDict();
  if (want && readFileSync(LOGIN_OUT, 'utf8') !== want) problems.push('public/js/login-i18n.js 过期了，运行 node scripts/i18n.mjs login');
  return { keys: keys.size, problems };
}

/** 登录页（未登录就能拿到）只带它自己用到的那几十条译文 */
const LOGIN_OUT = join(ROOT, 'public', 'js', 'login-i18n.js');
const LOGIN_SRC = ['public/js/login.js', 'public/js/core/lang.js', 'public/shared/util/kdf.js', 'public/shared/util/qr.js', 'public/shared/util/b64.js'];

export async function loginDict() {
  const keys = new Set((await usedKeys(LOGIN_SRC.map((p) => join(ROOT, p)))).keys());
  const html = readFileSync(join(ROOT, 'public', 'login.html'), 'utf8');
  const title = /<title>([^<]*)<\/title>/.exec(html);
  if (title) keys.add(title[1].trim());
  for (const m of html.matchAll(/<(\w+)[^>]*\sdata-i18n(-html)?(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) keys.add(m[3].trim());
  for (const m of html.matchAll(/<[^>]*\sdata-i18n-attr="([^"]+)"[^>]*>/g)) {
    for (const a of m[1].split(/\s+/)) {
      const v = new RegExp('\\s' + a + '="([^"]*)"').exec(m[0]);
      if (v) keys.add(v[1]);
    }
  }
  const sorted = [...keys].filter((k) => HAN.test(k)).sort();
  /** @type {Record<string, Record<string, string>>} */ const out = {};
  for (const id of TARGETS) {
    const d = readDict(id);
    out[id] = {};
    for (const k of sorted) if (Object.prototype.hasOwnProperty.call(d, k)) out[id][k] = d[k];
  }
  return '// 登录页用到的那一小部分译文（未登录也要能拿到，所以不直接给整本词典）。\n'
    + '// 由 node scripts/i18n.mjs login 从 public/shared/i18n/*.js 生成，不要手改。\n'
    + 'export default ' + JSON.stringify(out, null, 1) + ';\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'check') {
    const { keys, problems } = await check();
    for (const p of problems.slice(0, 50)) console.error('  ' + p);
    if (problems.length) { console.error(`\n${problems.length} 处问题（共 ${keys} 个键）`); process.exit(1); }
    console.log(`多语言词典完整：${keys} 个键 × ${TARGETS.length} 种语言`);
  } else if (cmd === 'todo') {
    const targets = args.length ? args.flatMap((a) => { const p = join(ROOT, a); return statSync(p).isDirectory() ? walk(p) : [p]; }) : files();
    let n = 0;
    for (const f of targets) {
      for (const lit of literals(readFileSync(f, 'utf8'))) {
        if (lit.inT || lit.console || !HAN.test(lit.value)) continue;
        n++;
        console.log(`${rel(f)}:${lit.line}  ${lit.raw.slice(0, 100).replace(/\n/g, '⏎')}`);
      }
    }
    console.log(`\n${n} 处未包进 t() 的中文`);
  } else if (cmd === 'merge') {
    const dicts = Object.fromEntries(TARGETS.map((id) => [id, readDict(id)]));
    let added = 0;
    for (const f of args) {
      const frag = JSON.parse(readFileSync(f, 'utf8'));
      for (const [zh, tr] of Object.entries(frag)) {
        for (const id of TARGETS) {
          if (typeof tr?.[id] !== 'string') { console.error(`${f}：${zh.slice(0, 40)} 缺 ${id}`); continue; }
          if (!(zh in dicts[id])) added++;
          dicts[id][zh] = tr[id];
        }
      }
    }
    for (const id of TARGETS) writeDict(id, dicts[id]);
    console.log(`并入 ${added} 条译文`);
  } else if (cmd === 'verify') {
    const [frag, ...paths] = args;
    const extra = JSON.parse(readFileSync(frag, 'utf8'));
    const dicts = Object.fromEntries(TARGETS.map((id) => {
      const d = readDict(id);
      for (const [zh, tr] of Object.entries(extra)) if (typeof tr?.[id] === 'string') d[zh] = tr[id];
      return [id, d];
    }));
    const only = paths.flatMap((a) => { const p = join(ROOT, a); return statSync(p).isDirectory() ? walk(p) : [p]; });
    const { keys, problems } = await check(dicts, only);
    for (const p of problems.slice(0, 80)) console.error('  ' + p);
    console.log(problems.length ? problems.length + ' 处问题' : 'OK：' + keys + ' 个键都有 5 种译文');
    if (problems.length) process.exit(1);
  } else if (cmd === 'login') {
    writeFileSync(LOGIN_OUT, await loginDict());
    console.log('已生成 public/js/login-i18n.js');
  } else if (cmd === 'unused') {
    const keys = await usedKeys();
    for (const k of Object.keys(readDict('en'))) if (!keys.has(k)) console.log(JSON.stringify(k).slice(0, 100));
  } else {
    console.log('用法见文件开头');
  }
}
