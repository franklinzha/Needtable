/** 公式引擎：解析、求值、引用改写、数字格式。 */

import assert from 'node:assert/strict';
import { parse, shiftFormula, adjustFormula } from './parse.js';
import { Engine } from './evaluate.js';
import { formatValue, adjustDecimals, isDateFormat } from './numfmt.js';
import { dateToSerial } from './values.js';

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.error('  FAIL ' + name + '\n       ' + (err.stack || err.message)); }
}

/** 用 {A1: '1', B2: '=A1+1'} 建一张表。 */
function sheet(cells, rows = 100, cols = 26) {
  const m = new Map();
  for (const [ref, v] of Object.entries(cells)) {
    const mm = /^([A-Z]+)(\d+)$/.exec(ref);
    let c = 0;
    for (const ch of mm[1]) c = c * 26 + ch.charCodeAt(0) - 64;
    m.set((Number(mm[2]) - 1) + ':' + (c - 1), v);
  }
  const eng = new Engine({ raw: (r, c) => m.get(r + ':' + c) ?? '', rows: () => rows, cols: () => cols });
  const at = (ref) => {
    const mm = /^([A-Z]+)(\d+)$/.exec(ref);
    let c = 0;
    for (const ch of mm[1]) c = c * 26 + ch.charCodeAt(0) - 64;
    return eng.value(Number(mm[2]) - 1, c - 1);
  };
  return { eng, m, at };
}

/** 单个公式的值。 */
function calc(formula, cells = {}) {
  return sheet({ ...cells, Z100: formula }).at('Z100');
}
const errCode = (v) => v && v.err;

test('运算符优先级与 Excel 一致', () => {
  assert.equal(calc('=1+2*3'), 7);
  assert.equal(calc('=(1+2)*3'), 9);
  assert.equal(calc('=-2^2'), 4);                 // Excel：一元负号先于乘方
  assert.equal(calc('=2^3^2'), 64);               // 左结合
  assert.equal(calc('=50%*10'), 5);
  assert.equal(calc('=1+2&"x"'), '3x');
  assert.equal(calc('=1+1=2'), true);
  assert.equal(calc('=0.1+0.2'), 0.3);
  assert.equal(calc('=0.1+0.2=0.3'), true);
});

test('引用、区域与空格子', () => {
  const s = sheet({ A1: '1', A2: '2', A3: '3', B1: '=A1+A2', B2: '=SUM(A1:A3)', B3: '=C9', B4: '=SUM(A:A)' });
  assert.equal(s.at('B1'), 3);
  assert.equal(s.at('B2'), 6);
  assert.equal(s.at('B3'), 0, '引用空格子显示 0');
  assert.equal(s.at('B4'), 6);
});

test('小写函数名与引用，多余空格', () => {
  assert.equal(calc('= sum( a1 : a2 ) ', { A1: '4', A2: '5' }), 9);
});

test('错误值：除零、未知函数、类型错误、循环引用', () => {
  assert.equal(errCode(calc('=1/0')), '#DIV/0!');
  assert.equal(errCode(calc('=FOO(1)')), '#NAME?');
  assert.equal(errCode(calc('="a"+1')), '#VALUE!');
  const s = sheet({ A1: '=B1', B1: '=A1' });
  assert.equal(errCode(s.at('A1')), '#CIRC!');
  assert.equal(errCode(calc('=SUM(1,')), '#ERROR!');
  assert.equal(errCode(calc('=IFERROR(1/0,"x")')), undefined);
  assert.equal(calc('=IFERROR(1/0,"x")'), 'x');
  assert.equal(calc('=ISERROR(A1)', { A1: '=1/0' }), true);
});

test('IF 短路：不去算没选中的分支', () => {
  assert.equal(calc('=IF(A1=0,0,1/A1)', { A1: '0' }), 0);
  assert.equal(calc('=IF(A1>5,"大","小")', { A1: '9' }), '大');
  assert.equal(calc('=IF(FALSE,1)'), false);
  assert.equal(calc('=IFS(A1<0,"负",A1=0,"零",TRUE,"正")', { A1: '3' }), '正');
});

test('统计函数与 Excel 的取数规则（区域里的文本被忽略，参数里的文本被转换）', () => {
  const cells = { A1: '1', A2: 'x', A3: '3', A4: 'TRUE', A5: '' };
  assert.equal(calc('=SUM(A1:A5)', cells), 4);
  assert.equal(calc('=SUM("2",3)', cells), 5);
  assert.equal(calc('=AVERAGE(A1:A5)', cells), 2);
  assert.equal(calc('=COUNT(A1:A5)', cells), 2);
  assert.equal(calc('=COUNTA(A1:A5)', cells), 4);
  assert.equal(calc('=COUNTBLANK(A1:A5)', cells), 1);
  assert.equal(calc('=MAX(A1:A5)', cells), 3);
  assert.equal(calc('=MEDIAN(1,2,3,4)'), 2.5);
  assert.equal(calc('=ROUND(STDEV(2,4,4,4,5,5,7,9),4)'), 2.1381);
  assert.equal(calc('=LARGE(A1:A3,1)', cells), 3);
  assert.equal(calc('=RANK(3,A1:A3)', cells), 1);
});

