/**
 * TableDO —— 每张表一个 Durable Object 实例。表内所有热数据的唯一权威。
 *
 * 为什么表内容不进 D1：D1 免费额度自 2026-09-01 起强制执行 **100K 行写入/天**。
 * 一个人连续编辑几小时就能打满。DO SQLite 的写入不计在那份额度里，而且 DO 是
 * 单线程的 —— 天然的串行化点，seq 单调递增，不需要任何分布式锁。
 *
 * 三条不能动的约束：
 *   1. 必须用 ctx.acceptWebSocket() 而不是 server.accept()。前者是 Hibernation API，
 *      空闲时 DO 可以被驱逐出内存且不计 duration 费用 —— 实时协同能跑在免费套餐里
 *      全靠这一点。
 *   2. nonce 防重放记在自己的 SQLite 里，不用 KV（KV 免费额度只有 1000 写/天）。
 *   3. 身份只认 Worker 验签后透传的请求头，绝不读客户端自报的字段。
 *
 * 状态是**物化**的：cells / fields / row_meta 三张表随时就是当前值，
 * oplog 只用来给「断线一小会儿」的客户端补齐增量。所以 oplog 可以随便裁，
 * 裁过头了客户端重新拉一次全量即可，数据永远不会因此丢失。
 */

import { normalizeOps, coalesce, isStructural, LIMITS, PROP_KEYS } from '../../public/shared/model/ops.js';
import { t } from '../../public/shared/i18n/i18n.js';
import { uid } from '../../public/shared/util/uid.js';
import { structuralSpec, adjustProps, adjustCellText } from '../../public/shared/model/sheet.js';
import { Engine, isFormula } from '../../public/shared/formula/evaluate.js';
import { parseRange, tooBig, packValue, unpackRange } from '../../public/shared/formula/extref.js';
import { ERR } from '../../public/shared/formula/values.js';
import { AxisMap } from './axismap.js';

/**
 * v5：一行表格一条记录（rows），行 / 列有稳定键（AxisMap），oplog 改成定长环形表。
 * 为什么：DO SQLite 免费额度是全账号 10 万行写入/天。实测（wrangler dev，cursor.rowsWritten）：
 * AUTOINCREMENT 每次插入写 2 行、普通主键 1 行；一条 UPDATE 不论值多大都是 1 行；
 * 旧结构下插一行要把下面每个格子的主键改两遍。见 docs 里的对比表。
 */
const SCHEMA_VERSION = 5;
/** 免费套餐每天的 DO 写入行数（UTC 0 点重置 = 北京时间 08:00） */
export const DAILY_WRITE_QUOTA = 100000;
/** 一批改动估计要写多少行以上才算「大批量」：快到额度时只拦这种，小修改永远放行 */
const BULK_WRITES = 200;
/** 映射表段数超过这个就重排一次键（很少发生：每次插入 / 删除只多一两段） */
const COMPACT_SEGS = 2000;
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;
const utcDay = () => new Date().toISOString().slice(0, 10);

/** 迁移校验用：与顺序无关的内容摘要（每个字符串的 FNV-1a 相加，模 2^32） @param {number} sum @param {string} s */
function mix(sum, s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (sum + (h >>> 0)) >>> 0;
}
const NONCE_RETENTION_MS = 5 * 60 * 1000;
/** oplog 保留多少条。够覆盖几分钟的断网；再久就让客户端重拉全量。 */
const OPLOG_KEEP = 3000;
/** oplog 的总体积上限（字节）。 */
const OPLOG_MAX_BYTES = 16 * 1024 * 1024;
/** 多久做一次维护（裁 oplog + 回写 D1 的行数）。 */
const MAINTENANCE_MS = 60 * 1000;
/** 全量快照按多少个单元格一段流式输出，避免在 DO 内存里攒出一个巨型字符串。 */
const STREAM_CHUNK = 2000;
/**
 * 附件直接存在本表 DO 的 SQLite 里 —— 不用 R2（R2 要绑信用卡才能开通）。
 * DO SQLite 单个值上限 2MB，所以文件切成 1MB 一块存；下载时逐块流式读出。
 */
const FILE_CHUNK = 1024 * 1024;
/** 单个附件上限。整个文件要在 DO 内存里过一遍，10MB 对 128MB 内存绰绰有余。 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** 单表附件总量上限。免费套餐整个账号共 5GB DO 存储，给每张表设个天花板。 */
export const MAX_TABLE_FILE_BYTES = 200 * 1024 * 1024;
/** 没有任何单元格引用的附件保留多久再清理。留足时间给「删掉又撤销」。 */
const FILE_GRACE_MS = 3 * 24 * 3600 * 1000;
/** 可以在浏览器里直接内联显示的类型；其余一律按下载处理，杜绝上传 HTML/SVG 做 XSS。 */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);

/** @param {string | null} v */
function safeDecode(v) {
  if (!v) return '';
  try { return decodeURIComponent(v).slice(0, 80); } catch { return ''; }
}

export class TableDO {
  /** @param {DurableObjectState} ctx @param {any} env */
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    const raw = ctx.storage.sql;
    /** 写入计数：本对象存活期间写过的总行数，以及还没记进 oplog / 没上报的零散写入 */
    this._wTotal = 0;
    this._wLoose = 0;
    /** 最近一次从 D1 拿到的「今天全站已用」，以及之后本 DO 又写了多少 */
    this._usage = /** @type {{ day: string, rows: number, at: number } | null} */ (null);
    this._sinceUsage = 0;
    // 所有 SQL 都过这一层：写语句立即取完结果，把 rowsWritten 记下来。读语句原样返回游标（流式）。
    this.sql = {
      exec: (/** @type {string} */ q, /** @type {any[]} */ ...binds) => {
        const cur = raw.exec(q, ...binds);
        if (!WRITE_RE.test(q)) return cur;
        const rows = typeof cur.toArray === 'function' ? cur.toArray() : [...cur];
        const w = Number(cur.rowsWritten ?? 0);
        this._wTotal += w; this._wLoose += w; this._sinceUsage += w;
        return rows;
      },
    };
    /** 迁移失败或额度不够时：只读，数据还在旧表里 */
    this._legacy = false;
    this.rows = new AxisMap();
    this.cols = new AxisMap();
    this._seq = 0;
    this._seqFloor = 0;
    /** 列删除后 _cellCount 只是上界（里面可能含已删列的残留），真快到上限时才重新精确数 */
    this._countStale = false;
    /** 非空单元格计数的内存缓存。COUNT(*) 是 O(n)，不能放在写入热路径上。 */
    this._cellCount = /** @type {number | null} */ (null);
    /** 最近一次结构性 op 的 seq。客户端 baseSeq 早于它就必须重拉。 */
    this._structuralSeq = 0;
    /** 行数/列数在内存里留一份。它们在每个单元格的写入路径上都要读，
     *  每次都去查 meta 表的话，一次 2 万格的粘贴就是 4 万次多余查询。 */
    this._rowCount = 500;
    this._colCount = 26;

