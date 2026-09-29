// 分数索引的排序不变量测试：`npm test`
// 纯函数、无依赖，用 node 直接跑。
import { keyBetween, keysBetween, keyAfter, keyBefore } from "./fracindex.js";
let fail = 0;
const ok = (c, m) => { if (!c) { console.log("FAIL: " + m); fail++; } };

let keys = [], last = null;
for (let i = 0; i < 500; i++) { last = keyAfter(last); keys.push(last); }
for (let i = 1; i < keys.length; i++) ok(keys[i-1] < keys[i], `append ${i}: ${keys[i-1]} !< ${keys[i]}`);
console.log("append 500   -> maxlen", Math.max(...keys.map(k=>k.length)), " last:", keys.at(-1));

let first = null; const heads = [];
for (let i = 0; i < 500; i++) { first = keyBefore(first); heads.push(first); }
for (let i = 1; i < heads.length; i++) ok(heads[i] < heads[i-1], `prepend ${i}`);
console.log("prepend 500  -> maxlen", Math.max(...heads.map(k=>k.length)));

let a = keyBetween(null, null), b = keyAfter(a);
for (let i = 0; i < 1000; i++) { const m = keyBetween(a, b); ok(a < m && m < b, `squeeze ${i}: ${a} < ${m} < ${b}`); b = m; }
console.log("squeeze 1000 -> len", b.length, "(浮点 ordinal 约 50 次即精度耗尽)");

const batch = keysBetween(null, null, 200);
for (let i = 1; i < batch.length; i++) ok(batch[i-1] < batch[i], `batch ${i}`);
console.log("batch 200    -> maxlen", Math.max(...batch.map(k=>k.length)));

let cards = keysBetween(null, null, 30);
for (let i = 0; i < 2000; i++) {
  const from = Math.floor(Math.random()*cards.length); cards.splice(from,1);
  const to = Math.floor(Math.random()*(cards.length+1));
  const before = to > 0 ? cards[to-1] : null, after = to < cards.length ? cards[to] : null;
  cards.splice(to, 0, keyBetween(before, after));
}
for (let i = 1; i < cards.length; i++) ok(cards[i-1] < cards[i], `drag ${i}`);
console.log("kanban drag 2000 -> maxlen", Math.max(...cards.map(k=>k.length)));
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