test('条件聚合：COUNTIF / SUMIF / SUMIFS / 通配符', () => {
  const cells = {
    A1: '苹果', A2: '香蕉', A3: '苹果', A4: '橙子',
    B1: '10', B2: '20', B3: '30', B4: '40',
    C1: '北', C2: '南', C3: '南', C4: '北',
  };
  assert.equal(calc('=COUNTIF(A1:A4,"苹果")', cells), 2);
  assert.equal(calc('=COUNTIF(B1:B4,">15")', cells), 3);
  assert.equal(calc('=COUNTIF(B1:B4,"<>20")', cells), 3);
  assert.equal(calc('=COUNTIF(A1:A4,"*蕉")', cells), 1);
  assert.equal(calc('=SUMIF(A1:A4,"苹果",B1:B4)', cells), 40);
  assert.equal(calc('=SUMIF(B1:B4,">=30")', cells), 70);
  assert.equal(calc('=SUMIFS(B1:B4,A1:A4,"苹果",C1:C4,"南")', cells), 30);
  assert.equal(calc('=COUNTIFS(A1:A4,"苹果",B1:B4,">5")', cells), 2);
  assert.equal(calc('=AVERAGEIF(A1:A4,"苹果",B1:B4)', cells), 20);
  assert.equal(calc('=SUMPRODUCT((A1:A4="苹果")*B1:B4)', cells), 40);
  assert.equal(calc('=SUMPRODUCT(B1:B4,B1:B4)', cells), 3000);
});

test('查找：VLOOKUP / HLOOKUP / INDEX+MATCH / XLOOKUP', () => {
  const cells = {
    A1: '甲', A2: '乙', A3: '丙',
    B1: '1', B2: '2', B3: '3',
    C1: 'x', C2: 'y', C3: 'z',
  };
  assert.equal(calc('=VLOOKUP("乙",A1:C3,3,FALSE)', cells), 'y');
  assert.equal(errCode(calc('=VLOOKUP("丁",A1:C3,2,0)', cells)), '#N/A');
  assert.equal(calc('=VLOOKUP(2.5,B1:C3,2)', cells), 'y');          // 近似匹配
  assert.equal(calc('=INDEX(C1:C3,MATCH("丙",A1:A3,0))', cells), 'z');
  assert.equal(calc('=INDEX(A1:C3,2,2)', cells), 2);
  assert.equal(calc('=XLOOKUP("丙",A1:A3,B1:B3)', cells), 3);
  assert.equal(calc('=XLOOKUP("丁",A1:A3,B1:B3,"无")', cells), '无');
  assert.equal(calc('=HLOOKUP(2,B1:C1,1,FALSE)', { B1: '1', C1: '2' }), 2);
  assert.equal(calc('=SUM(INDEX(A1:C3,0,2))', cells), 6);
  assert.equal(calc('=ROWS(A1:C3)*10+COLUMNS(A1:C3)', cells), 33);
});

test('文本函数', () => {
  assert.equal(calc('=CONCATENATE("a",1,TRUE)'), 'a1TRUE');
  assert.equal(calc('=LEFT("你好世界",2)&RIGHT("abc")'), '你好c');
  assert.equal(calc('=MID("abcdef",2,3)'), 'bcd');
  assert.equal(calc('=LEN("中文")'), 2);
  assert.equal(calc('=UPPER("abc")&LOWER("DEF")&PROPER("hello world")'), 'ABCdefHello World');
  assert.equal(calc('=TRIM("  a   b  ")'), 'a b');
  assert.equal(calc('=SUBSTITUTE("a-b-c","-","+")'), 'a+b+c');
  assert.equal(calc('=SUBSTITUTE("a-b-c","-","+",2)'), 'a-b+c');
  assert.equal(calc('=FIND("c","abcabc",4)'), 6);
  assert.equal(calc('=SEARCH("B","abc")'), 2);
  assert.equal(calc('=TEXT(1234.5,"#,##0.00")'), '1,234.50');
  assert.equal(calc('=TEXT(0.256,"0.0%")'), '25.6%');
  assert.equal(calc('=VALUE("1,234")+1'), 1235);
  assert.equal(calc('=TEXTJOIN("、",TRUE,A1:A3)', { A1: 'x', A3: 'z' }), 'x、z');
  assert.equal(calc('=REPT("ab",3)'), 'ababab');
  assert.equal(calc('="He said ""hi"""'), 'He said "hi"');
});

