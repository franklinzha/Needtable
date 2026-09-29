/**
 * P1 网格内核测试。对着计划里那条完成判据来的：
 *   「10 万行本地数据滚动流畅；可选区、编辑、复制粘贴到 Excel 往返正确」
 *
 * "流畅"在无头环境里没法用肉眼验，所以换成一个更硬的指标：
 * **一帧画多少个单元格与总行数无关**。10 万行时如果每帧的 fillText 次数
 * 仍然是几百，那虚拟化就是成立的；真掉帧只可能来自别处。
 */

import assert from 'node:assert/strict';
import { installDom, clipboardData, flushFrames } from './dom-stub.mjs';

installDom();
const { Grid } = await import('../public/js/grid/grid.js');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack ?? err.message)); }
}

/** 造一个挂好的网格。舞台固定 900×600，便于用坐标算命中。 */
function mount(opts) {
  const host = document.createElement('div');
  const g = new Grid(host, { name: '测试表', ...opts });
  return g;
}

/** 屏幕坐标：第 r 行第 c 列的中心。 */
function center(g, r, c) {
  const b = g.vp.cellRect(r, c);
  return { clientX: b.x + b.w / 2, clientY: b.y + b.h / 2 };
}

// ── 装配 ────────────────────────────────────────────────────────────────

await test('挂载后画布按 DPR 放大，初始选区在 A1', () => {
  const g = mount();
  assert.equal(g.canvas.width, 1800, 'DPR=2 时位图宽应为 CSS 宽的两倍');
  assert.equal(g.canvas.height, 1200);
  assert.equal(g.addr.textContent, 'A1');
  assert.ok(g.statSize.textContent.includes('500 行'));
  g.destroy();
});

await test('滚动条尺寸 = 表头 + 内容总尺寸', () => {
  const g = mount({ rows: 1000, cols: 10 });
  assert.equal(g.sizer.style.height, (26 + 1000 * 26) + 'px');
  assert.equal(g.sizer.style.width, (48 + 10 * 104) + 'px');
  g.destroy();
});

// ── 命中与选区 ──────────────────────────────────────────────────────────

await test('点击命中正确的单元格，Shift 点击扩成矩形', () => {
  const g = mount();
  g.scroll.fire('pointerdown', center(g, 3, 2));
  assert.deepEqual(g.sel.active, { r: 3, c: 2 });
  assert.equal(g.addr.textContent, 'C4');

  g.scroll.fire('pointerdown', { ...center(g, 6, 5), shiftKey: true });
  assert.deepEqual(g.sel.rect, { r0: 3, r1: 6, c0: 2, c1: 5 });
  assert.ok(g.addr.textContent.startsWith('C4:F7'));
  g.destroy();
});

await test('点列头选整列，点行头选整行，点左上角全选', () => {
  const g = mount({ rows: 50, cols: 8 });
  g.scroll.fire('pointerdown', { clientX: g.vp.cellRect(0, 2).x + 10, clientY: 5 });
  assert.deepEqual(g.sel.rect, { r0: 0, r1: 49, c0: 2, c1: 2 });

  g.scroll.fire('pointerdown', { clientX: 10, clientY: g.vp.cellRect(4, 0).y + 5 });
  assert.deepEqual(g.sel.rect, { r0: 4, r1: 4, c0: 0, c1: 7 });

  g.scroll.fire('pointerdown', { clientX: 5, clientY: 5 });
  assert.deepEqual(g.sel.rect, { r0: 0, r1: 49, c0: 0, c1: 7 });
  g.destroy();
});

await test('滚动后命中仍然正确（scrollY 有没有被算进去）', () => {
  const g = mount({ rows: 10000, cols: 26 });
  g.scroll.scrollTop = 26 * 300;
  g.scroll.fire('scroll');
  assert.equal(g.vp.scrollY, 7800);
  // 表头下方第一行应当是第 300 行
  g.scroll.fire('pointerdown', { clientX: 60, clientY: 26 + 5 });
  assert.equal(g.sel.active.r, 300);
  g.destroy();
});

