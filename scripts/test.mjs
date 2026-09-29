#!/usr/bin/env node
/** 跑齐所有测试。零依赖，不需要测试框架。 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const suites = [
  ['分数索引', 'public/shared/model/fracindex.test.mjs'],
  ['A1 表示法', 'public/shared/util/a1.test.mjs'],
  ['二维码', 'public/shared/util/qr.test.mjs'],
  ['界面多语言 / 词典完整性', 'public/shared/i18n/i18n.test.mjs'],
  ['WS ticket', 'worker/lib/ticket.test.mjs'],
  ['口令 / TOTP / 会话', 'worker/lib/auth.test.mjs'],
  ['P0 认证链路', 'worker/index.test.mjs'],
  ['P1 网格内核', 'scripts/grid.test.mjs'],
  ['P2 Durable Object', 'scripts/tabledo.test.mjs'],
  ['P2 存储结构 v5（升级 / 写入量 / 日志环）', 'scripts/storage.test.mjs'],
  ['P2 实时同步', 'scripts/sync.test.mjs'],
  ['多人并发收敛（fuzz）', 'scripts/fuzz.test.mjs'],
  ['账号等级 / 三级分享 / 默认密码', 'scripts/acl.test.mjs'],
  ['P3 结构与格式', 'scripts/sheet.test.mjs'],
  ['P4 公式引擎', 'public/shared/formula/formula.test.mjs'],
  ['跨表引用', 'scripts/extref.test.mjs'],
  ['函数文档', 'scripts/docs.test.mjs'],
  ['图表', 'scripts/chart.test.mjs'],
  ['透视表 / 仪表盘布局', 'scripts/pivot.test.mjs'],
  ['下拉列表 / 多级下拉', 'scripts/dropdown.test.mjs'],
  ['主题配色', 'scripts/theme.test.mjs'],
  ['动态数组溢出 / 列标点选', 'scripts/spill.test.mjs'],
  ['AI 占位', 'scripts/ai.test.mjs'],
  ['P3-P6 编辑动作 / 计算层', 'scripts/actions.test.mjs'],
  ['P6 导入导出', 'scripts/io.test.mjs'],
  ['文档 / 幻灯片导入导出（Office / iWork）', 'scripts/office.test.mjs'],
  ['P6 附件', 'scripts/files.test.mjs'],
  ['用户管理 / 工作区成员', 'scripts/members.test.mjs'],
  ['文档 / 幻灯片 / 帮助中心', 'scripts/content.test.mjs'],
  ['JS 语法检查', 'scripts/syntax.mjs'],
  ['静态资源预加载列表', 'scripts/preload.mjs --check'],
];

let failed = 0;
for (const [name, file] of suites) {
  console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(0, 60 - name.length)));
  try {
    execFileSync(process.execPath, file.split(' '), { cwd: ROOT, stdio: 'inherit' });
  } catch {
    failed++;
  }
}

console.log(failed === 0 ? '\n全部通过 ✅\n' : `\n${failed} 个测试套件失败 ❌\n`);
process.exit(failed === 0 ? 0 : 1);