test('日期函数（日期文本在运算里按日期处理）', () => {
  const d = dateToSerial(2024, 1, 31);
  assert.equal(calc('=DATE(2024,1,31)'), d);
  assert.equal(calc('=YEAR(A1)&"-"&MONTH(A1)&"-"&DAY(A1)', { A1: '2024-03-05' }), '2024-3-5');
  assert.equal(calc('=EDATE(DATE(2024,1,31),1)'), dateToSerial(2024, 2, 29));
  assert.equal(calc('=EOMONTH(DATE(2023,2,10),0)'), dateToSerial(2023, 2, 28));
  assert.equal(calc('=DATEDIF("2020-05-10","2024-03-01","Y")'), 3);
  assert.equal(calc('=DATEDIF("2020-05-10","2024-03-01","M")'), 45);
  assert.equal(calc('=A1-A2', { A1: '2024-03-01', A2: '2024-02-01' }), 29);
  assert.equal(calc('=WEEKDAY(DATE(2024,1,1))'), 2);                 // 周一
  assert.equal(calc('=WEEKDAY(DATE(2024,1,1),2)'), 1);
  assert.equal(calc('=NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,7))'), 5);
  assert.equal(calc('=WORKDAY(DATE(2024,1,5),1)'), dateToSerial(2024, 1, 8));
  assert.equal(calc('=HOUR("13:45:10")*100+MINUTE("13:45:10")'), 1345);
  assert.equal(typeof calc('=TODAY()'), 'number');
});

test('财务：PMT / FV / NPV', () => {
  assert.equal(calc('=ROUND(PMT(0.05/12,360,300000),2)'), -1610.46);
  assert.equal(calc('=ROUND(FV(0.06/12,10,-200,-500,1),2)'), 2581.4);
  assert.equal(calc('=ROUND(NPV(0.1,-10000,3000,4200,6800),2)'), 1188.44);
});

test('数学：ROUND 半数远离 0、MOD 取除数符号、CEILING / FLOOR', () => {
  assert.equal(calc('=ROUND(2.5,0)'), 3);
  assert.equal(calc('=ROUND(-2.5,0)'), -3);
  assert.equal(calc('=ROUND(1.005,2)'), 1.01);
  assert.equal(calc('=ROUND(1234,-2)'), 1200);
  assert.equal(calc('=ROUNDUP(1.21,1)'), 1.3);
  assert.equal(calc('=ROUNDDOWN(-1.29,1)'), -1.2);
  assert.equal(calc('=MOD(-3,2)'), 1);
  assert.equal(calc('=CEILING(4.3,0.5)'), 4.5);
  assert.equal(calc('=FLOOR(4.7,1)'), 4);
  assert.equal(calc('=INT(-1.5)'), -2);
  assert.equal(calc('=ABS(-3)+SQRT(16)+POWER(2,10)'), 1031);
});

test('长依赖链不会爆栈（10 万行 A(n)=A(n-1)+1）', () => {
  const N = 100000;
  const m = new Map([['0:0', '1']]);
  for (let r = 1; r < N; r++) m.set(r + ':0', '=A' + r + '+1');
  const eng = new Engine({ raw: (r, c) => m.get(r + ':' + c) ?? '', rows: () => N, cols: () => 1 });
  const t = Date.now();
  assert.equal(eng.value(N - 1, 0), N);
  assert.ok(Date.now() - t < 5000, '用了 ' + (Date.now() - t) + 'ms');
});

test('缓存：invalidate 之后重新计算', () => {
  const s = sheet({ A1: '1', B1: '=A1*2' });
  assert.equal(s.at('B1'), 2);
  s.m.set('0:0', '5');
  assert.equal(s.at('B1'), 2, '没 invalidate 前还是旧值');
  s.eng.invalidate();
  assert.equal(s.at('B1'), 10);
});

test('单引号开头强制为文本', () => {
  assert.equal(calc('=A1&""', { A1: "'=1+1" }), '=1+1');
});

test('解析：整列 / 整行引用、$ 锚点、函数名里带数字', () => {
  assert.equal(parse('SUM(A:A)').args[0].type, 'range');
  assert.equal(parse('SUM(1:3)').args[0].a.c, null);
  assert.equal(parse('LOG10(100)').name, 'LOG10');
  assert.equal(parse('ATAN2(1,1)').name, 'ATAN2');
  const r = parse('$A$1+B$2');
  assert.deepEqual([r.l.a.ar, r.l.a.ac, r.r.a.ar, r.r.a.ac], [true, true, true, false]);
  assert.throws(() => parse('1+'));
  assert.throws(() => parse('(1'));
});