// ── 编辑 ────────────────────────────────────────────────────────────────

await test('直接打字进入编辑，Enter 提交并下移', () => {
  const g = mount();
  g.scroll.fire('pointerdown', center(g, 1, 1));
  const ev = g.scroll.fire('keydown', { key: '甲' });
  assert.ok(ev.defaultPrevented);
  assert.ok(g.editor.open, '可打印字符应直接进入编辑');
  assert.equal(g.editor.el.value, '甲');

  g.editor.el.value = '甲乙丙';
  g.editor.el.fire('keydown', { key: 'Enter' });
  assert.equal(g.model.getCell(1, 1), '甲乙丙');
  assert.deepEqual(g.sel.active, { r: 2, c: 1 }, 'Enter 后应下移一行');
  assert.ok(!g.editor.open);
  g.destroy();
});

await test('Escape 取消编辑不落盘', () => {
  const g = mount();
  g.scroll.fire('pointerdown', center(g, 0, 0));
  g.scroll.fire('keydown', { key: 'x' });
  g.editor.el.value = '不要保存';
  g.editor.el.fire('keydown', { key: 'Escape' });
  assert.equal(g.model.getCell(0, 0), '');
  g.destroy();
});

await test('双击进入编辑时保留原值', () => {
  const g = mount();
  g.model.apply([{ t: 'setCell', r: 2, c: 3, v: '原值' }]);
  g.scroll.fire('dblclick', center(g, 2, 3));
  assert.equal(g.editor.el.value, '原值');
  g.destroy();
});

await test('Delete 清空整个选区', () => {
  const g = mount();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) g.model.apply([{ t: 'setCell', r, c, v: 'x' }]);
  g.sel.set(0, 0); g.sel.extendTo(1, 1);
  g.scroll.fire('keydown', { key: 'Delete' });
  assert.equal(g.model.getCell(0, 0), '');
  assert.equal(g.model.getCell(1, 1), '');
  assert.equal(g.model.getCell(2, 2), 'x', '选区之外不该被动');
  g.destroy();
});

await test('Tab 在多格选区里横向循环，到边界换行', () => {
  const g = mount();
  g.sel.set(1, 1); g.sel.extendTo(2, 2);
  g.scroll.fire('keydown', { key: 'Tab' });
  assert.deepEqual(g.sel.active, { r: 1, c: 2 });
  g.scroll.fire('keydown', { key: 'Tab' });
  assert.deepEqual(g.sel.active, { r: 2, c: 1 }, '越过右边界应折到下一行行首');
  assert.deepEqual(g.sel.rect, { r0: 1, r1: 2, c0: 1, c1: 2 }, '选区本身不该变');
  g.destroy();
});

await test('Ctrl+A 全选，Ctrl+↓ 跳到末行', () => {
  const g = mount({ rows: 300, cols: 12 });
  g.scroll.fire('keydown', { key: 'a', ctrlKey: true });
  assert.deepEqual(g.sel.rect, { r0: 0, r1: 299, c0: 0, c1: 11 });
  g.sel.set(0, 0);
  g.scroll.fire('keydown', { key: 'ArrowDown', ctrlKey: true });
  assert.equal(g.sel.active.r, 299);
  assert.ok(g.scroll.scrollTop > 0, '跳到末行应把视口带过去');
  g.destroy();
});

// ── 剪贴板 ──────────────────────────────────────────────────────────────

await test('复制同时写出 TSV 与 HTML 两种格式', () => {
  const g = mount();
  g.model.apply([
    { t: 'setCell', r: 0, c: 0, v: 'a' }, { t: 'setCell', r: 0, c: 1, v: '1' },
    { t: 'setCell', r: 1, c: 0, v: 'b' }, { t: 'setCell', r: 1, c: 1, v: '2' },
  ]);
  g.sel.set(0, 0); g.sel.extendTo(1, 1);
  const dt = clipboardData();
  g.scroll.fire('copy', { clipboardData: dt });
  assert.equal(dt.store['text/plain'], 'a\t1\nb\t2');
  assert.ok(dt.store['text/html'].includes('<td>a</td>'));
  g.destroy();
});

