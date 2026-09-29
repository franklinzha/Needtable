/**
 * 数字格式（Excel 的「设置单元格格式 → 数字」）。
 *
 * 支持 Excel 格式码的常用子集：
 *   常规 General；0  0.00  #,##0  0%  0.00E+00；货币前缀 ¥ $ "元"；
 *   分节 正;负;零;文本，节内 [Red] 等颜色；
 *   日期时间 yyyy yy m mm mmm mmmm d dd ddd dddd aaa aaaa h hh mm ss AM/PM；
 *   文本 @。
 * 不支持：条件节 [>100]、分数 # ?/?、[h] 累计时长 —— 在协作表格里几乎见不到。
 *
 * 返回 {text, color}：color 来自 [Red] 这类节颜色，渲染层拿去覆盖字体颜色。
 */

import { FErr, numToText, serialToDate, parseNumberText, tidy } from './values.js';
import { t as tt } from '../i18n/i18n.js';

/** 界面里「数字格式」下拉的预设。 */
export const PRESETS = [
  { id: 'General', label: tt('常规'), fmt: '' },
  { id: 'number', label: tt('数值'), fmt: '0.00' },
  { id: 'thousands', label: tt('千分位'), fmt: '#,##0.00' },
  { id: 'currency', label: tt('货币'), fmt: '¥#,##0.00' },
  { id: 'usd', label: tt('美元'), fmt: '$#,##0.00' },
  { id: 'percent', label: tt('百分比'), fmt: '0.00%' },
  { id: 'sci', label: tt('科学计数'), fmt: '0.00E+00' },
  { id: 'date', label: tt('短日期'), fmt: 'yyyy-mm-dd' },
  { id: 'dateCn', label: tt('长日期'), fmt: 'yyyy"年"m"月"d"日"' },
  { id: 'time', label: tt('时间'), fmt: 'hh:mm:ss' },
  { id: 'datetime', label: tt('日期时间'), fmt: 'yyyy-mm-dd hh:mm' },
  { id: 'text', label: tt('文本'), fmt: '@' },
];

