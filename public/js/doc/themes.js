/**
 * 幻灯片的形状库、主题、版式和内容模板，文档的主题和内容模板。
 * 纯数据加几个纯函数，不碰 DOM，Node 里可以直接测（scripts/content.test.mjs）。
 */

import { uid } from '../../shared/util/uid.js';
import { t as tt } from '../../shared/i18n/i18n.js';

// ── 形状 ────────────────────────────────────────────────────────────────────

/**
 * d：SVG 路径（viewBox 0 0 100 100，拉伸填满元素）；没有 d 的用 CSS 画（边框不变形、圆角好看）。
 * line：只有线条没有填充。rule：挖空的形状用 evenodd。sq：插入时默认画成正方形。
 * @type {{ id: string, label: string, d?: string, line?: boolean, rule?: string, sq?: boolean }[]}
 */
export const SHAPES = [
  { id: 'rect', label: tt('矩形') },
  { id: 'round', label: tt('圆角矩形') },
  { id: 'ellipse', label: tt('椭圆'), sq: true },
  { id: 'triangle', label: tt('三角形'), d: 'M50 0L100 100H0Z' },
  { id: 'rtriangle', label: tt('直角三角形'), d: 'M0 0L100 100H0Z' },
  { id: 'diamond', label: tt('菱形'), d: 'M50 0L100 50L50 100L0 50Z' },
  { id: 'parallelogram', label: tt('平行四边形'), d: 'M25 0H100L75 100H0Z' },
  { id: 'trapezoid', label: tt('梯形'), d: 'M20 0H80L100 100H0Z' },
  { id: 'pentagon', label: tt('五边形'), d: 'M50 0L100 38L81 100H19L0 38Z', sq: true },
  { id: 'hexagon', label: tt('六边形'), d: 'M25 0H75L100 50L75 100H25L0 50Z' },
  { id: 'octagon', label: tt('八边形'), d: 'M30 0H70L100 30V70L70 100H30L0 70V30Z', sq: true },
  { id: 'star', label: tt('五角星'), d: 'M50 0L61 35H98L68 57L79 91L50 70L21 91L32 57L2 35H39Z', sq: true },
  { id: 'star6', label: tt('六角星'), d: 'M50 0L62 25H93L77 50L93 75H62L50 100L38 75H7L23 50L7 25H38Z', sq: true },
  { id: 'heart', label: tt('心形'), d: 'M50 92C20 70 0 50 0 28C0 12 12 0 27 0C38 0 46 6 50 15C54 6 62 0 73 0C88 0 100 12 100 28C100 50 80 70 50 92Z', sq: true },
  { id: 'arrow-r', label: tt('右箭头'), d: 'M0 30H60V0L100 50L60 100V70H0Z' },
  { id: 'arrow-l', label: tt('左箭头'), d: 'M100 30H40V0L0 50L40 100V70H100Z' },
  { id: 'arrow-u', label: tt('上箭头'), d: 'M30 100V40H0L50 0L100 40H70V100Z' },
  { id: 'arrow-d', label: tt('下箭头'), d: 'M30 0V60H0L50 100L100 60H70V0Z' },
  { id: 'arrow-lr', label: tt('双向箭头'), d: 'M0 50L25 0V30H75V0L100 50L75 100V70H25V100Z' },
  { id: 'chevron', label: tt('燕尾形'), d: 'M0 0H75L100 50L75 100H0L25 50Z' },
  { id: 'pentarrow', label: tt('箭头框'), d: 'M0 0H75L100 50L75 100H0Z' },
  { id: 'plus', label: tt('十字'), d: 'M35 0H65V35H100V65H65V100H35V65H0V35H35Z', sq: true },
  { id: 'cross', label: tt('乘号'), d: 'M20 0L50 30L80 0L100 20L70 50L100 80L80 100L50 70L20 100L0 80L30 50L0 20Z', sq: true },
  { id: 'lightning', label: tt('闪电'), d: 'M58 0L15 58H45L35 100L85 38H55Z', sq: true },
  { id: 'callout', label: tt('对话框'), d: 'M0 0H100V75H40L20 100V75H0Z' },
  { id: 'bubble', label: tt('圆角对话框'), d: 'M10 0H90Q100 0 100 10V65Q100 75 90 75H45L25 100V75H10Q0 75 0 65V10Q0 0 10 0Z' },
  { id: 'donut', label: tt('圆环'), d: 'M50 0A50 50 0 1 1 50 100A50 50 0 1 1 50 0ZM50 25A25 25 0 1 0 50 75A25 25 0 1 0 50 25Z', rule: 'evenodd', sq: true },
  { id: 'frame', label: tt('边框'), d: 'M0 0H100V100H0ZM12 12V88H88V12Z', rule: 'evenodd' },
  { id: 'wave', label: tt('波浪'), d: 'M0 30C20 10 30 10 50 30S80 50 100 30V100H0Z' },
  { id: 'flag', label: tt('文档'), d: 'M0 0H100V85C75 70 25 100 0 85Z' },
  { id: 'line', label: tt('直线'), d: 'M0 50H100', line: true },
  { id: 'diag', label: tt('斜线'), d: 'M0 100L100 0', line: true },
];
export const SHAPE_BY_ID = new Map(SHAPES.map((s) => [s.id, s]));