test('shiftFormula：相对引用跟着走，$ 锚定的不动，出界变 #REF!', () => {
  assert.equal(shiftFormula('=A1+$B$2+C$3+$D4', 1, 1), '=B2+$B$2+D$3+$D5');
  assert.equal(shiftFormula('=SUM(A1:A10)', 2, 0), '=SUM(A3:A12)');
  assert.equal(shiftFormula('=SUM(A:A)', 5, 1), '=SUM(B:B)');
  assert.equal(shiftFormula('=A1', -1, 0), '=#REF!');
  assert.equal(shiftFormula('=  a1 +  "A1"', 1, 0), '=  A2 +  "A1"', '字符串里的 A1 不动，空格保留');
  assert.equal(shiftFormula('abc', 1, 1), 'abc');
});

test('adjustFormula：插入 / 删除行列', () => {
  // 在第 3 行（索引 2）上方插 2 行
  assert.equal(adjustFormula('=A1+A3+$A$5', 'row', 2, 2), '=A1+A5+$A$7');
  assert.equal(adjustFormula('=SUM(A1:A10)', 'row', 2, 2), '=SUM(A1:A12)');
  // 删除第 3~4 行（索引 2、3）
  assert.equal(adjustFormula('=A3', 'row', 2, -2), '=#REF!');
  assert.equal(adjustFormula('=A6+A1', 'row', 2, -2), '=A4+A1');
  assert.equal(adjustFormula('=SUM(A1:A10)', 'row', 2, -2), '=SUM(A1:A8)');
  assert.equal(adjustFormula('=SUM(A3:A4)', 'row', 2, -2), '=SUM(#REF!)');
  assert.equal(adjustFormula('=SUM(A2:A3)', 'row', 2, -2), '=SUM(A2:A2)');
  // 列
  assert.equal(adjustFormula('=B1+SUM(A:C)', 'col', 1, 1), '=C1+SUM(A:D)');
  assert.equal(adjustFormula('=SUM(A:A)', 'row', 0, 5), '=SUM(A:A)', '整列引用不受插行影响');
});

test('数字格式', () => {
  const f = (v, fmt) => formatValue(v, fmt).text;
  assert.equal(f(1234.5, ''), '1234.5');
  assert.equal(f(1234.567, '0.00'), '1234.57');
  assert.equal(f(1234567.891, '#,##0.00'), '1,234,567.89');
  assert.equal(f(-1234.5, '#,##0'), '-1,235');
  assert.equal(f(0.1234, '0.0%'), '12.3%');
  assert.equal(f(1234.5, '¥#,##0.00'), '¥1,234.50');
  assert.equal(f(12345, '0.00E+00'), '1.23E+04');
  assert.equal(f(1.5, '#.##'), '1.5');
  assert.equal(f(0.5, '0.00'), '0.50');
  assert.equal(f(-0.001, '0.00'), '0.00');
  const d = dateToSerial(2024, 3, 5) + 0.5;
  assert.equal(f(d, 'yyyy-mm-dd'), '2024-03-05');
  assert.equal(f(d, 'yyyy"年"m"月"d"日"'), '2024年3月5日');
  assert.equal(f(d, 'yyyy-mm-dd hh:mm'), '2024-03-05 12:00');
  assert.equal(f(d, 'h:mm AM/PM'), '12:00 PM');
  assert.equal(f(d, 'aaaa'), '星期二');
  assert.equal(f('2024-03-05', 'yyyy/m/d'), '2024/3/5', '日期文本也能套日期格式');
  assert.equal(f(-5, '0;[Red](0)'), '(5)');
  assert.equal(formatValue(-5, '0;[Red](0)').color, '#d93025');
  assert.equal(f(0, '0;-0;"零"'), '零');
  assert.equal(f('abc', '@'), 'abc');
  assert.equal(f(1e15, ''), '1E+15');
  assert.equal(f(123456789012, ''), '1.23457E+11');
  assert.ok(isDateFormat('yyyy-mm-dd'));
  assert.ok(!isDateFormat('0.00'));
});

test('增减小数位', () => {
  assert.equal(adjustDecimals('', 1, 1.5), '0.00');
  assert.equal(adjustDecimals('0.00', 1), '0.000');
  assert.equal(adjustDecimals('0.00', -1), '0.0');
  assert.equal(adjustDecimals('0.0', -1), '0');
  assert.equal(adjustDecimals('#,##0.00', -1), '#,##0.0');
  assert.equal(adjustDecimals('0%', 1), '0.0%');
});

if (failures) { console.error('\n  ' + failures + ' 个用例失败'); process.exit(1); }
