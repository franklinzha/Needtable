/**
 * 剪贴板：与 Excel / Google Sheets 双向互通。
 *
 * 往返正确的关键是同时写两种格式：
 *   - text/plain 用 TSV（Excel 粘贴时优先认它，且换行/制表符要转义）
 *   - text/html 用 <table>（Sheets 和 Word 认它，能保住空单元格与合并结构）
 * 读的时候反过来优先 text/html —— 因为 TSV 无法区分「单元格里的换行」和「换行分隔行」。
 */

/**
 * 区域 → { tsv, html }
 * @param {(r:number,c:number)=>string} get
 * @param {{r0:number,c0:number,r1:number,c1:number}} rect
 */
export function serializeRange(get, rect, skip) {
  const rows = [];
  const htmlRows = [];
  for (let r = rect.r0; r <= rect.r1; r++) {
    if (skip?.(r)) continue;
    const cells = [];
    const htmlCells = [];
    for (let c = rect.c0; c <= rect.c1; c++) {
      const v = get(r, c) ?? '';
      cells.push(escapeTsv(v));
      htmlCells.push('<td>' + escapeHtml(v) + '</td>');
    }
    rows.push(cells.join('\t'));
    htmlRows.push('<tr>' + htmlCells.join('') + '</tr>');
  }
  return {
    tsv: rows.join('\n'),
    html: '<meta charset="utf-8"><table>' + htmlRows.join('') + '</table>',
  };
}

/** Excel 的规矩：含制表符、换行或引号的值整体加引号，内部引号翻倍。 */
function escapeTsv(v) {
  return /[\t\n\r"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function escapeHtml(v) {
  return v.replace(/[&<>]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
}

/**
 * TSV → 二维数组。逐字符扫描，正确处理带引号的多行单元格。
 * @param {string} text @returns {string[][]}
 */
export function parseTsv(text) {
  const out = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') { quoted = true; continue; }
    if (ch === '\t') { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); out.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  row.push(cell);
  out.push(row);
  // 末尾多余的空行（文本以换行结尾）不该变成一行空数据
  while (out.length > 1 && out[out.length - 1].length === 1 && out[out.length - 1][0] === '') out.pop();
  return out;
}

/**
 * HTML 表格 → 二维数组。用 DOMParser 而不是正则，避免被属性里的 '>' 骗到。
 * 解析出来的文本一律走 textContent，不会把外来 HTML 塞进页面。
 * @param {string} html @returns {string[][] | null}
 */
export function parseHtmlTable(html) {
  let doc;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); }
  catch { return null; }
  const table = doc.querySelector('table');
  if (!table) return null;
  const out = [];
  /** @type {number[]} 每列还要被上方 rowspan 占住几行 */
  const span = [];
  for (const tr of table.querySelectorAll('tr')) {
    const row = [];
    // 合并单元格（Excel / 网页里的 colspan、rowspan）要留出空位，否则后面的格子会整体左移错位
    const skip = () => { while (span[row.length] > 0) { span[row.length]--; row.push(''); } };
    for (const td of tr.querySelectorAll('td, th')) {
      skip();
      const cs = Math.min(100, Math.max(1, /** @type {any} */ (td).colSpan | 0));
      const rs = Math.min(1000, Math.max(1, /** @type {any} */ (td).rowSpan | 0));
      for (let k = 0; k < cs; k++) {
        if (rs > 1) span[row.length] = rs - 1;
        row.push(k ? '' : (td.textContent ?? '').replace(/ /g, ' '));
      }
    }
    skip();
    for (let c = row.length; c < span.length; c++) if (span[c] > 0) span[c]--;   // 行尾被占的列也要消耗掉
    if (row.length) out.push(row);
  }
  return out.length ? out : null;
}

/** 从 DataTransfer 里取出二维数组，优先 HTML。 @param {DataTransfer} dt */
export function readClipboard(dt) {
  const html = dt.getData('text/html');
  if (html) {
    const grid = parseHtmlTable(html);
    if (grid) return grid;
  }
  const text = dt.getData('text/plain');
  return text ? parseTsv(text) : null;
}