/** 线条粗细夹紧在 0~20。 @param {any} v */
export const strokeWidth = (v) => Math.max(0, Math.min(20, Math.round(Number(v) || 0)));

// ── 幻灯片主题 ──────────────────────────────────────────────────────────────

/** 主题字体。 */
export const FONTS = {
  sans: '',
  serif: 'Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, serif',
  kai: '"Kaiti SC", STKaiti, KaiTi, "Noto Serif SC", serif',
};

/**
 * title / text / sub：标题、正文、副标题的文字颜色；accent：新插入形状的颜色。
 * deco：铺在每一页最底层的装饰形状（不能选中，换主题时整体替换）。
 * @typedef {{ id: string, name: string, bg: string, title: string, text: string, sub: string, accent: string,
 *   font?: keyof typeof FONTS, deco: any[] }} SlideTheme
 * @type {SlideTheme[]}
 */
export const SLIDE_THEMES = [
  { id: 'plain', name: tt('简洁白'), bg: '#ffffff', title: '#1f2328', text: '#1f2328', sub: '#57606a', accent: '#a5d8ff', deco: [] },
  {
    id: 'blue', name: tt('商务蓝'), bg: '#ffffff', title: '#0b3d91', text: '#334155', sub: '#64748b', accent: '#3b82f6',
    deco: [
      { shape: 'rect', x: 0, y: 0, w: 960, h: 14, fill: '#1d4ed8' },
      { shape: 'rect', x: 0, y: 522, w: 960, h: 18, fill: '#dbeafe' },
      { shape: 'rect', x: 820, y: 522, w: 140, h: 18, fill: '#1d4ed8' },
    ],
  },
  {
    id: 'navy', name: tt('深海蓝'), bg: '#0b1f3a', title: '#ffffff', text: '#dbe4f0', sub: '#94a3b8', accent: '#fbbf24',
    deco: [
      { shape: 'rect', x: 0, y: 0, w: 16, h: 540, fill: '#fbbf24' },
      { shape: 'rtriangle', x: 760, y: 340, w: 200, h: 200, fill: '#13325c', flip: 1 },
    ],
  },
  {
    id: 'dark', name: tt('暗夜黑'), bg: '#0d1117', title: '#f0f6fc', text: '#c9d1d9', sub: '#8b949e', accent: '#58a6ff',
    deco: [
      { shape: 'rect', x: 60, y: 504, w: 120, h: 6, fill: '#58a6ff' },
      { shape: 'rect', x: 188, y: 504, w: 40, h: 6, fill: '#3fb950' },
    ],
  },
  {
    id: 'green', name: tt('清新绿'), bg: '#f3faf5', title: '#14532d', text: '#1f3a2b', sub: '#4d7c5f', accent: '#4ade80',
    deco: [
      { shape: 'ellipse', x: 770, y: -150, w: 340, h: 340, fill: '#dcfce7' },
      { shape: 'ellipse', x: -90, y: 440, w: 200, h: 200, fill: '#bbf7d0' },
    ],
  },
  {
    id: 'warm', name: tt('暖阳橙'), bg: '#fff7ed', title: '#9a3412', text: '#431407', sub: '#9a5b3b', accent: '#fb923c',
    deco: [
      { shape: 'rect', x: 0, y: 506, w: 960, h: 34, fill: '#fed7aa' },
      { shape: 'ellipse', x: 890, y: 470, w: 44, h: 44, fill: '#f97316' },
    ],
  },
  {
    id: 'purple', name: tt('优雅紫'), bg: '#faf5ff', title: '#581c87', text: '#3b0764', sub: '#7e5a9b', accent: '#c084fc', font: 'serif',
    deco: [
      { shape: 'rtriangle', x: 0, y: 380, w: 220, h: 160, fill: '#ede9fe' },
      { shape: 'rect', x: 880, y: 0, w: 80, h: 8, fill: '#a855f7' },
    ],
  },
  {
    id: 'ocean', name: tt('海洋'), bg: '#ecfeff', title: '#155e75', text: '#164e63', sub: '#4b8494', accent: '#22d3ee',
    deco: [
      { shape: 'wave', x: 0, y: 450, w: 960, h: 90, fill: '#cffafe' },
      { shape: 'wave', x: 0, y: 490, w: 960, h: 50, fill: '#a5f3fc' },
    ],
  },
  {
    id: 'rose', name: tt('玫瑰'), bg: '#fff1f2', title: '#9f1239', text: '#4c0519', sub: '#9f5566', accent: '#fb7185',
    deco: [
      { shape: 'ellipse', x: -70, y: -70, w: 170, h: 170, fill: '#ffe4e6' },
      { shape: 'ellipse', x: 870, y: 450, w: 150, h: 150, fill: '#fecdd3' },
    ],
  },
  {
    id: 'mono', name: tt('极简灰'), bg: '#f6f8fa', title: '#24292f', text: '#24292f', sub: '#6e7781', accent: '#cf222e',
    deco: [{ shape: 'rect', x: 36, y: 40, w: 6, h: 64, fill: '#cf222e' }],
  },
  {
    id: 'chalk', name: tt('黑板'), bg: '#1f3b2d', title: '#fefce8', text: '#ecfccb', sub: '#b8c4a8', accent: '#facc15', font: 'kai',
    deco: [{ shape: 'frame', x: 0, y: 0, w: 960, h: 540, fill: '#6b4423', sw: 0 }],
  },
  {
    id: 'sun', name: tt('明黄'), bg: '#fefce8', title: '#713f12', text: '#422006', sub: '#8a6d3b', accent: '#facc15',
    deco: [
      { shape: 'rect', x: 0, y: 0, w: 960, h: 60, fill: '#fde047' },
      { shape: 'rect', x: 0, y: 60, w: 960, h: 4, fill: '#eab308' },
    ],
  },
];
const THEME_BY_ID = new Map(SLIDE_THEMES.map((t) => [t.id, t]));