    ctx.blockConcurrencyWhile(async () => this._migrate());
  }

  // ── 存储 ────────────────────────────────────────────────────────────────

  async _migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS used_nonce (nonce TEXT PRIMARY KEY, used_at INTEGER NOT NULL);
    `);
    const version = Number(this._meta('schema_version') ?? 0);

    if (version === 0) {
      // 全新的表：直接建 v5，不再经过旧结构
      this._createV5();
      this._createFiles();
      this._setMeta('schema_version', String(SCHEMA_VERSION));
    } else {
      if (version < 4) this._migrateOld(version);
      if (version < 5 && !(await this._upgradeV5())) this._enterLegacy();
    }
    this._load();
  }

  /** 读出内存里的状态（构造时、升级成功后各一次） */
  _load() {
    this._rowCount = Number(this._meta('row_count') ?? 500);
    this._colCount = Number(this._meta('col_count') ?? 26);
    this._structuralSeq = Number(this._meta('structural_seq') ?? 0);
    if (this._legacy) {
      this._seq = Number([...this.sql.exec('SELECT COALESCE(MAX(seq), 0) AS s FROM oplog')][0]?.s ?? 0);
      return;
    }
    const map = (/** @type {string} */ k) => { const v = this._meta(k); return new AxisMap(v ? JSON.parse(v) : null); };
    this.rows = map('rowmap');
    this.cols = map('colmap');
    this._seqFloor = Number(this._meta('seq_floor') ?? 0);
    const top = Number([...this.sql.exec('SELECT COALESCE(MAX(seq), 0) AS s FROM ops_ring')][0]?.s ?? 0);
    this._seq = Math.max(this._seqFloor, top);
    this._cellCount = null;
  }

  _createV5() {
    this.sql.exec(`
      CREATE TABLE rows (
        k     INTEGER PRIMARY KEY,
        cells TEXT NOT NULL,
        fmts  TEXT NOT NULL,
        h     INTEGER
      );
      CREATE TABLE cols (
        k     INTEGER PRIMARY KEY,
        name  TEXT NOT NULL,
        width INTEGER NOT NULL
      );
      CREATE TABLE ops_ring (
        slot     INTEGER PRIMARY KEY,
        seq      INTEGER NOT NULL,
        actor_id TEXT,
        op_json  TEXT,
        ts       INTEGER NOT NULL,
        w        INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  _createFiles() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        chunks     INTEGER NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS file_chunks (
        id   TEXT NOT NULL,
        idx  INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (id, idx)
      );
    `);
  }

  /** 旧版 v1→v4 的步骤，原样保留（线上的表都已经是 v4） @param {number} version */
  _migrateOld(version) {
    if (version < 2) {
      // v1 是 P0 留下的占位表，从未写入过数据，直接丢掉重建。
      // 之所以敢 DROP：P1 的数据只在浏览器内存里，线上不存在任何真实表内容。
      this.sql.exec(`
        DROP TABLE IF EXISTS rows;
        DROP TABLE IF EXISTS cells;
        DROP TABLE IF EXISTS oplog;

        CREATE TABLE cells (
          r INTEGER NOT NULL,
          c INTEGER NOT NULL,
          v TEXT NOT NULL,
          PRIMARY KEY (r, c)
        ) WITHOUT ROWID;

        CREATE TABLE fields (
          c     INTEGER PRIMARY KEY,
          id    TEXT NOT NULL,
          name  TEXT NOT NULL,
          width INTEGER NOT NULL
        );

        CREATE TABLE row_meta (
          r      INTEGER PRIMARY KEY,
          id     TEXT NOT NULL,
          height INTEGER NOT NULL
        );

        CREATE TABLE oplog (
          seq      INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_id TEXT,
          op_json  TEXT NOT NULL,
          ts       INTEGER NOT NULL
        );
      `);
      this._setMeta('schema_version', '2');
    }

    if (version < 3) {
      // v3：单元格样式。表属性（合并、条件格式……）放 meta 表的 prop:* 键里，不另建表。
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS formats (
          r INTEGER NOT NULL,
          c INTEGER NOT NULL,
          f TEXT NOT NULL,
          PRIMARY KEY (r, c)
        ) WITHOUT ROWID;
      `);
      this._setMeta('schema_version', '3');
    }

    if (version < 4) {
      // v4：附件。元数据一张表，内容按 1MB 切块另存一张表。
      this._createFiles();
      this._setMeta('schema_version', '4');
    }
  }

  /**
   * v4 → v5。整个过程在一个事务里：复制、逐项校验，任何一项对不上就抛错回滚，
   * 表保持 v4 原样（只读），下次再试。旧表（cells / formats / row_meta / fields / oplog）
   * 一律不删，等新结构在线上跑稳了再单独清理（DROP TABLE 实测 0 行写入）。
   * @returns {Promise<boolean>}
   */
  async _upgradeV5() {
    // 迁移大约每个有数据的行写 1 行。今天额度已经不够就先别动，等 UTC 0 点重置后再做。
    const r = [...this.sql.exec('SELECT MIN(r) AS lo, MAX(r) AS hi FROM cells')][0];
    const est = (r?.hi == null ? 0 : Number(r.hi) - Number(r.lo) + 1) + 50;
    const used = await this._fetchUsage();
    if (used != null && used + est > DAILY_WRITE_QUOTA * 0.98) {
      console.warn('今日写入额度不够完成存储升级，暂时只读', used, est);
      return false;
    }
    const w0 = this._wLoose;
    try {
      this.ctx.storage.transactionSync(() => this._copyV5());
    } catch (err) {
      console.error('v5 存储升级失败，已回滚，暂时只读', err);
      this._wLoose = w0;
      return false;
    }
    // 迁移写了多少行记在 meta 里，alarm 时一并报给 D1
    const moved = this._wLoose - w0;
    this._wLoose = w0;
    this._setMeta('usage_pending', String(moved));
    this._legacy = false;
    this._scheduleMaintenance();
    return true;
  }

  /** 复制 + 校验。只在 transactionSync 里调用。 */
  _copyV5() {
    // 新表若是上次失败留下的（事务回滚后本不该有），先清掉；旧数据全在 cells 等表里，不受影响
    this.sql.exec('DROP TABLE IF EXISTS rows; DROP TABLE IF EXISTS cols; DROP TABLE IF EXISTS ops_ring;');
    this._createV5();

    const lohi = (/** @type {string} */ t) => [...this.sql.exec(`SELECT MIN(r) AS lo, MAX(r) AS hi FROM ${t}`)][0];
    let lo = Infinity, hi = -Infinity;
    for (const t of ['cells', 'formats', 'row_meta']) {
      const x = lohi(t);
      if (x?.lo != null) { lo = Math.min(lo, Number(x.lo)); hi = Math.max(hi, Number(x.hi)); }
    }

    // 旧数据边读边算校验和；写完再从新表读一遍算一次，两边必须一致
    const old = { n: 0, f: 0, h: 0, sum: 0 };
    const BLOCK = 500;
    for (let r0 = lo; r0 <= hi; r0 += BLOCK) {
      const r1 = r0 + BLOCK - 1;
      /** @type {Map<number, { cells: any, fmts: any, h: number | null }>} */ const acc = new Map();
      const get = (/** @type {number} */ r) => {
        let o = acc.get(r);
        if (!o) acc.set(r, o = { cells: {}, fmts: {}, h: null });
        return o;
      };
      for (const x of this.sql.exec('SELECT r, c, v FROM cells WHERE r BETWEEN ? AND ?', r0, r1)) {
        const v = String(x.v);
        get(Number(x.r)).cells[Number(x.c)] = v;
        old.n++; old.sum = mix(old.sum, 'c' + x.r + ',' + x.c + ',' + v);
      }
      for (const x of this.sql.exec('SELECT r, c, f FROM formats WHERE r BETWEEN ? AND ?', r0, r1)) {
        const fo = JSON.parse(String(x.f));     // 坏 JSON 直接抛 → 回滚
        get(Number(x.r)).fmts[Number(x.c)] = fo;
        old.f++; old.sum = mix(old.sum, 'f' + x.r + ',' + x.c + ',' + JSON.stringify(fo));
      }
      for (const x of this.sql.exec('SELECT r, height FROM row_meta WHERE r BETWEEN ? AND ?', r0, r1)) {
        get(Number(x.r)).h = Number(x.height);
        old.h++; old.sum = mix(old.sum, 'h' + x.r + ',' + x.height);
      }
      for (const [k, o] of acc) {
        this.sql.exec('INSERT INTO rows (k, cells, fmts, h) VALUES (?, ?, ?, ?)', k, JSON.stringify(o.cells), JSON.stringify(o.fmts), o.h);
      }
    }
    this.sql.exec('INSERT INTO cols (k, name, width) SELECT c, name, width FROM fields');

    // ① 数量：用 COUNT 从旧表独立数一遍，防止上面的分块漏了哪一段
    const count = (/** @type {string} */ q) => Number([...this.sql.exec(q)][0]?.n ?? 0);
    const want = { n: count('SELECT COUNT(*) AS n FROM cells'), f: count('SELECT COUNT(*) AS n FROM formats'), h: count('SELECT COUNT(*) AS n FROM row_meta') };
    if (want.n !== old.n || want.f !== old.f || want.h !== old.h) throw new Error('迁移校验失败：分块读取的数量与旧表不一致');
    // ② 内容：从新表读回来
    const got = { n: 0, f: 0, h: 0, sum: 0 };
    for (const x of this.sql.exec('SELECT k, cells, fmts, h FROM rows')) {
      const cells = JSON.parse(String(x.cells)), fmts = JSON.parse(String(x.fmts));
      for (const c in cells) { got.n++; got.sum = mix(got.sum, 'c' + x.k + ',' + c + ',' + cells[c]); }
      for (const c in fmts) { got.f++; got.sum = mix(got.sum, 'f' + x.k + ',' + c + ',' + JSON.stringify(fmts[c])); }
      if (x.h != null) { got.h++; got.sum = mix(got.sum, 'h' + x.k + ',' + x.h); }
    }
    if (got.n !== old.n || got.f !== old.f || got.h !== old.h || got.sum !== old.sum) throw new Error('迁移校验失败：新表内容与旧表不一致');
    const fields = (/** @type {string} */ q) => [...this.sql.exec(q)].map((x) => x.k + ',' + x.name + ',' + x.width).join('|');
    if (fields('SELECT c AS k, name, width FROM fields ORDER BY c') !== fields('SELECT k, name, width FROM cols ORDER BY k')) {
      throw new Error('迁移校验失败：列信息不一致');
    }

    // seq 接着旧 oplog 往下编。旧 oplog 不复制：升级后客户端重连，落后的就重拉全量
    const top = Number([...this.sql.exec('SELECT COALESCE(MAX(seq), 0) AS s FROM oplog')][0]?.s ?? 0);
    this._setMeta('seq_floor', String(top));
    this._setMeta('schema_version', String(SCHEMA_VERSION));
  }

  /** 升级没做成：保持只读，一小时后 alarm 再试 */
  _enterLegacy() {
    this._legacy = true;
    this.ctx.waitUntil((async () => {
      if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    })());
  }

  /** 今天全站 DO 写入行数（估算，来自各 DO 在 alarm 里的上报）。拿不到返回 null。 */
  async _fetchUsage() {
    if (!this.env?.DB) return null;
    try {
      const day = utcDay();
      const row = await this.env.DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind('do_usage:' + day).first();
      this._usage = { day, rows: Number(row?.value ?? 0), at: Date.now() };
      this._sinceUsage = 0;
      return this._usage.rows;
    } catch { return null; }
  }

  /** 今天已用多少（D1 上的数 + 本 DO 之后又写的）；日期变了或不知道时返回 null */
  _usedToday() {
    if (!this._usage || this._usage.day !== utcDay()) return null;
    return this._usage.rows + this._sinceUsage;
  }

  /** @param {string} k @returns {string | null} */
  _meta(k) {
    const row = [...this.sql.exec('SELECT value FROM meta WHERE key = ?', k)][0];
    return row ? String(row.value) : null;
  }

  /** @param {string} k @param {string} v */
  _setMeta(k, v) {
    this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?', k, v, v);
  }

  get rowCount() { return this._rowCount; }
  get colCount() { return this._colCount; }

  /** @param {number} n */
  _setRowCount(n) {
    const v = Math.max(1, Math.min(LIMITS.MAX_ROWS, n));
    if (v === this._rowCount) return;
    this._rowCount = v;
    this._setMeta('row_count', String(v));
  }

  /** @param {number} n */
  _setColCount(n) {
    const v = Math.max(1, Math.min(LIMITS.MAX_COLS, n));
    if (v === this._colCount) return;
    this._colCount = v;
    this._setMeta('col_count', String(v));
  }

  currentSeq() { return this._seq; }

  /** 非空单元格数。只在第一次需要时扫一遍（只读），之后增量维护。 */
  cellCount() {
    if (this._cellCount == null) {
      let n = 0;
      for (const x of this.sql.exec('SELECT cells FROM rows')) n += this._liveCount(JSON.parse(String(x.cells)));
      this._cellCount = n;
      this._countStale = false;
    }
    return this._cellCount;
  }

  /** 一行里还在映射表上的格子数（已删列的残留不算） @param {Record<string, any>} obj */
  _liveCount(obj) {
    let n = 0;
    for (const ck in obj) if (this.cols.indexOf(Number(ck)) >= 0) n++;
    return n;
  }

  /** @param {number} k @returns {{ cells: Record<string, string>, fmts: Record<string, any>, h: number | null, fresh: boolean }} */
  _row(k) {
    const x = [...this.sql.exec('SELECT cells, fmts, h FROM rows WHERE k = ?', k)][0];
    if (!x) return { cells: {}, fmts: {}, h: null, fresh: true };
    return { cells: JSON.parse(String(x.cells)), fmts: JSON.parse(String(x.fmts)), h: x.h == null ? null : Number(x.h), fresh: false };
  }

  /** 整行写回（1 行写入）。顺手丢掉已删列的残留；空行直接删掉记录。 @param {number} k @param {ReturnType<TableDO['_row']>} row */
  _putRow(k, row) {
    for (const o of [row.cells, row.fmts]) for (const ck in o) if (this.cols.indexOf(Number(ck)) < 0) delete o[ck];
    let empty = row.h == null;
    if (empty) for (const _ in row.cells) { empty = false; break; }
    if (empty) for (const _ in row.fmts) { empty = false; break; }
    if (empty) {
      if (!row.fresh) this.sql.exec('DELETE FROM rows WHERE k = ?', k);
      return;
    }
    this.sql.exec(
      'INSERT INTO rows (k, cells, fmts, h) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET cells = excluded.cells, fmts = excluded.fmts, h = excluded.h',
      k, JSON.stringify(row.cells), JSON.stringify(row.fmts), row.h,
    );
  }

  /** 按行分组。@param {[number, number, any][]} cells @returns {Map<number, [number, any][]>} */
  static _byRow(cells) {
    /** @type {Map<number, [number, any][]>} */ const m = new Map();
    for (const [r, c, v] of cells) {
      const l = m.get(r);
      if (l) l.push([c, v]); else m.set(r, [[c, v]]);
    }
    return m;
  }

  /** 这批改动大概要写多少行 @param {any[]} ops */
  _estimateWrites(ops) {
    let w = ops.length;
    for (const op of ops) {
      if (op.t === 'setCells' || op.t === 'setFormats') w += TableDO._byRow(op.cells).size;
      else if (op.t === 'clearAll') w += Number([...this.sql.exec('SELECT COUNT(*) AS n FROM rows')][0]?.n ?? 0);
      else if (isStructural(op)) w += 20;
    }
    return w;
  }

  // ── op 应用 ─────────────────────────────────────────────────────────────

  /**
   * 权威地应用一批 op。调用方必须**先**校验过权限。
   * DO 是单线程的，所以这里不需要事务包裹也不会有交错写入。
   * @param {any[]} ops 已经 normalize 过的 op
   * @param {string} actorId
   * @returns {{ seq: number, ops: any[] } | { error: string, code?: string }}
   */
  applyOps(ops, actorId) {
    if (this._legacy) {
      return { error: t('这张表正在升级存储结构，暂时只能查看；北京时间 08:00 额度重置后会自动完成'), code: 'upgrading' };
    }
    const merged = coalesce(ops);
    if (!merged.length) return { seq: this._seq, ops: merged };

    // 先算容量，再写一个字。半途撑爆比一开始就拒绝难处理得多。
    // 这里按「全是新格」估算（不去逐格查是否已存在 —— 那是每格一次查询）。
    // 估高了只会让上限提前一点点生效，而上限本身是 200 万格的安全阀，不是精确配额。
    let added = 0;
    for (const op of merged) if (op.t === 'setCells') added += op.cells.length;
    if (this.cellCount() + added > LIMITS.MAX_CELLS && this._countStale) this._cellCount = null;   // 上界可能虚高：精确数一次
    if (this.cellCount() + added > LIMITS.MAX_CELLS) {
      return { error: t('这张表的单元格数量已达上限（{n}）', { n: LIMITS.MAX_CELLS.toLocaleString() }) };
    }

    // 快到全账号每日写入额度时，只拦大批量改动；小修改照常放行
    const est = this._estimateWrites(merged);
    const used = est > BULK_WRITES ? this._usedToday() : null;
    if (used != null && used + est > DAILY_WRITE_QUOTA * 0.95) {
      return {
        code: 'quota',
        error: t('今天的存储写入额度快用完了（已用约 {used}k / 100k），这次改动较大（约 {est} 行）。请在北京时间 08:00 额度重置后再做；小的修改不受影响。', { used: Math.round(used / 1000), est }),
      };
    }

    const w0 = this._wLoose;
    for (const op of merged) this._applyOne(op);

    const last = this._seq + merged.length;
    if (merged.some(isStructural)) {
      this._structuralSeq = last;
      this._setMeta('structural_seq', String(last));
    }

    // oplog 是定长环：slot = seq % OPLOG_KEEP，覆盖写 1 行，不用 AUTOINCREMENT（它每次多写 1 行），
    // 也不用再单独删旧行。这批一共写了多少行记在最后一条上，alarm 时汇总上报。
    const w = this._wLoose - w0 + merged.length;
    const ts = Date.now();
    merged.forEach((op, i) => {
      const seq = ++this._seq;
      this.sql.exec(
        `INSERT INTO ops_ring (slot, seq, actor_id, op_json, ts, w) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(slot) DO UPDATE SET seq = excluded.seq, actor_id = excluded.actor_id,
             op_json = excluded.op_json, ts = excluded.ts, w = excluded.w`,
        seq % OPLOG_KEEP, seq, actorId, JSON.stringify(op), ts, i === merged.length - 1 ? w : 0,
      );
    });
    this._wLoose = w0;

    this._scheduleMaintenance();
    return { seq: this._seq, ops: merged };
  }

  /** @param {any} op */
  _applyOne(op) {
    switch (op.t) {
      case 'setCells': case 'setFormats': {
        // 同一行的格子合成一次整行写入：粘贴 1000 行 × 20 列 = 1000 行写入，而不是 2 万
        const isFmt = op.t === 'setFormats';
        let maxR = 0, maxC = 0, dn = 0;
        /** @type {Map<number, number>} */ const ck = new Map();
        const colKey = (/** @type {number} */ c) => { let k = ck.get(c); if (k === undefined) ck.set(c, k = this.cols.keyAt(c)); return k; };
        for (const [r, list] of TableDO._byRow(op.cells)) {
          const k = this.rows.keyAt(r);
          const row = this._row(k);
          const obj = isFmt ? row.fmts : row.cells;
          let changed = false;
          for (const [c, v] of list) {
            const key = colKey(c);
            const had = Object.hasOwn(obj, key);
            if (isFmt ? !v : v === '') {
              if (had) { delete obj[key]; changed = true; dn--; }
            } else {
              if (!had) dn++;
              obj[key] = v; changed = true;
            }
            if (c >= maxC) maxC = c;
          }
          if (r >= maxR) maxR = r;
          if (changed) this._putRow(k, row);          // 清空一片本来就空的格子：0 写入
        }
        // 写入可以落在当前边界之外（粘贴一块超出表尾的数据），表跟着长
        if (maxR + 1 > this._rowCount) this._setRowCount(maxR + 1);
        if (maxC + 1 > this._colCount) this._setColCount(maxC + 1);
        if (!isFmt && this._cellCount != null) this._cellCount += dn;
        return;
      }

      case 'resizeField':
        this.sql.exec('INSERT INTO cols (k, name, width) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET width = excluded.width',
          this.cols.keyAt(op.c), '', op.w);
        return;

      case 'renameField':
        this.sql.exec('INSERT INTO cols (k, name, width) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET name = excluded.name',
          this.cols.keyAt(op.c), op.name, 104);
        return;

      case 'setRowHeight': {
        const k = this.rows.keyAt(op.r);
        const row = this._row(k);
        row.h = op.h;
        this._putRow(k, row);
        return;
      }

      case 'addRows': this._setRowCount(this._rowCount + op.n); return;
      case 'addCols': this._setColCount(this._colCount + op.n); return;
      case 'setRowCount': this._setRowCount(op.n); return;
      case 'setColCount': this._setColCount(op.n); return;

      case 'clearAll':
        this.sql.exec('DELETE FROM rows');
        this._cellCount = 0;
        this._countStale = false;
        return;

      case 'setProp':
        if (op.value == null) this.sql.exec('DELETE FROM meta WHERE key = ?', 'prop:' + op.key);
        else this._setMeta('prop:' + op.key, JSON.stringify(op.value));
        return;

      case 'insertRows': case 'deleteRows': case 'insertCols': case 'deleteCols':
        this._structural(op);
        return;

      default:
        // normalizeOps 已经过滤过，走到这里说明两端版本不一致 —— 宁可忽略也不要崩
        console.warn('TableDO: 未知 op', op.t);
    }
  }

  /**
   * 插入 / 删除行列。规则与浏览器端 GridModel 共用 shared/model/sheet.js。
   * 数据的键不动，只改映射表（meta 里一个值，1 行写入）。以前是把后面每个格子的主键挪两遍。
   * @param {any} op
   */
  _structural(op) {
    const { axis, at, n } = /** @type {any} */ (structuralSpec(op));
    const isRow = axis === 'row';
    const map = isRow ? this.rows : this.cols;
    const limit = isRow ? LIMITS.MAX_ROWS : LIMITS.MAX_COLS;

    // ① 公式改写：全表所有公式都可能引用到被挪动的区域。只重写真的变了的行。
    for (const x of [...this.sql.exec(`SELECT k, cells FROM rows WHERE cells LIKE '%"=%'`)]) {
      const cells = JSON.parse(String(x.cells));
      let changed = false;
      for (const ck in cells) {
        const v = cells[ck];
        const nv = adjustCellText(v, axis, at, n);
        if (nv !== v) { cells[ck] = nv; changed = true; }
      }
      if (changed) this.sql.exec('UPDATE rows SET cells = ? WHERE k = ?', JSON.stringify(cells), x.k);
    }

    // ② 映射。插入后被挤出上限的那几行 / 列和以前一样丢掉。
    const gone = n > 0 ? (map.insert(at, n), map.delete(limit, n)) : map.delete(at, -n);
    for (const [a, b] of gone) {
      if (isRow) {
        if (this._cellCount != null) {
          for (const x of this.sql.exec('SELECT cells FROM rows WHERE k BETWEEN ? AND ?', a, b)) this._cellCount -= this._liveCount(JSON.parse(String(x.cells)));
        }
        this.sql.exec('DELETE FROM rows WHERE k BETWEEN ? AND ?', a, b);
      } else {
        // 已删列的格子留在各行的 JSON 里，映射表上已经找不到它们，看不见；那一行下次被写时顺手清掉
        this.sql.exec('DELETE FROM cols WHERE k BETWEEN ? AND ?', a, b);
        this._countStale = true;
      }
    }
    if (map.segs.length > COMPACT_SEGS) this._compact(axis);
    else this._saveMap(axis);

    // ③ 表属性
    const changed = adjustProps(this._props(), axis, at, n);
    for (const [k, v] of Object.entries(changed)) this._applyOne({ t: 'setProp', key: k, value: v });

    if (axis === 'row') this._setRowCount(this._rowCount + n);
    else this._setColCount(this._colCount + n);
  }

  /** @param {'row' | 'col'} axis */
  _saveMap(axis) {
    const map = axis === 'row' ? this.rows : this.cols;
    const key = axis === 'row' ? 'rowmap' : 'colmap';
    if (map.isIdentity()) this.sql.exec('DELETE FROM meta WHERE key = ?', key);
    else this._setMeta(key, JSON.stringify(map));
  }

  /**
   * 映射表段数太多时把键重排成 0..n-1（恒等映射）。很少发生；代价是每个有数据的行写 1 行。
   * 行：建新表按序号重新插入，再换名（DROP 不计写入）。列：改写每行 JSON 里的列键。
   * @param {'row' | 'col'} axis
   */
  _compact(axis) {
    this.ctx.storage.transactionSync(() => {
      if (axis === 'row') {
        this.sql.exec('CREATE TABLE rows_new (k INTEGER PRIMARY KEY, cells TEXT NOT NULL, fmts TEXT NOT NULL, h INTEGER)');
        for (const [a, b, i0] of this.rows.ranges(0, LIMITS.MAX_ROWS)) {
          for (const x of [...this.sql.exec('SELECT k, cells, fmts, h FROM rows WHERE k BETWEEN ? AND ?', a, b)]) {
            this.sql.exec('INSERT INTO rows_new (k, cells, fmts, h) VALUES (?, ?, ?, ?)', i0 + (Number(x.k) - a), x.cells, x.fmts, x.h);
          }
        }
        this.sql.exec('DROP TABLE rows');
        this.sql.exec('ALTER TABLE rows_new RENAME TO rows');
        this.rows = new AxisMap();
      } else {
        const re = (/** @type {Record<string, any>} */ o) => {
          /** @type {Record<string, any>} */ const out = {};
          for (const ck in o) { const c = this.cols.indexOf(Number(ck)); if (c >= 0) out[c] = o[ck]; }
          return out;
        };
        for (const x of [...this.sql.exec('SELECT k, cells, fmts FROM rows')]) {
          this.sql.exec('UPDATE rows SET cells = ?, fmts = ? WHERE k = ?', JSON.stringify(re(JSON.parse(String(x.cells)))), JSON.stringify(re(JSON.parse(String(x.fmts)))), x.k);
        }
        const cols = [...this.sql.exec('SELECT k, name, width FROM cols')];
        this.sql.exec('DELETE FROM cols');
        for (const x of cols) {
          const c = this.cols.indexOf(Number(x.k));
          if (c >= 0) this.sql.exec('INSERT INTO cols (k, name, width) VALUES (?, ?, ?)', c, x.name, x.width);
        }
        this.cols = new AxisMap();
        this._countStale = false;
        this._cellCount = null;
      }
      this._saveMap(axis);
    });
  }

  /** @returns {Record<string, any>} */
  _props() {
    /** @type {Record<string, any>} */ const out = {};
    for (const row of this.sql.exec("SELECT key, value FROM meta WHERE key LIKE 'prop:%'")) {
      const k = String(row.key).slice(5);
      if (!PROP_KEYS.has(k)) continue;
      try { out[k] = JSON.parse(String(row.value)); } catch { /* 坏值跳过 */ }
    }
    return out;
  }

  // ── HTTP：全量快照 ──────────────────────────────────────────────────────

  /**
   * 首次打开一张表时走 HTTP 而不是 WebSocket 拿全量。
   * 理由有三：HTTP 能自动 gzip、能流式输出、且不计入 DO 的 WS 入站消息计费。
   * 拿到的 seq 随后作为 hello 的 lastSeq，DO 从那里接着补增量 —— DO 单线程，
   * 这两步之间不可能插进第三方的写入而被漏掉。
   */
  stateResponse() {
    if (this._legacy) return this._legacyState();
    const seq = this.currentSeq();
    const rowsMap = this.rows;
    const colIdx = this._colIndexer();
    const fields = [...this.sql.exec('SELECT k, name, width FROM cols')]
      .map((f) => ({ c: this.cols.indexOf(Number(f.k)), name: String(f.name ?? ''), width: Number(f.width) }))
      .filter((f) => f.c >= 0 && f.c < LIMITS.MAX_COLS)
      .sort((a, b) => a.c - b.c);
    const rowHeights = [...this.sql.exec('SELECT k, h FROM rows WHERE h IS NOT NULL')]
      .map((r) => [rowsMap.indexOf(Number(r.k)), Number(r.h)])
      .filter(([r]) => r >= 0 && r < LIMITS.MAX_ROWS)
      .sort((a, b) => a[0] - b[0]);
    const sql = this.sql;
    const head = JSON.stringify({ seq, rowCount: this.rowCount, colCount: this.colCount, fields, rowHeights, props: this._props() }).slice(0, -1);
    const segs = rowsMap.ranges(0, LIMITS.MAX_ROWS);

    /** 按显示顺序逐行走一遍，每行把 JSON 对象按列序号排好交给 fn @param {'cells' | 'fmts'} col @param {(r: number, list: [number, any][]) => void} fn */
    const scan = (col, fn) => {
      for (const [a, b, i0] of segs) {
        for (const x of sql.exec(`SELECT k, ${col} AS v FROM rows WHERE k BETWEEN ? AND ? ORDER BY k`, a, b)) {
          const obj = JSON.parse(String(x.v));
          /** @type {[number, any][]} */ const list = [];
          for (const ck in obj) { const c = colIdx(ck); if (c >= 0) list.push([c, obj[ck]]); }
          if (!list.length) continue;
          list.sort((p, q) => p[0] - q[0]);
          fn(i0 + (Number(x.k) - a), list);
        }
      }
    };

    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(head + ',"cells":['));
        let buf = '', n = 0;
        // 格式和值在同一行记录里：第一遍顺手把格式攒下来（不超过 8MB），省掉第二遍读
        /** @type {string[] | null} */ let fbuf = [];
        let fbytes = 0;
        const flush = () => { controller.enqueue(enc.encode(buf)); buf = ''; };
        for (const [a, b, i0] of segs) {
          for (const x of sql.exec('SELECT k, cells, fmts FROM rows WHERE k BETWEEN ? AND ? ORDER BY k', a, b)) {
            const r = i0 + (Number(x.k) - a);
            const cells = JSON.parse(String(x.cells));
            /** @type {[number, string][]} */ const list = [];
            for (const ck in cells) { const c = colIdx(ck); if (c >= 0) list.push([c, cells[ck]]); }
            list.sort((p, q) => p[0] - q[0]);
            for (const [c, v] of list) {
              buf += (n ? ',' : '') + JSON.stringify([r, c, String(v)]);
              if (++n % STREAM_CHUNK === 0) flush();
            }
            if (fbuf && String(x.fmts) !== '{}') {
              fbuf.push(String(r), String(x.fmts));
              fbytes += String(x.fmts).length;
              if (fbytes > 8 * 1024 * 1024) fbuf = null;
            }
          }
        }
        buf += '],"formats":[';
        n = 0;
        /** @param {number} r @param {[number, any][]} list */
        const emitF = (r, list) => {
          for (const [c, f] of list) {
            buf += (n ? ',' : '') + '[' + r + ',' + c + ',' + JSON.stringify(f) + ']';
            if (++n % STREAM_CHUNK === 0) flush();
          }
        };
        if (fbuf) {
          for (let i = 0; i < fbuf.length; i += 2) {
            const obj = JSON.parse(fbuf[i + 1]);
            /** @type {[number, any][]} */ const list = [];
            for (const ck in obj) { const c = colIdx(ck); if (c >= 0) list.push([c, obj[ck]]); }
            list.sort((p, q) => p[0] - q[0]);
            emitF(Number(fbuf[i]), list);
          }
        } else {
          scan('fmts', emitF);
        }
        controller.enqueue(enc.encode(buf + ']}'));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  /** 列键 → 列序号（超出上限或已删除为 -1），带缓存 */
  _colIndexer() {
    /** @type {Map<string, number>} */ const cache = new Map();
    return (/** @type {string} */ ck) => {
      let c = cache.get(ck);
      if (c === undefined) {
        c = this.cols.indexOf(Number(ck));
        if (c >= LIMITS.MAX_COLS) c = -1;
        cache.set(ck, c);
      }
      return c;
    };
  }

  /** 升级前 / 升级失败时的只读快照：旧表结构 */
  _legacyState() {
    const seq = this.currentSeq();
    const rowCount = this.rowCount;
    const colCount = this.colCount;
    const fields = [...this.sql.exec('SELECT c, name, width FROM fields ORDER BY c')]
      .map((f) => ({ c: Number(f.c), name: String(f.name ?? ''), width: Number(f.width) }));
    const rowHeights = [...this.sql.exec('SELECT r, height FROM row_meta ORDER BY r')]
      .map((r) => [Number(r.r), Number(r.height)]);

    const sql = this.sql;
    const props = this._props();
    const head = JSON.stringify({ seq, rowCount, colCount, fields, rowHeights, props }).slice(0, -1);

    // 手写流式 JSON：单元格可能有几十万个，JSON.stringify 整个数组会在 DO 里
    // 同时存在「数组 + 字符串」两份，128MB 内存不够花。
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(head + ',"cells":['));
        let buf = '';
        let n = 0;
        for (const row of sql.exec('SELECT r, c, v FROM cells ORDER BY r, c')) {
          buf += (n ? ',' : '') + JSON.stringify([Number(row.r), Number(row.c), String(row.v)]);
          if (++n % STREAM_CHUNK === 0) { controller.enqueue(enc.encode(buf)); buf = ''; }
        }
        controller.enqueue(enc.encode(buf + '],"formats":['));
        buf = '';
        n = 0;
        for (const row of sql.exec('SELECT r, c, f FROM formats ORDER BY r, c')) {
          buf += (n ? ',' : '') + '[' + Number(row.r) + ',' + Number(row.c) + ',' + String(row.f) + ']';
          if (++n % STREAM_CHUNK === 0) { controller.enqueue(enc.encode(buf)); buf = ''; }
        }
        controller.enqueue(enc.encode(buf + ']}'));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  // ── 附件 ────────────────────────────────────────────────────────────────

  /**
   * 上传。整个请求体读进内存后同步写入 —— 中间没有 await，DO 会把这些写入
   * 合成一个原子提交，不会留下只写了一半块的文件。
   * @param {Request} request @param {{uid:string, role:string}} session
   */
  async putFile(request, session) {
    if (session.role === 'viewer') return fileError(403, t('只读用户不能上传附件'));
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > MAX_FILE_BYTES) return fileError(413, t('单个附件不能超过 {n}MB', { n: MAX_FILE_BYTES >> 20 }));
    const buf = new Uint8Array(await request.arrayBuffer());
    if (!buf.length) return fileError(400, t('文件是空的'));
    if (buf.length > MAX_FILE_BYTES) return fileError(413, t('单个附件不能超过 {n}MB', { n: MAX_FILE_BYTES >> 20 }));
    const used = Number([...this.sql.exec('SELECT COALESCE(SUM(size), 0) AS s FROM files')][0]?.s ?? 0);
    if (used + buf.length > MAX_TABLE_FILE_BYTES) {
      return fileError(413, t('本表附件总量已达上限（{n}MB），请先删除不用的附件', { n: MAX_TABLE_FILE_BYTES >> 20 }));
    }

    const name = cleanFileName(request.headers.get('x-file-name'));
    const mime = String(request.headers.get('x-file-type') ?? '').toLowerCase();
    const type = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) && mime.length <= 100 ? mime : 'application/octet-stream';
    const id = uid('f');
    const chunks = Math.ceil(buf.length / FILE_CHUNK);
    for (let i = 0; i < chunks; i++) {
      this.sql.exec('INSERT INTO file_chunks (id, idx, data) VALUES (?,?,?)', id, i, buf.subarray(i * FILE_CHUNK, (i + 1) * FILE_CHUNK));
    }
    this.sql.exec('INSERT INTO files (id, name, type, size, chunks, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
      id, name, type, buf.length, chunks, session.uid, Date.now());
    return new Response(JSON.stringify({ id, n: name, t: type, s: buf.length }), {
      status: 201, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  /** 下载：逐块流式读出，内存里同一时刻只有一块。 @param {string} id */
  getFile(id) {
    const meta = [...this.sql.exec('SELECT name, type, size, chunks FROM files WHERE id = ?', id)][0];
    if (!meta) return fileError(404, t('附件不存在或已被清理'));
    const sql = this.sql;
    const chunks = Number(meta.chunks);
    let i = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (i >= chunks) { controller.close(); return; }
        const row = [...sql.exec('SELECT data FROM file_chunks WHERE id = ? AND idx = ?', id, i++)][0];
        if (!row) { controller.error(new Error('附件数据缺失')); return; }
        controller.enqueue(new Uint8Array(/** @type {any} */ (row.data)));
      },
    });
    const type = String(meta.type);
    const inline = INLINE_TYPES.has(type);
    const name = String(meta.name);
    return new Response(stream, {
      headers: {
        'content-type': inline ? type : 'application/octet-stream',
        'content-length': String(meta.size),
        'content-disposition': (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(name),
        // 文件按 id 不可变，浏览器可以放心长期缓存（缩略图不必反复下载）
        'cache-control': 'private, max-age=31536000, immutable',
        // 就算有人绕过 content-type 直接打开，也跑不了任何脚本
        'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    });
  }

  /** 清理没有任何单元格引用、且已过宽限期的附件。 */
  _gcFiles() {
    const ref = new Set();
    const props = this._props();
    for (const e of props.files ?? []) for (const f of (Array.isArray(e) && e[2]) || []) if (f?.id) ref.add(String(f.id));
    // 文档 / 幻灯片里的图片：{ img: "f_…" } 散落在树的各处，直接在序列化文本里找
    for (const k of ['doc', 'slides']) {
      const v = props[k];
      if (v) for (const m of JSON.stringify(v).matchAll(/"img":"([A-Za-z0-9_-]{1,64})"/g)) ref.add(m[1]);
    }
    const old = [...this.sql.exec('SELECT id FROM files WHERE created_at < ?', Date.now() - FILE_GRACE_MS)];
    for (const row of old) {
      const id = String(row.id);
      if (ref.has(id)) continue;
      this.sql.exec('DELETE FROM file_chunks WHERE id = ?', id);
      this.sql.exec('DELETE FROM files WHERE id = ?', id);
    }
  }

  // ── 连接 ────────────────────────────────────────────────────────────────

  /**
   * ticket 一次性校验。顺手清理过期记录，表不会无限增长。
   * @param {string} nonce
   */
  claimNonce(nonce) {
    const now = Date.now();
    this.sql.exec('DELETE FROM used_nonce WHERE used_at < ?', now - NONCE_RETENTION_MS);
    if ([...this.sql.exec('SELECT 1 AS hit FROM used_nonce WHERE nonce = ?', nonce)].length > 0) return false;
    this.sql.exec('INSERT INTO used_nonce (nonce, used_at) VALUES (?, ?)', nonce, now);
    return true;
  }

  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);

    // 身份一律从 Worker 验签后透传的头里取，绝不信客户端自报
    const session = {
      uid: request.headers.get('x-user-id') ?? '',
      email: request.headers.get('x-user-email') ?? '',
      role: request.headers.get('x-user-role') ?? 'viewer',
      name: safeDecode(request.headers.get('x-user-name')),
      scope: request.headers.get('x-user-scope') || null,
      tableId: request.headers.get('x-table-id') ?? '',
    };
    if (!session.uid || !session.tableId) return new Response('unauthorized', { status: 401 });

    // 第一次收到请求时把表 ID 记下来，alarm 里要用它回写 D1 的行数。
    // DO 自己拿不到这个 ID —— idFromName 是单向的。
    if (this._meta('table_id') !== session.tableId) this._setMeta('table_id', session.tableId);
    // 全站今日写入量：大批量改动前要用它判断是否限流。5 分钟刷新一次，不挡请求
    if (!this._usage || Date.now() - this._usage.at > 5 * 60 * 1000) this.ctx.waitUntil(this._fetchUsage());

    if (url.pathname === '/state') return this.stateResponse();
    // 公开只读链接没有 WebSocket，靠轮询它判断要不要重拉快照
    if (url.pathname === '/seq') return new Response(JSON.stringify({ seq: this.currentSeq() }), { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/revoke' && request.method === 'POST') return this.revoke(session.uid);
    if (url.pathname === '/range' && request.method === 'POST') return this.rangeResponse(request, session.tableId);
    if (url.pathname === '/files' && request.method === 'POST') return this.putFile(request, session);
    const fm = /^\/files\/([a-z0-9_]{8,40})$/.exec(url.pathname);
    if (fm && request.method === 'GET') return this.getFile(fm[1]);

    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 400 });
    }

    const nonce = request.headers.get('x-ticket-nonce') ?? '';
    if (!nonce) return new Response('unauthorized', { status: 401 });
    if (!this.claimNonce(nonce)) return new Response('ticket already used', { status: 401 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.ctx.acceptWebSocket(server);
    // attachment 在休眠后依然保留，醒来时不用重新查身份
    server.serializeAttachment(session);

    this._send(server, {
      t: 'welcome',
      seq: this.currentSeq(),
      you: { id: session.uid, email: session.email, name: session.name, role: session.role, scope: session.scope },
      limits: { maxCells: LIMITS.MAX_CELLS, maxRows: LIMITS.MAX_ROWS, maxCols: LIMITS.MAX_COLS },
    });
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 权限变了（移出工作区、改角色、停用、重置）：断开这个人在本表的所有连接。
   * 客户端收到 4001 会立刻重连、重新申请 ticket，于是新角色当场生效；
   * 权限没了就拿不到 ticket。只有 Worker 能调到这里 —— DO 不对公网开放。
   * @param {string} uid
   */
  revoke(uid) {
    let n = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const a = /** @type {any} */ (ws.deserializeAttachment());
      if (a?.uid !== uid || a.revoked) continue;
      // 线上实测：服务端发出 close 帧之后，TCP 可能迟迟不拆，客户端一直卡在 CLOSING、
      // 收不到 close 事件。所以三件事都做：先在 attachment 上打标记（此后这条连接发来的
      // 任何消息一律丢弃、也不再给它广播），再发一条 revoked 让客户端自己马上断开重连，
      // 最后才是 close 帧。
      ws.serializeAttachment({ ...a, revoked: true });
      this._send(ws, { t: 'revoked' });
      try { ws.close(4001, 'permission changed'); } catch { /* 已经断了 */ }
      n++;
    }
    if (n) this.broadcastPresence();
    return new Response(JSON.stringify({ closed: n }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  /**
   * 跨表引用：算出这张表里一块区域的值。只给计算结果，不给公式原文。只有 Worker 调得到。
   *
   * 请求体 { range, provided }。provided 是这张表自己又引用了别的表时，Worker 已经替它
   * 取好的值（键 'tbl_xxx!A1:B2'，值是打包的区域）。算的过程中碰到 provided 里没有的，
   * 记进 needs 返回；Worker 查过 table_refs、取来之后再调一次。DO 之间不互相调用，
   * 「能不能读」的判断全在 Worker。
   *
   * 格子按需从 SQLite 读（先把请求的这一块整块读进来）：大表整表进内存会撑爆 128MB。
   * @param {Request} request @param {string} tableId
   */
  async rangeResponse(request, tableId) {
    /** @type {any} */ let body = null;
    try { body = await request.json(); } catch { /* 下面按坏请求处理 */ }
    const g = parseRange(body?.range);
    const res = (/** @type {any} */ o, status = 200) => new Response(JSON.stringify(o), {
      status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
    if (!g || tooBig(g)) return res({ e: '#REF!' }, 400);
    const provided = body.provided && typeof body.provided === 'object' ? body.provided : {};

    const rows = this.rowCount, cols = this.colCount;
    const r0 = g.r0 ?? 0, c0 = g.c0 ?? 0;
    let r1 = g.r1 ?? rows - 1, c1 = g.c1 ?? cols - 1;
    // 与本表引用一样：超出表格实际大小的部分都是空，裁掉
    if (r1 >= rows) r1 = Math.max(r0, rows - 1);
    if (c1 >= cols) c1 = Math.max(c0, cols - 1);

    /** @type {Map<number, string>} */ const raw = new Map();
    /** 块外的格子按行读、整行缓存 @type {Map<number, Record<string, string>>} */ const rowCache = new Map();
    let rawAt = (/** @type {number} */ r, /** @type {number} */ c) => {
      let obj = rowCache.get(r);
      if (!obj) {
        const x = [...this.sql.exec('SELECT cells FROM rows WHERE k = ?', this.rows.keyAt(r))][0];
        obj = x ? JSON.parse(String(x.cells)) : {};
        rowCache.set(r, /** @type {Record<string, string>} */ (obj));
      }
      return String(/** @type {any} */ (obj)[this.cols.keyAt(c)] ?? '');
    };
    if (this._legacy) {
      for (const row of this.sql.exec('SELECT r, c, v FROM cells WHERE r BETWEEN ? AND ? AND c BETWEEN ? AND ?', r0, r1, c0, c1)) {
        raw.set(Number(row.r) * 16384 + Number(row.c), String(row.v));
      }
      rawAt = (r, c) => String([...this.sql.exec('SELECT v FROM cells WHERE r = ? AND c = ?', r, c)][0]?.v ?? '');
    } else {
      const colIdx = this._colIndexer();
      for (const [a, b, i0] of this.rows.ranges(r0, r1 - r0 + 1)) {
        for (const x of this.sql.exec('SELECT k, cells FROM rows WHERE k BETWEEN ? AND ?', a, b)) {
          const r = i0 + (Number(x.k) - a);
          const obj = JSON.parse(String(x.cells));
          for (const ck in obj) {
            const c = colIdx(ck);
            if (c >= c0 && c <= c1) raw.set(r * 16384 + c, String(obj[ck]));
          }
        }
      }
    }
    const inBlock = (/** @type {number} */ r, /** @type {number} */ c) => r >= r0 && r <= r1 && c >= c0 && c <= c1;
    /** @type {Set<string>} */ const needs = new Set();
    const eng = new Engine({
      raw: (r, c) => {
        const k = r * 16384 + c;
        const hit = raw.get(k);
        if (hit !== undefined || inBlock(r, c)) return hit ?? '';
        const v = rawAt(r, c);
        raw.set(k, v);
        return v;
      },
      rows: () => rows,
      cols: () => cols,
      tableId,
      ext: (t, key) => {
        const k = t + '!' + key;
        if (Object.hasOwn(provided, k)) return unpackRange(provided[k]);
        needs.add(k);
        return ERR.LOADING;
      },
    });

    /** @type {any[][]} */ const out = [];
    for (let r = r0; r <= r1; r++) {
      /** @type {any[]} */ const line = [];
      for (let c = c0; c <= c1; c++) {
        const v = raw.get(r * 16384 + c);
        line.push(!v ? null : isFormula(v) ? packValue(eng.value(r, c)) : packValue(eng.cell(r, c)));
      }
      out.push(line);
    }
    return res({ r0, c0, rows: out, needs: [...needs] });
  }

  // ── WebSocket ───────────────────────────────────────────────────────────

  /** @param {WebSocket} ws @param {string | ArrayBuffer} raw */
  async webSocketMessage(ws, raw) {
    /** @type {any} */ const session = ws.deserializeAttachment() ?? {};
    if (session.revoked) return;   // 权限已收回、正在断开的连接
    /** @type {any} */ let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); }
    catch { return this._send(ws, { t: 'error', code: 'bad_json' }); }

    switch (msg?.t) {
      case 'ping':
        return this._send(ws, { t: 'pong', ts: Date.now() });

      case 'hello':
        return this._catchUp(ws, Number(msg.lastSeq ?? -1));

      case 'cursor':
        // 光标不落库，只广播；节流由客户端做（10Hz）
        return this.broadcast({
          t: 'cursor', from: session.uid,
          sel: sanitizeSel(msg.sel),
          // 对方正在这个格子里打字：别人那边选框加粗、名牌写「正在输入…」
          editing: msg.editing === true,
        }, ws);

      case 'ops':
        return this._handleOps(ws, session, msg);

      default:
        return this._send(ws, { t: 'error', code: 'unknown_type' });
    }
  }

  /** @param {WebSocket} ws @param {any} session @param {any} msg */
  _handleOps(ws, session, msg) {
    if (session.role === 'viewer') {
      return this._send(ws, { t: 'rejected', batchId: msg.batchId ?? null, code: 'forbidden', msg: t('只读权限，无法编辑') });
    }

    const parsed = normalizeOps(msg.ops);
    if ('error' in parsed) {
      return this._send(ws, { t: 'rejected', batchId: msg.batchId ?? null, code: 'bad_ops', msg: parsed.error });
    }

    // 客户端基于一个早于最近结构性 op 的状态提交 —— 索引含义已经变了，不能勉强合并
    const baseSeq = Number(msg.baseSeq ?? 0);
    if (baseSeq < this._structuralSeq) {
      return this._send(ws, { t: 'resync', reason: 'structural' });
    }

    const res = this.applyOps(parsed.ops, session.uid);
    if ('error' in res) {
      return this._send(ws, { t: 'rejected', batchId: msg.batchId ?? null, code: /** @type {any} */ (res).code ?? 'limit', msg: res.error });
    }

    // 一次广播覆盖两件事：别人拿到改动，自己拿到 ack（靠 batchId 认出是自己发的）
    this.broadcast({ t: 'ops', seq: res.seq, actorId: session.uid, batchId: msg.batchId ?? null, ops: res.ops });
  }

  /**
   * 断线重连后的增量补齐。
   * oplog 已经裁掉了客户端要的那一段 → 让它重拉全量，绝不发一段有缺口的增量。
   * @param {WebSocket} ws @param {number} lastSeq
   */
  _catchUp(ws, lastSeq) {
    const cur = this.currentSeq();
    if (lastSeq >= cur) return this._send(ws, { t: 'synced', seq: cur });

    const truncated = () => this._send(ws, { t: 'resync', reason: 'oplog_truncated' });
    // 环形日志只留最近 OPLOG_KEEP 条；升级前的旧日志不在环里
    if (this._legacy || lastSeq < 0 || cur - lastSeq > OPLOG_KEEP || lastSeq < this._seqFloor) return truncated();
    if (lastSeq < this._structuralSeq) {
      return this._send(ws, { t: 'resync', reason: 'structural' });
    }

    // 要的 seq 是 (lastSeq, cur]，槽位 = seq % KEEP，最多绕回一次 → 两段主键区间
    const s0 = (lastSeq + 1) % OPLOG_KEEP, s1 = cur % OPLOG_KEEP;
    const q = 'SELECT seq, op_json FROM ops_ring WHERE slot BETWEEN ? AND ?';
    const got = s0 <= s1
      ? [...this.sql.exec(q, s0, s1)]
      : [...this.sql.exec(q, s0, OPLOG_KEEP - 1), ...this.sql.exec(q, 0, s1)];
    got.sort((a, b) => Number(a.seq) - Number(b.seq));
    /** @type {any[]} */ const ops = [];
    // 必须正好是连续的 lastSeq+1 … cur，且内容没被体积上限裁掉；否则宁可重拉全量
    for (let i = 0; i < got.length; i++) {
      if (Number(got[i].seq) !== lastSeq + 1 + i || got[i].op_json == null) return truncated();
      try { ops.push(JSON.parse(String(got[i].op_json))); } catch { return truncated(); }
    }
    if (ops.length !== cur - lastSeq) return truncated();
    this._send(ws, { t: 'ops', seq: cur, actorId: null, batchId: null, ops });
    this._send(ws, { t: 'synced', seq: cur });
  }

  /** @param {WebSocket} ws */
  async webSocketClose(ws) { this.broadcastPresence(); }

  /** @param {WebSocket} ws @param {any} err */
  async webSocketError(ws, err) { console.error('ws error', err); this.broadcastPresence(); }

  /** @param {WebSocket} ws @param {any} obj */
  _send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch { /* 连接已断 */ } }

  /** @param {any} obj @param {WebSocket} [except] */
  broadcast(obj, except) {
    const text = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || /** @type {any} */ (ws.deserializeAttachment())?.revoked) continue;
      try { ws.send(text); } catch { /* 连接已断，close 回调会清理 */ }
    }
  }

  broadcastPresence() {
    /** @type {Map<string, { id: string, email: string, name: string, role: string }>} */
    const users = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      const a = /** @type {any} */ (ws.deserializeAttachment());
      // 同一个人开了多个标签页：有一个能编辑就算能编辑
      const prev = a?.uid ? users.get(a.uid) : null;
      if (a?.uid && !a.revoked && (!prev || prev.role === 'viewer')) {
        users.set(a.uid, { id: a.uid, email: a.email, name: a.name || String(a.email ?? '').split('@')[0], role: a.role });
      }
    }
    this.broadcast({ t: 'presence', users: [...users.values()] });
  }

  // ── 维护 ────────────────────────────────────────────────────────────────

  _scheduleMaintenance() {
    // alarm 只在没有排期时设一次；重复 setAlarm 会把时间一直往后推，永远不触发
    this.ctx.waitUntil((async () => {
      const at = await this.ctx.storage.getAlarm();
      if (at == null) await this.ctx.storage.setAlarm(Date.now() + MAINTENANCE_MS);
    })());
  }

  async alarm() {
    // 升级没做成的表：每小时重试一次，直到额度够、升级成功
    if (this._legacy) {
      if (await this._upgradeV5()) this._load();
      else await this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
      return;
    }
    // ① 日志条数由环形结构自己限住。文档每次保存都是整份替换，3000 条可能就是几百 MB：
    //    按体积把旧条目的内容清空（只清内容、留 seq，补发时据此判断要重拉全量）。
    //    最新的一条永远不裁，哪怕它自己就超过上限。
    let bytes = 0, cut = 0, first = true;
    for (const row of [...this.sql.exec('SELECT seq, length(op_json) AS n FROM ops_ring WHERE op_json IS NOT NULL ORDER BY seq DESC')]) {
      bytes += Number(row.n);
      if (bytes > OPLOG_MAX_BYTES && !first) { cut = Number(row.seq); break; }
      first = false;
    }
    if (cut) this.sql.exec('UPDATE ops_ring SET op_json = NULL WHERE seq <= ? AND op_json IS NOT NULL', cut);
    this._gcFiles();
    await this._reportUsage();

    // ② 把行数回写 D1，仅供侧边栏列表展示。每分钟最多 1 行写入，
    //    对着 D1 免费额度的 100K 行/天有两个数量级余量。
    const tableId = this._meta('table_id');
    if (tableId && this.env.DB) {
      try {
        await this.env.DB
          .prepare('UPDATE tables SET row_count = ?, updated_at = ? WHERE id = ?')
          .bind(this.rowCount, Date.now(), tableId).run();
      } catch (err) {
        console.error('回写 D1 行数失败', err);   // 展示用数据，失败不影响表本身
      }
    }
  }

  /**
   * 把本 DO 这段时间写了多少行累加到 D1 的 do_usage:<UTC 日期>（全站共用一个计数，管理员面板显示）。
   * 来源：日志环里每批记下的 w + 不属于任何批次的零散写入（alarm、上传等）+ 迁移写入。
   * 只是估算：Cloudflare 的真实账单以它自己的统计为准。上报失败下次再报。
   */
  async _reportUsage() {
    if (!this.env?.DB) return;
    const cur = this._seq;
    const from = Number(this._meta('usage_seq') ?? this._seqFloor);
    const ring = cur > from
      ? Number([...this.sql.exec('SELECT COALESCE(SUM(w), 0) AS n FROM ops_ring WHERE seq > ? AND seq <= ?', from, cur)][0]?.n ?? 0)
      : 0;
    const pending = Number(this._meta('usage_pending') ?? 0);
    const loose = this._wLoose;
    const total = ring + pending + loose;
    if (total <= 0) return;
    const day = utcDay();
    try {
      const row = await this.env.DB.prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT), updated_at = excluded.updated_at
           RETURNING value`,
      ).bind('do_usage:' + day, String(total), Date.now(), total).first();
      this._usage = { day, rows: Number(row?.value ?? total), at: Date.now() };
      this._sinceUsage = 0;
    } catch (err) {
      console.error('上报写入量失败', err);
      return;
    }
    this._wLoose -= loose;
    if (cur > from) this._setMeta('usage_seq', String(cur));
    if (pending) this.sql.exec("DELETE FROM meta WHERE key = 'usage_pending'");
  }
}

/** @param {number} status @param {string} message */
function fileError(status, message) {
  return new Response(JSON.stringify({ error: { code: status === 413 ? 'too_large' : 'file_error', message } }), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 文件名来自客户端：解码、去掉路径与控制字符、截断。 @param {string | null} raw */
function cleanFileName(raw) {
  let s = '';
  try { s = decodeURIComponent(raw ?? ''); } catch { s = ''; }
  s = s.replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 200);
  return s || '附件';
}

/** 光标位置来自客户端，广播前必须洗一遍 —— 它会被原样发给别人。 */
function sanitizeSel(sel) {
  if (!sel || typeof sel !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  return { r0: n(sel.r0), c0: n(sel.c0), r1: n(sel.r1), c1: n(sel.c1) };
}
