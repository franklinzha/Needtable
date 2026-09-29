/**
 * CSV / TSV 读写。导出取"已用区域"的显示文本（与屏幕上看到的一致）；
 * 导入自动识别分隔符、处理引号与 BOM。
 */

import { lastRow, lastCol } from '../grid/commands.js';

/** @param {string} s */
function quote(s) {
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * @param {import('../grid/model.js').GridModel} model
 * @param {{text:(r:number,c:number)=>string}} calc
 */
export function toCsv(model, calc) {
  const R = lastRow(model), C = lastCol(model);
  const lines = [];
  for (let r = 0; r <= R; r++) {
    const row = [];
    for (let c = 0; c <= C; c++) row.push(quote(String(calc.text(r, c) ?? '')));
    lines.push(row.join(','));
  }
  return lines.join('\r\n') + (lines.length ? '\r\n' : '');
}

/** 看第一行（引号外）哪个候选分隔符最多。 @param {string} text */
function sniff(text) {
  const counts = { ',': 0, '\t': 0, ';': 0 };
  let inQ = false;
  for (let i = 0; i < text.length && i < 20000; i++) {
    const ch = text[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && (ch === '\n' || ch === '\r')) break;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  let best = ',';
  for (const d of ['\t', ';']) if (counts[d] > counts[best]) best = d;
  return best;
}

/**
 * @param {string} text
 * @param {string} [delim] 不给就自动识别
 * @returns {string[][]}
 */
export function parseCsv(text, delim) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = delim ?? sniff(text);
  /** @type {string[][]} */ const rows = [];
  /** @type {string[]} */ let row = [];
  let field = '', inQ = false, i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQ = true; i++; continue; }
    if (ch === d) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