/** 找不到就是「简洁白」。 @param {any} id @returns {SlideTheme} */
export const slideTheme = (id) => THEME_BY_ID.get(id) ?? SLIDE_THEMES[0];
/** @param {any} id */
export const isSlideTheme = (id) => typeof id === 'string' && THEME_BY_ID.has(id);

/** 主题的装饰元素（每次都是新 id）。 @param {SlideTheme} th */
export function themeDeco(th) {
  return th.deco.map((d) => ({ id: uid('e'), t: 'shape', deco: 1, ...d }));
}

/**
 * 新页的版式。文字颜色跟着主题走，role 用来换主题时认出谁是标题、谁是正文。
 * @param {'title'|'content'|'two'|'section'|'blank'} kind @param {SlideTheme | null} [th]
 */
export function layout(kind, th = null) {
  const c = th ?? SLIDE_THEMES[0];
  /** @param {any} o */
  const text = (o) => ({ id: uid('e'), t: 'text', runs: [], color: c.text, align: 'left', size: 22, ...o });
  const title = (/** @type {any} */ o = {}) => text({ x: 60, y: 36, w: 840, h: 80, size: 36, b: 1, ph: tt('标题'), role: 'title', color: c.title, ...o });
  if (kind === 'title') {
    return [
      text({ x: 80, y: 170, w: 800, h: 110, size: 48, b: 1, align: 'center', ph: tt('点击输入标题'), role: 'title', color: c.title }),
      text({ x: 80, y: 300, w: 800, h: 64, size: 24, align: 'center', color: c.sub, ph: tt('副标题'), role: 'sub' }),
    ];
  }
  if (kind === 'section') {
    return [
      text({ x: 80, y: 190, w: 800, h: 100, size: 44, b: 1, align: 'center', ph: tt('章节标题'), role: 'title', color: c.title }),
      text({ x: 80, y: 300, w: 800, h: 56, size: 22, align: 'center', color: c.sub, ph: tt('补充说明'), role: 'sub' }),
    ];
  }
  if (kind === 'content') return [title(), text({ x: 60, y: 136, w: 840, h: 360, ph: tt('正文内容'), role: 'body' })];
  if (kind === 'two') {
    return [title(),
      text({ x: 60, y: 136, w: 410, h: 360, ph: tt('左栏内容'), role: 'body' }),
      text({ x: 490, y: 136, w: 410, h: 360, ph: tt('右栏内容'), role: 'body' })];
  }
  return [];
}