const COLORS = {
  red: '#d93025', blue: '#1a73e8', green: '#188038', black: '#202124',
  white: '#ffffff', yellow: '#f9ab00', magenta: '#a142f4', cyan: '#12b5cb',
  '红色': '#d93025', '蓝色': '#1a73e8', '绿色': '#188038', '黑色': '#202124',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_CN = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * @typedef {{kind:'lit', v:string} | {kind:'date', v:string} | {kind:'num'} | {kind:'text'}} Tok
 * @typedef {{toks:Tok[], color:string|null, type:'num'|'date'|'text'|'lit',
 *            num?:{intMin:number, intLen:number, decMin:number, decMax:number, decQ:number,
 *                  comma:boolean, pct:number, exp:null|{sign:boolean, digits:number}, scale:number},
 *            ampm:boolean, hasSign:boolean}} Section
 */

/** @type {Map<string, Section[]>} */
const CACHE = new Map();

/** 按不在引号里的 ; 分节。 @param {string} fmt */
function splitSections(fmt) {
  /** @type {string[]} */ const out = [];
  let cur = '';
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '"') {
      const j = fmt.indexOf('"', i + 1);
      const end = j < 0 ? fmt.length : j;
      cur += fmt.slice(i, end + 1);
      i = end;
    } else if (ch === '\\' && i + 1 < fmt.length) { cur += ch + fmt[++i]; }
    else if (ch === ';') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const NUM_CH = new Set(['0', '#', '?', '.', ',']);

/** @param {string} src @returns {Section} */
function compileSection(src) {
  /** @type {Tok[]} */ const toks = [];
  let color = null;
  let numPattern = '';
  let numAt = -1;
  let hasDate = false;
  let hasText = false;
  let ampm = false;
  const lit = (/** @type {string} */ s) => {
    const last = toks[toks.length - 1];
    if (last && last.kind === 'lit') last.v += s; else toks.push({ kind: 'lit', v: s });
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const low = ch.toLowerCase();
    if (ch === '"') {
      const j = src.indexOf('"', i + 1);
      const end = j < 0 ? src.length : j;
      lit(src.slice(i + 1, end));
      i = end;
      continue;
    }
    if (ch === '\\') { if (i + 1 < src.length) lit(src[++i]); continue; }
    if (ch === '_') { i++; lit(' '); continue; }
    if (ch === '*') { i++; continue; }
    if (ch === '[') {
      const j = src.indexOf(']', i);
      if (j < 0) { lit(ch); continue; }
      const inner = src.slice(i + 1, j);
      i = j;
      if (inner[0] === '$') {                               // [$¥-804] → ¥
        const sym = inner.slice(1).split('-')[0];
        if (sym) lit(sym);
        continue;
      }
      const c = COLORS[/** @type {keyof typeof COLORS} */ (inner.toLowerCase())];
      if (c) color = c;
      continue;
    }
    if (ch === '@') { toks.push({ kind: 'text' }); hasText = true; continue; }
    if (src.slice(i, i + 5).toUpperCase() === 'AM/PM') { toks.push({ kind: 'date', v: 'AMPM' }); ampm = true; hasDate = true; i += 4; continue; }
    if (src.slice(i, i + 3).toUpperCase() === 'A/P') { toks.push({ kind: 'date', v: 'AP' }); ampm = true; hasDate = true; i += 2; continue; }
    if ('ymdhsa'.includes(low) && !(low === 'a' && src[i + 1]?.toLowerCase() !== 'a')) {
      let j = i;
      while (j < src.length && src[j].toLowerCase() === low) j++;
      toks.push({ kind: 'date', v: src.slice(i, j).toLowerCase() });
      hasDate = true;
      i = j - 1;
      continue;
    }
    // 日期格式里的 . , 是分隔符（yyyy.mm.dd、mmm d, yyyy），不是数字占位
    if ((ch === '.' || ch === ',') && hasDate && numAt < 0) { lit(ch); continue; }
    if (NUM_CH.has(ch) || ((ch === 'E' || ch === 'e') && /[+-]/.test(src[i + 1] ?? '') && numPattern)) {
      if (numAt < 0) { numAt = toks.length; toks.push({ kind: 'num' }); }
      if (ch === 'E' || ch === 'e') {
        let j = i + 2;
        while (j < src.length && src[j] === '0') j++;
        numPattern += src.slice(i, j);
        i = j - 1;
      } else if (toks[toks.length - 1]?.kind === 'num' || ch !== '.') {
        numPattern += ch;
      } else if (ch === '.' && numAt >= 0 && toks[toks.length - 1]?.kind !== 'num') {
        lit(ch);          // 数字块之后的 . 当文字
      }
      continue;
    }
    if (ch === '%') {
      if (numAt < 0) { numAt = toks.length; toks.push({ kind: 'num' }); }
      numPattern += '%';
      lit('%');
      continue;
    }
    lit(ch);
  }

  if (hasDate && numAt < 0) {
    // 分钟与月份同为 m：紧跟在 h 之后、或紧挨在 s 之前的算分钟
    const dateToks = toks.filter((t) => t.kind === 'date');
    for (let k = 0; k < dateToks.length; k++) {
      const t = /** @type {{kind:'date', v:string}} */ (dateToks[k]);
      if (t.v[0] !== 'm' || t.v.length > 2) continue;
      const prev = /** @type {any} */ (dateToks[k - 1]);
      const next = /** @type {any} */ (dateToks[k + 1]);
      if ((prev && prev.v[0] === 'h') || (next && next.v[0] === 's')) t.v = t.v === 'm' ? 'n' : 'nn';
    }
    return { toks, color, type: 'date', ampm, hasSign: false };
  }
  if (numAt >= 0) {
    return { toks, color, type: 'num', num: analyzeNum(numPattern), ampm: false, hasSign: /[-(]/.test(litText(toks)) };
  }
  if (hasText) return { toks, color, type: 'text', ampm: false, hasSign: false };
  return { toks, color, type: 'lit', ampm: false, hasSign: false };
}

/** @param {Tok[]} toks */
const litText = (toks) => toks.filter((t) => t.kind === 'lit').map((t) => /** @type {any} */ (t).v).join('');

/** @param {string} p */
function analyzeNum(p) {
  const pct = (p.match(/%/g) || []).length;
  p = p.replace(/%/g, '');
  let exp = null;
  const em = /[eE]([+-])(0*)$/.exec(p);
  if (em) { exp = { sign: em[1] === '+', digits: Math.max(1, em[2].length) }; p = p.slice(0, em.index); }
  // 尾部逗号：每个缩小 1000 倍
  let scale = 0;
  while (p.endsWith(',')) { scale++; p = p.slice(0, -1); }
  const dot = p.indexOf('.');
  const ip = dot < 0 ? p : p.slice(0, dot);
  const dp = dot < 0 ? '' : p.slice(dot + 1).replace(/,/g, '');
  const comma = ip.includes(',');
  const ipc = ip.replace(/,/g, '');
  const intMin = (ipc.match(/0/g) || []).length + (ipc.match(/\?/g) || []).length;
  return {
    intMin, intLen: ipc.length,
    decMin: (dp.match(/0/g) || []).length, decMax: dp.length, decQ: (dp.match(/\?/g) || []).length,
    comma, pct, exp, scale,
  };
}

/** @param {string} fmt @returns {Section[]} */
function compile(fmt) {
  let secs = CACHE.get(fmt);
  if (!secs) {
    secs = splitSections(fmt).map(compileSection);
    if (CACHE.size > 500) CACHE.clear();
    CACHE.set(fmt, secs);
  }
  return secs;
}

/** 四舍五入到 d 位小数（避开 toFixed 的二进制误差：1.005 → 1.01）。 @param {number} n @param {number} d */
function roundTo(n, d) {
  const f = 10 ** d;
  return Math.round(tidy(n * f)) / f;
}

/** @param {string} s */
const group = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** @param {number} n 非负 @param {NonNullable<Section['num']>} f */
function fmtNumber(n, f) {
  n = n * 100 ** f.pct / 1000 ** f.scale;
  if (f.exp) {
    let e = n === 0 ? 0 : Math.floor(Math.log10(n));
    const ip = Math.max(1, f.intLen);
    if (ip > 1) e = Math.floor(e / ip) * ip; else e -= 0;
    let m = n / 10 ** e;
    m = roundTo(m, f.decMax);
    if (m >= 10 ** Math.max(1, ip)) { m /= 10; e += 1; }
    const mant = digits(m, { ...f, comma: false });
    const es = (e < 0 ? '-' : f.exp.sign ? '+' : '') + String(Math.abs(e)).padStart(f.exp.digits, '0');
    return mant + 'E' + es;
  }
  return digits(roundTo(n, f.decMax), f);
}

/** @param {number} n @param {NonNullable<Section['num']>} f */
function digits(n, f) {
  let s = n.toFixed(f.decMax);
  let [ip, dp = ''] = s.split('.');
  if (f.decMax > f.decMin) {
    // # 占位：去掉多余的尾 0；? 占位：换成空格
    let keep = dp.length;
    while (keep > f.decMin && dp[keep - 1] === '0') keep--;
    const trimmed = dp.slice(0, keep);
    dp = f.decQ ? trimmed.padEnd(dp.length, ' ') : trimmed;
  }
  if (ip === '0' && f.intMin === 0) ip = '';
  if (ip.length < f.intMin) ip = ip.padStart(f.intMin, '0');
  if (f.comma) ip = group(ip);
  return dp.length ? ip + '.' + dp : f.decMax && !dp.length && f.decMin === 0 && f.decMax > 0 ? ip + '.' : ip;
}

/** @param {number} serial @param {Section} sec */
function fmtDate(serial, sec) {
  if (serial < 0 || !Number.isFinite(serial) || serial > 2958465) return '#'.repeat(8);
  // 秒级四舍五入，免得 23:59:59.9 显示成 23:59:59 而日期已是次日
  const rounded = Math.round(serial * 86400) / 86400;
  const d = serialToDate(rounded);
  let out = '';
  for (const t of sec.toks) {
    if (t.kind === 'lit') { out += t.v; continue; }
    if (t.kind !== 'date') continue;
    const v = t.v;
    switch (v) {
      case 'yy': out += String(d.y).slice(-2); break;
      case 'y': out += String(d.y).slice(-2); break;
      case 'm': out += d.m; break;
      case 'mm': out += String(d.m).padStart(2, '0'); break;
      case 'mmm': out += MONTHS[d.m - 1].slice(0, 3); break;
      case 'mmmm': out += MONTHS[d.m - 1]; break;
      case 'mmmmm': out += MONTHS[d.m - 1][0]; break;
      case 'd': out += d.d; break;
      case 'dd': out += String(d.d).padStart(2, '0'); break;
      case 'ddd': out += DAYS[d.wd].slice(0, 3); break;
      case 'aaa': out += DAYS_CN[d.wd]; break;
      case 'aaaa': out += '星期' + DAYS_CN[d.wd]; break;
      case 'h': case 'hh': {
        let h = d.H;
        if (sec.ampm) h = h % 12 || 12;
        out += v === 'hh' ? String(h).padStart(2, '0') : h;
        break;
      }
      case 'n': out += d.M; break;
      case 'nn': out += String(d.M).padStart(2, '0'); break;
      case 's': out += d.S; break;
      case 'ss': out += String(d.S).padStart(2, '0'); break;
      case 'AMPM': out += d.H < 12 ? 'AM' : 'PM'; break;
      case 'AP': out += d.H < 12 ? 'A' : 'P'; break;
      default:
        if (v[0] === 'y') out += d.y;
        else if (v[0] === 'd') out += DAYS[d.wd];
        else if (v[0] === 'a') out += '星期' + DAYS_CN[d.wd];
        else out += v;
    }
  }
  return out;
}

/** @param {Section} sec @param {string} text */
function fmtText(sec, text) {
  let out = '';
  for (const t of sec.toks) {
    if (t.kind === 'lit') out += t.v;
    else if (t.kind === 'text') out += text;
  }
  return out;
}

/**
 * @param {any} v 引擎算出的值
 * @param {string|undefined} fmt 格式码；空 / General 为常规
 * @returns {{text:string, color:string|null}}
 */
export function formatValue(v, fmt) {
  if (v == null) return { text: '', color: null };
  if (v instanceof FErr) return { text: v.err, color: null };
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', color: null };
  if (!fmt || fmt === 'General') {
    return { text: typeof v === 'number' ? numToText(v) : String(v), color: null };
  }

  const secs = compile(fmt);
  if (typeof v === 'string') {
    const textSec = secs[3] ?? secs.find((s) => s.type === 'text');
    if (textSec) return { text: fmtText(textSec, v), color: textSec.color };
    // 数字 / 日期格式遇上「长得像数字的文本」：照数字格式化（2024-01-15 配 yyyy年m月d日）
    if (secs[0].type === 'num' || secs[0].type === 'date') {
      const n = parseNumberText(v);
      if (n != null) return formatValue(n, fmt);
    }
    return { text: v, color: null };
  }

  if (!Number.isFinite(v)) return { text: '#NUM!', color: null };
  let sec = secs[0];
  let x = v;
  let signed = false;              // 负数节自己负责画负号
  if (secs.length >= 2 && v < 0 && secs[1]) { sec = secs[1]; x = -v; signed = true; }
  else if (secs.length >= 3 && v === 0 && secs[2]) sec = secs[2];

  if (sec.type === 'date') return { text: fmtDate(x, sec), color: sec.color };
  if (sec.type === 'text') return { text: fmtText(sec, numToText(v)), color: sec.color };
  if (sec.type === 'lit') return { text: litText(sec.toks), color: sec.color };

  const f = /** @type {NonNullable<Section['num']>} */ (sec.num);
  const body = fmtNumber(Math.abs(x), f);
  // 四舍五入后归零的负数（-0.001 配 0.00）不带负号
  const neg = !signed && x < 0 && /[1-9]/.test(body);
  let out = '';
  for (const t of sec.toks) {
    if (t.kind === 'lit') out += t.v;
    else if (t.kind === 'num') out += body;
  }
  return { text: neg ? '-' + out : out, color: sec.color };
}

/** 格式码是不是日期 / 时间。 @param {string|undefined} fmt */
export function isDateFormat(fmt) {
  if (!fmt || fmt === 'General') return false;
  return compile(fmt)[0].type === 'date';
}

/**
 * 「增加 / 减少小数位数」按钮。
 * @param {string|undefined} fmt @param {number} delta +1 / -1 @param {any} [sample] 常规格式时参考当前值
 */
export function adjustDecimals(fmt, delta, sample) {
  if (!fmt || fmt === 'General') {
    let cur = 0;
    if (typeof sample === 'number') {
      const s = numToText(sample);
      const dot = s.indexOf('.');
      cur = dot < 0 || /E/.test(s) ? 0 : s.length - dot - 1;
    }
    const n = Math.max(0, cur + delta);
    return n ? '0.' + '0'.repeat(n) : '0';
  }
  if (isDateFormat(fmt)) return fmt;
  // 只改第一个数字块的小数部分；多节格式每节都改
  return splitSections(fmt).map((sec) => {
    const m = /([0#?,]*[0#?])(\.([0#?]*))?/.exec(sec);
    if (!m) return sec;
    const dec = m[3] ?? '';
    let nd;
    if (delta > 0) nd = dec + '0';
    else nd = dec.slice(0, -1);
    const rep = m[1] + (nd ? '.' + nd : '');
    return sec.slice(0, m.index) + rep + sec.slice(m.index + m[0].length);
  }).join(';');
}