await test('粘贴 Excel 的 TSV：落位正确，并自动扩表', () => {
  const g = mount({ rows: 5, cols: 3 });
  g.sel.set(4, 2);
  g.scroll.fire('paste', { clipboardData: clipboardData({ 'text/plain': 'x\ty\nz\tw' }) });
  assert.equal(g.model.getCell(4, 2), 'x');
  assert.equal(g.model.getCell(4, 3), 'y');
  assert.equal(g.model.getCell(5, 2), 'z');
  assert.equal(g.model.getCell(5, 3), 'w');
  assert.equal(g.model.rowCount, 6, '行数应被撑开');
  assert.equal(g.model.colCount, 4, '列数应被撑开');
  assert.deepEqual(g.sel.rect, { r0: 4, r1: 5, c0: 2, c1: 3 }, '粘贴后应选中落下的区域');
  g.destroy();
});

await test('往返：复制出去的 TSV 原样粘回来，值完全一致（含制表符与换行）', () => {
  const g = mount();
  const src = [['普通', '含\ttab'], ['含\n换行', '含"引号']];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
    g.model.apply([{ t: 'setCell', r, c, v: src[r][c] }]);
  }
  g.sel.set(0, 0); g.sel.extendTo(1, 1);
  const dt = clipboardData();
  g.scroll.fire('copy', { clipboardData: dt });

  g.sel.set(10, 0);
  g.scroll.fire('paste', { clipboardData: clipboardData({ 'text/plain': dt.store['text/plain'] }) });
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
    assert.equal(g.model.getCell(10 + r, c), src[r][c], `(${r},${c}) 往返后不一致`);
  }
  g.destroy();
});

await test('剪切会清掉原区域', () => {
  const g = mount();
  g.model.apply([{ t: 'setCell', r: 0, c: 0, v: 'gone' }]);
  g.sel.set(0, 0);
  const dt = clipboardData();
  g.scroll.fire('cut', { clipboardData: dt });
  assert.equal(dt.store['text/plain'], 'gone');
  assert.equal(g.model.getCell(0, 0), '');
  g.destroy();
});

await test('超大粘贴被挡下，不会把页面卡死', () => {
  const g = mount();
  const huge = Array.from({ length: 40001 }, () => 'a\tb\tc\td\te\tf').join('\n');
  g.scroll.fire('paste', { clipboardData: clipboardData({ 'text/plain': huge }) });
  assert.ok(String(globalThis.__lastAlert).includes('最多粘贴'));
  assert.equal(g.model.cells.size, 0);
  g.destroy();
});

// ── 列宽与冻结 ──────────────────────────────────────────────────────────

await test('拖列头分隔线改列宽，滚动尺寸跟着变', () => {
  const g = mount({ rows: 20, cols: 5 });
  const edge = g.vp.cellRect(0, 1);
  const x = edge.x + edge.w;
  g.scroll.fire('pointerdown', { clientX: x, clientY: 5 });
  assert.ok(g._drag && g._drag.kind === 'resize', '应进入列宽拖拽');
  g.scroll.fire('pointermove', { clientX: x + 60, clientY: 5 });
  assert.equal(g.model.colWidth(1), 164);
  assert.equal(g.sizer.style.width, (48 + 104 * 4 + 164) + 'px');
  g.scroll.fire('pointerup', {});
  assert.equal(g._drag, null);
  g.destroy();
});

await test('列宽有下限，拖到负数也不会翻转', () => {
  const g = mount();
  const edge = g.vp.cellRect(0, 0);
  g.scroll.fire('pointerdown', { clientX: edge.x + edge.w, clientY: 5 });
  g.scroll.fire('pointermove', { clientX: edge.x - 500, clientY: 5 });
  assert.equal(g.model.colWidth(0), 32);
  g.destroy();
});