/** 版式菜单。 */
export const LAYOUTS = /** @type {const} */ ([
  ['title', tt('标题页'), '🅣'],
  ['content', tt('标题和内容'), '☰'],
  ['two', tt('两栏内容'), '◫'],
  ['section', tt('节标题'), '§'],
  ['blank', tt('空白'), '▢'],
]);

/**
 * 给一页换主题：背景、装饰、按角色（或按旧主题的颜色）重新上色。直接改 sl。
 * @param {any} sl @param {SlideTheme} th @param {SlideTheme} old
 */
export function restyleSlide(sl, th, old) {
  sl.bg = th.bg;
  const els = (sl.els ?? []).filter((/** @type {any} */ e) => !e.deco);
  for (const e of els) {
    if (e.t !== 'text') continue;
    const role = e.role ?? (e.color === old.title ? 'title' : e.color === old.text ? 'body' : e.color === old.sub ? 'sub' : null);
    if (role === 'title') e.color = th.title;
    else if (role === 'sub') e.color = th.sub;
    else if (role === 'body') e.color = th.text;
  }
  sl.els = [...themeDeco(th), ...els].slice(0, 80);
}

/** 整份换主题。直接改 deck。 @param {any} deck @param {string} id */
export function applyTheme(deck, id) {
  const th = slideTheme(id), old = slideTheme(deck.theme);
  for (const sl of deck.slides ?? []) restyleSlide(sl, th, old);
  deck.theme = th.id;
  return deck;
}

// ── 幻灯片模板 ──────────────────────────────────────────────────────────────

/**
 * 每页 [版式, 第一个框, 第二个框, 第三个框]，依次填进版式里的文本框。
 * @type {{ id: string, name: string, icon: string, desc: string, slides: [string, string?, string?, string?][] }[]}
 */
export const DECK_TEMPLATES = [
  { id: 'blank', name: tt('空白演示'), icon: '▢', desc: tt('只有一页标题页，从零开始'), slides: [['title']] },
  {
    id: 'report', name: tt('工作汇报'), icon: '📈', desc: tt('周报、月报、季度汇报'),
    slides: [
      ['title', tt('工作汇报'), tt('汇报人 · 2026 年 X 月')],
      ['content', tt('目录'), tt('01  工作回顾\n02  成果与数据\n03  问题与改进\n04  下一步计划')],
      ['section', tt('01 工作回顾'), tt('这一阶段做了什么')],
      ['content', tt('重点工作'), tt('• 项目 A：完成需求评审与开发，已上线\n• 项目 B：完成 70%，预计下周交付\n• 日常支持：处理工单 42 个')],
      ['two', tt('成果与数据'), tt('关键指标\n• 用户数：12,000（+18%）\n• 转化率：3.4%（+0.6pt）'), tt('亮点\n• 首次实现周活破万\n• 客服响应时间缩短一半')],
      ['content', tt('问题与改进'), tt('• 问题：测试环境不稳定，影响联调\n  改进：申请独立环境，已排期\n• 问题：需求变更频繁\n  改进：引入需求冻结节点')],
      ['content', tt('下一步计划'), tt('1. 完成项目 B 上线\n2. 启动项目 C 的调研\n3. 整理本季度复盘文档')],
      ['section', tt('谢谢'), tt('欢迎提问与交流')],
    ],
  },
  {
    id: 'proposal', name: tt('项目提案'), icon: '💡', desc: tt('立项、方案评审、融资路演'),
    slides: [
      ['title', tt('项目名称'), tt('一句话说清楚这个项目要解决什么')],
      ['content', tt('背景与痛点'), tt('• 现状：……\n• 痛点一：……\n• 痛点二：……\n• 机会：市场规模 / 需求量')],
      ['content', tt('解决方案'), tt('• 核心思路：……\n• 关键功能：……\n• 和现有方案的区别：……')],
      ['two', tt('方案对比'), tt('现有方案\n• 成本高\n• 流程长\n• 难以扩展'), tt('我们的方案\n• 成本降低 40%\n• 一站式完成\n• 按需扩容')],
      ['content', tt('实施计划'), tt('第 1 阶段（1 个月）：调研与原型\n第 2 阶段（2 个月）：开发与内测\n第 3 阶段（1 个月）：上线与推广')],
      ['content', tt('资源与预算'), tt('• 人员：产品 1、开发 3、设计 1\n• 预算：约 XX 万元\n• 外部依赖：……')],
      ['content', tt('预期收益与风险'), tt('收益：……\n风险：……\n应对：……')],
      ['section', 'Q & A', tt('谢谢大家')],
    ],
  },
  {
    id: 'lesson', name: tt('教学课件'), icon: '🎓', desc: tt('课堂讲授、培训分享'),
    slides: [
      ['title', tt('课程名称'), tt('主讲人 · 第 X 课')],
      ['content', tt('学习目标'), tt('学完这节课，你将能够：\n1. 理解……的基本概念\n2. 掌握……的方法\n3. 能够独立完成……')],
      ['section', tt('第一部分'), tt('基本概念')],
      ['content', tt('知识点一'), tt('定义：……\n\n例子：……')],
      ['two', tt('知识点二'), tt('要点\n• ……\n• ……'), tt('常见误区\n• ……\n• ……')],
      ['content', tt('课堂练习'), tt('1. ……\n2. ……\n3. 思考题：……')],
      ['content', tt('本课小结'), tt('• 概念：……\n• 方法：……\n• 课后作业：……')],
    ],
  },
  {
    id: 'launch', name: tt('产品发布'), icon: '🚀', desc: tt('新品发布、功能介绍'),
    slides: [
      ['title', tt('产品名称'), tt('一句打动人的口号')],
      ['content', tt('用户的烦恼'), tt('• 每天要花 2 小时做重复工作\n• 数据散落在各处，找不到\n• 协作靠来回发文件')],
      ['section', tt('隆重介绍'), tt('产品名称 1.0')],
      ['two', tt('核心功能'), tt('⚡ 快\n打开即用，毫秒响应\n\n🔒 安全\n数据加密，权限可控'), tt('🤝 协作\n多人实时编辑\n\n📊 洞察\n图表、透视一键生成')],
      ['content', tt('价格与上市'), tt('• 免费版：个人使用\n• 专业版：XX 元 / 月\n• 即日起开放注册')],
      ['section', tt('谢谢'), tt('立即体验：example.com')],
    ],
  },
  {
    id: 'summary', name: tt('年终总结'), icon: '🏆', desc: tt('年度回顾与展望'),
    slides: [
      ['title', tt('2026 年度总结'), tt('部门 / 姓名')],
      ['content', tt('年度关键词'), tt('成长 · 突破 · 协作')],
      ['two', tt('年度成绩'), tt('业务\n• 目标完成率 112%\n• 新签客户 36 家'), tt('团队\n• 新成员 5 人\n• 内部分享 20 场')],
      ['content', tt('做得好的'), '• ……\n• ……\n• ……'],
      ['content', tt('需要改进的'), '• ……\n• ……'],
      ['content', tt('明年计划'), 'Q1：……\nQ2：……\nQ3：……\nQ4：……'],
      ['section', tt('感谢一路同行'), ''],
    ],
  },
];

/** 用模板和主题生成一整份幻灯片。 @param {typeof DECK_TEMPLATES[number]} tpl @param {string} themeId */
export function deckFromTemplate(tpl, themeId) {
  const th = slideTheme(themeId);
  const slides = tpl.slides.map(([kind, ...texts]) => {
    const els = layout(/** @type {any} */ (kind), th);
    els.forEach((e, i) => { if (texts[i]) e.runs = [[texts[i]]]; });
    return { id: uid('s'), bg: th.bg, els: [...themeDeco(th), ...els] };
  });
  return { ratio: '16:9', theme: th.id, slides };
}