await test('冻结开关生效，冻结区不随滚动移动', () => {
  const g = mount({ rows: 500, cols: 20 });
  g.btnFreeze.fire('click');
  assert.equal(g.btnFreeze.getAttribute('aria-pressed'), 'true');
  assert.equal(g.vp.frozenRows, 1);
  const before = g.vp.cellRect(0, 0);
  g.scroll.scrollTop = 2000;
  g.scroll.scrollLeft = 900;
  g.scroll.fire('scroll');
  const after = g.vp.cellRect(0, 0);
  assert.deepEqual({ x: after.x, y: after.y }, { x: before.x, y: before.y }, '冻结格不该动');
  assert.notEqual(g.vp.cellRect(5, 5).y, before.y + 5 * 26, '非冻结格应该动');
  g.destroy();
});

// ── 10 万行 ─────────────────────────────────────────────────────────────

await test('10 万行：生成 + 首帧渲染', () => {
  const g = mount();
  const t0 = performance.now();
  g.loadDemo(100000);
  const ms = performance.now() - t0;
  assert.equal(g.model.rowCount, 100001);
  assert.ok(g.model.cells.size > 700000, '应填满 8 列');
  assert.ok(ms < 8000, '生成 10 万行耗时 ' + Math.round(ms) + 'ms，过慢');
  console.log('       生成 10 万行 + 首帧：' + Math.round(ms) + 'ms');
  g.destroy();
});

await test('10 万行：每帧只画可视区，绘制量与总行数无关', () => {
  const small = mount({ rows: 200, cols: 26 });
  small.renderer.draw();
  const ctxS = small.canvas.getContext();
  ctxS.resetCalls();
  small.renderer.draw();
  const baseline = ctxS.calls.fillText;
  small.destroy();

  const g = mount();
  g.loadDemo(100000);
  g.scroll.scrollTop = 26 * 90000;
  g.scroll.scrollLeft = 0;
  g.scroll.fire('scroll');
  const ctx = g.canvas.getContext();
  ctx.resetCalls();
  g.renderer.draw();
  const deep = ctx.calls.fillText;

  assert.ok(deep < 1500, '一帧画了 ' + deep + ' 次文本，虚拟化失效了');
  assert.ok(deep >= baseline, '深处有数据，绘制次数不该少于空表');
  console.log('       第 9 万行处一帧绘制文本 ' + deep + ' 次（空表基线 ' + baseline + '）');
  g.destroy();
});

await test('10 万行：连续滚动 200 帧不抛异常且耗时可控', () => {
  const g = mount();
  g.loadDemo(100000);
  flushFrames();                 // 先把之前用例攒下的帧清干净，否则会记到这一轮头上
  const t0 = performance.now();
  let drawn = 0;
  for (let i = 0; i < 200; i++) {
    g.scroll.scrollTop = (i * 997) % (26 * 99000);
    g.scroll.fire('scroll');
    drawn += flushFrames();
  }
  const ms = performance.now() - t0;
  assert.equal(drawn, 200, '每次滚动都应真的重画一帧，实际 ' + drawn + ' 帧');
  assert.ok(ms < 4000, '200 帧耗时 ' + Math.round(ms) + 'ms');
  console.log('       200 帧滚动：' + Math.round(ms) + 'ms（' + (ms / 200).toFixed(2) + ' ms/帧，不含真实文本测量）');
  g.destroy();
});

await test('10 万行仍可编辑与统计：末行写值后状态栏正确', () => {
  const g = mount();
  g.loadDemo(100000);
  g.sel.set(100000, 4);
  g.sel.extendTo(100000, 6);
  g._status();
  assert.ok(g.statSum.textContent.includes('求和'), '数值列应给出求和');
  assert.ok(g.statSize.textContent.includes('100,001 行'));
  g.destroy();
});

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED');
if (failures > 0) process.exit(1);