// ── 文档主题 ────────────────────────────────────────────────────────────────

/**
 * 文档主题直接覆盖页面上的界面颜色变量，所以嵌入的表格、代码块、待办框也跟着变。
 * h1line：一级标题下面画线；h2bar：二级标题左边画竖条。
 * @typedef {{ id: string, name: string, bg?: string, text?: string, muted?: string, border?: string, subtle?: string,
 *   accent?: string, soft?: string, head?: string, font?: keyof typeof FONTS, hfont?: keyof typeof FONTS,
 *   h1line?: boolean, h2bar?: boolean }} DocTheme
 * @type {DocTheme[]}
 */
export const DOC_THEMES = [
  { id: 'default', name: tt('跟随界面') },
  { id: 'paper', name: tt('纸张'), bg: '#fffdf7', text: '#3b3a36', muted: '#77705f', border: '#e8e2d0', subtle: '#f6f1e3', accent: '#b45309', soft: '#fdf0dc', head: '#2b2a26', font: 'serif' },
  { id: 'business', name: tt('商务'), bg: '#ffffff', text: '#1e293b', muted: '#64748b', border: '#e2e8f0', subtle: '#f1f5f9', accent: '#1d4ed8', soft: '#dbeafe', head: '#0b3d91', h2bar: true },
  { id: 'academic', name: tt('学术'), bg: '#ffffff', text: '#222222', muted: '#666666', border: '#dddddd', subtle: '#f5f5f5', accent: '#8b1a1a', soft: '#f7e6e6', head: '#000000', font: 'serif', h1line: true },
  { id: 'fresh', name: tt('清新'), bg: '#f7fcf8', text: '#1f3a2b', muted: '#5b7a66', border: '#d5eadb', subtle: '#ecf7ef', accent: '#16a34a', soft: '#dcfce7', head: '#14532d', h2bar: true },
  { id: 'sepia', name: tt('护眼'), bg: '#f4ecd8', text: '#5b4636', muted: '#8a7560', border: '#e0d3b8', subtle: '#ece1c8', accent: '#a0522d', soft: '#ecd9c0', head: '#3e2f23' },
  { id: 'ink', name: tt('水墨'), bg: '#fafaf8', text: '#2d2d2d', muted: '#707070', border: '#e3e3de', subtle: '#f1f1ec', accent: '#c0392b', soft: '#f7e1de', head: '#111111', hfont: 'kai', h1line: true },
  { id: 'sakura', name: tt('樱花'), bg: '#fff8fa', text: '#4a2c36', muted: '#9a6b7a', border: '#f6dbe3', subtle: '#fdeef2', accent: '#db2777', soft: '#fce7f3', head: '#9d174d' },
  { id: 'night', name: tt('夜读'), bg: '#161b22', text: '#c9d1d9', muted: '#8b949e', border: '#30363d', subtle: '#0d1117', accent: '#58a6ff', soft: '#1f3a5f', head: '#f0f6fc' },
];
const DOC_THEME_BY_ID = new Map(DOC_THEMES.map((t) => [t.id, t]));

/** @param {any} id */
export const docTheme = (id) => DOC_THEME_BY_ID.get(id) ?? DOC_THEMES[0];
/** @param {any} id */
export const isDocTheme = (id) => typeof id === 'string' && id !== 'default' && DOC_THEME_BY_ID.has(id);

/** 主题会设置的全部 CSS 变量名（换主题时先全部清掉）。 */
export const DOC_VARS = ['--c-surface', '--c-text', '--c-text-muted', '--c-text-faint', '--c-border', '--c-border-strong',
  '--c-bg-subtle', '--c-bg-sunken', '--c-accent', '--c-accent-soft', '--c-on-accent', '--c-grid-line', '--c-grid-header',
  '--dt-head', '--dt-font', '--dt-hfont', '--dt-h1-line', '--dt-h1-pad', '--dt-h2-bar', '--dt-h2-pad'];

/** 主题 → [变量, 值]。「跟随界面」什么都不设。 @param {any} id @returns {[string, string][]} */
export function docThemeVars(id) {
  const t = docTheme(id);
  if (t.id === 'default') return [];
  /** @type {[string, string | undefined][]} */ const out = [
    ['--c-surface', t.bg], ['--c-text', t.text], ['--c-text-muted', t.muted], ['--c-text-faint', t.muted],
    ['--c-border', t.border], ['--c-border-strong', t.muted], ['--c-bg-subtle', t.subtle], ['--c-bg-sunken', t.subtle],
    ['--c-accent', t.accent], ['--c-accent-soft', t.soft], ['--c-on-accent', '#ffffff'],
    ['--c-grid-line', t.border], ['--c-grid-header', t.subtle], ['--dt-head', t.head],
  ];
  if (t.font && FONTS[t.font]) out.push(['--dt-font', FONTS[t.font]]);
  if (t.hfont && FONTS[t.hfont]) out.push(['--dt-hfont', FONTS[t.hfont]]);
  if (t.h1line) out.push(['--dt-h1-line', '2px solid ' + t.accent], ['--dt-h1-pad', '6px']);
  if (t.h2bar) out.push(['--dt-h2-bar', '4px solid ' + t.accent], ['--dt-h2-pad', '10px']);
  return /** @type {[string, string][]} */ (out.filter(([, v]) => v));
}

// ── 文档模板 ────────────────────────────────────────────────────────────────

/**
 * 每行一块，行首标记同 Markdown：# 标题、- 列表、1. 编号、[] 待办、> 引用、--- 分割线，其余是正文。
 * 行首的 **标签** 加粗。
 * @type {{ id: string, name: string, icon: string, desc: string, lines: string[] }[]}
 */
export const DOC_TEMPLATES = [
  {
    id: 'meeting', name: tt('会议纪要'), icon: '🗓️', desc: tt('议题、结论、待办一目了然'),
    lines: [
      tt('# 会议纪要：会议主题'),
      tt('**时间**：2026 年 X 月 X 日 14:00–15:00'),
      tt('**地点**：会议室 / 线上'),
      tt('**参会人**：张三、李四、王五'),
      tt('**记录人**：'),
      '---',
      tt('## 议题'),
      tt('1. 上周进展回顾'),
      tt('2. 本周重点讨论事项'),
      tt('3. 其它'),
      tt('## 讨论内容'),
      tt('### 议题一'),
      tt('- 观点 / 数据：'),
      tt('- 结论：'),
      tt('### 议题二'),
      tt('- 观点 / 数据：'),
      tt('- 结论：'),
      tt('## 结论与决定'),
      tt('> 把会上达成一致的事情写在这里，方便没参会的人快速了解。'),
      tt('## 待办事项'),
      tt('[] 事项一 —— 负责人 —— 截止日期'),
      tt('[] 事项二 —— 负责人 —— 截止日期'),
      tt('## 下次会议'),
      tt('时间待定。'),
    ],
  },
  {
    id: 'weekly', name: tt('周报'), icon: '📅', desc: tt('本周完成、下周计划、风险求助'),
    lines: [
      tt('# 周报（X 月 X 日 – X 月 X 日）'),
      tt('**姓名**：　　**部门**：'),
      tt('## 本周完成'),
      tt('- 工作一：进展与结果'),
      tt('- 工作二：进展与结果'),
      tt('## 关键数据'),
      tt('- 指标 A：'),
      tt('- 指标 B：'),
      tt('## 下周计划'),
      tt('[] 计划一'),
      tt('[] 计划二'),
      tt('## 风险与需要的支持'),
      '- ',
      tt('## 本周思考'),
      tt('一点心得或复盘。'),
    ],
  },
  {
    id: 'plan', name: tt('项目计划'), icon: '🗺️', desc: tt('目标、范围、里程碑、分工'),
    lines: [
      tt('# 项目计划：项目名称'),
      tt('> 一句话描述：这个项目要在什么时间、为谁、解决什么问题。'),
      tt('## 1. 背景'),
      tt('为什么要做这个项目。'),
      tt('## 2. 目标'),
      tt('- 业务目标：'),
      tt('- 衡量指标：'),
      tt('## 3. 范围'),
      tt('**包含**：'),
      tt('**不包含**：'),
      tt('## 4. 里程碑'),
      tt('1. 需求确认 —— X 月 X 日'),
      tt('2. 设计完成 —— X 月 X 日'),
      tt('3. 开发完成 —— X 月 X 日'),
      tt('4. 上线 —— X 月 X 日'),
      tt('## 5. 分工'),
      tt('- 负责人：'),
      tt('- 产品：'),
      tt('- 开发：'),
      tt('- 测试：'),
      tt('## 6. 风险'),
      tt('- 风险：　　应对：'),
    ],
  },
  {
    id: 'prd', name: tt('需求文档'), icon: '📐', desc: tt('背景、用户故事、功能与验收标准'),
    lines: [
      tt('# 需求文档：功能名称'),
      tt('**版本**：v1.0　　**作者**：　　**状态**：草稿'),
      '---',
      tt('## 背景与目标'),
      tt('要解决的问题、带来的价值。'),
      tt('## 用户故事'),
      tt('- 作为 ××，我希望 ××，以便 ××。'),
      tt('- 作为 ××，我希望 ××，以便 ××。'),
      tt('## 功能说明'),
      tt('### 功能一'),
      tt('描述、交互流程、边界情况。'),
      tt('### 功能二'),
      tt('描述、交互流程、边界情况。'),
      tt('## 验收标准'),
      tt('[] 标准一'),
      tt('[] 标准二'),
      tt('## 不做的事'),
      '- ',
      tt('## 待确认问题'),
      '1. ',
    ],
  },
  {
    id: 'reading', name: tt('读书笔记'), icon: '📚', desc: tt('书籍信息、摘录、感想'),
    lines: [
      tt('# 《书名》读书笔记'),
      tt('**作者**：　　**读完日期**：　　**评分**：★★★★☆'),
      tt('## 一句话总结'),
      tt('> 这本书讲了什么，最打动我的是什么。'),
      tt('## 主要观点'),
      '1. ',
      '2. ',
      '3. ',
      tt('## 精彩摘录'),
      tt('> “摘录的句子。”（第 X 页）'),
      tt('## 我的思考'),
      tt('和自己的经历有什么联系，打算怎样用起来。'),
      tt('## 行动清单'),
      '[] ',
    ],
  },
  {
    id: 'study', name: tt('学习笔记'), icon: '✏️', desc: tt('知识点、例题、疑问'),
    lines: [
      tt('# 学习笔记：主题'),
      tt('**日期**：　　**来源**：课程 / 书 / 视频'),
      tt('## 核心概念'),
      tt('- 概念一：'),
      tt('- 概念二：'),
      tt('## 详细笔记'),
      tt('正文。'),
      tt('## 例子'),
      '```',
      tt('## 疑问'),
      tt('[] 还没弄懂的地方'),
      tt('## 总结'),
      tt('用自己的话复述一遍。'),
    ],
  },
];

/** 代码块模板的占位文字（docFromTemplate 里 tt 被局部变量占用，所以放在外面）。 */
const CODE_PH = tt('代码或公式');

/** 模板 → 文档块（和 DocView._serialize 的格式一样）。 @param {typeof DOC_TEMPLATES[number]} tpl */
export function docFromTemplate(tpl) {
  /** @type {any[]} */ const blocks = [];
  for (const raw of tpl.lines) {
    const id = uid('b');
    if (raw === '---') { blocks.push({ id, t: 'hr' }); continue; }
    if (raw === '```') { blocks.push({ id, t: 'code', runs: [[CODE_PH]] }); continue; }
    const m = /^(#{1,3}) (.*)$/.exec(raw);
    /** @type {[string, string]} */ let tt;
    if (m) tt = ['h' + m[1].length, m[2]];
    else if (raw.startsWith('- ')) tt = ['ul', raw.slice(2)];
    else if (/^\d+\. /.test(raw)) tt = ['ol', raw.replace(/^\d+\. /, '')];
    else if (raw.startsWith('[] ')) tt = ['todo', raw.slice(3)];
    else if (raw.startsWith('> ')) tt = ['quote', raw.slice(2)];
    else tt = ['p', raw];
    const [t, text] = tt;
    /** @type {any[]} */ const runs = [];
    const b = /^\*\*(.+?)\*\*(.*)$/.exec(text);
    if (b) { runs.push([b[1], { b: 1 }]); if (b[2]) runs.push([b[2]]); }
    else if (text.trim()) runs.push([text]);
    blocks.push({ id, t, runs });
  }
  return blocks;
}
