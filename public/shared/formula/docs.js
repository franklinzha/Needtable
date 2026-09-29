/**
 * 函数文档：编辑时的「?」详细帮助、插入函数对话框、公开的 /help 页面共用这一份。
 *
 * 每行一个函数，字段用 | 分隔：
 *   名称 | 分类 | 签名 | 说明 | 参数（「名: 说明」，多个用 ; 分隔）| 示例 | 结果
 * 签名里 [方括号] 是可选参数。
 *
 * 示例里不含单元格引用的，scripts/docs.test.mjs 会真的拿引擎算一遍、和「结果」比对 ——
 * 文档写的和引擎算的永远一致。结果里带中文的是描述，不参与比对。
 */

import { t } from '../i18n/i18n.js';

/** @type {[string, string][]} 分类 id → 显示名，顺序即 /help 页面上的顺序 */
export const CATEGORIES = [
  ['math', t('数学')],
  ['stat', t('统计')],
  ['logic', t('逻辑')],
  ['lookup', t('查找与引用')],
  ['text', t('文本')],
  ['date', t('日期与时间')],
  ['info', t('信息')],
  ['finance', t('财务')],
  ['ext', t('跨表引用')],
];

const RAW = `
ABS|math|ABS(数值)|返回数值的绝对值|数值: 任意实数|=ABS(-7.5)|7.5
ACOS|math|ACOS(数值)|反余弦，结果为弧度（0 到 π）|数值: -1 到 1 之间|=ACOS(1)|0
ASIN|math|ASIN(数值)|反正弦，结果为弧度（-π/2 到 π/2）|数值: -1 到 1 之间|=ASIN(0)|0
ATAN|math|ATAN(数值)|反正切，结果为弧度|数值: 任意实数|=ATAN(0)|0
ATAN2|math|ATAN2(x, y)|点 (x, y) 与 x 轴正方向的夹角，结果为弧度|x: x 坐标;y: y 坐标|=ATAN2(1, 0)|0
CEILING|math|CEILING(数值, [基数])|向上舍入到基数的最近倍数|数值: 要舍入的数;基数: 倍数，默认 1|=CEILING(4.2, 0.5)|4.5
CEILING.MATH|math|CEILING.MATH(数值, [基数], [模式])|向上舍入到基数的倍数；负数默认朝 0 舍入，模式非 0 时远离 0|数值: 要舍入的数;基数: 倍数，默认 1，正负号不影响;模式: 非 0 时负数远离 0 舍入|=CEILING.MATH(6.1)|7
COS|math|COS(弧度)|余弦|弧度: 角度 × PI()/180|=COS(0)|1
DEGREES|math|DEGREES(弧度)|弧度换算成角度|弧度: 弧度值|=DEGREES(PI())|180
EVEN|math|EVEN(数值)|向远离 0 的方向舍入到最近的偶数|数值: 任意实数|=EVEN(3)|4
EXP|math|EXP(数值)|e 的 n 次幂|数值: 指数|=EXP(0)|1
FACT|math|FACT(数值)|阶乘 n!|数值: 非负整数，小数部分舍去|=FACT(5)|120
FLOOR|math|FLOOR(数值, [基数])|向下舍入到基数的最近倍数|数值: 要舍入的数;基数: 倍数，默认 1|=FLOOR(4.7, 0.5)|4.5
FLOOR.MATH|math|FLOOR.MATH(数值, [基数], [模式])|向下舍入到基数的倍数；负数默认远离 0 舍入，模式非 0 时朝 0|数值: 要舍入的数;基数: 倍数，默认 1，正负号不影响;模式: 非 0 时负数朝 0 舍入|=FLOOR.MATH(6.9)|6
GCD|math|GCD(数值1, [数值2], ...)|最大公约数|数值: 非负整数|=GCD(12, 18)|6
INT|math|INT(数值)|向下取整到最接近的整数|数值: 任意实数|=INT(-2.5)|-3
LCM|math|LCM(数值1, [数值2], ...)|最小公倍数|数值: 正整数|=LCM(4, 6)|12
LN|math|LN(数值)|自然对数|数值: 正数|=LN(1)|0
LOG|math|LOG(数值, [底数])|以指定底数求对数|数值: 正数;底数: 默认 10|=LOG(8, 2)|3
LOG10|math|LOG10(数值)|以 10 为底的对数|数值: 正数|=LOG10(1000)|3
MOD|math|MOD(被除数, 除数)|余数，符号与除数相同|被除数: 要被除的数;除数: 不能为 0|=MOD(10, 3)|1
MROUND|math|MROUND(数值, 基数)|舍入到基数的最近倍数（四舍五入）|数值: 要舍入的数;基数: 倍数|=MROUND(7, 5)|5
ODD|math|ODD(数值)|向远离 0 的方向舍入到最近的奇数|数值: 任意实数|=ODD(2)|3
PI|math|PI()|圆周率 π|（无参数）|=ROUND(PI(), 4)|3.1416
POWER|math|POWER(底数, 指数)|乘方，等同于 底数^指数|底数: 任意实数;指数: 任意实数|=POWER(2, 10)|1024
PRODUCT|math|PRODUCT(数值1, [数值2], ...)|所有参数的乘积；区域里的文本和空格被忽略|数值: 数字、单元格或区域|=PRODUCT(2, 3, 4)|24
QUOTIENT|math|QUOTIENT(被除数, 除数)|整除，只保留商的整数部分|被除数: 要被除的数;除数: 不能为 0|=QUOTIENT(7, 2)|3
RADIANS|math|RADIANS(角度)|角度换算成弧度|角度: 角度值|=RADIANS(180)=PI()|TRUE
RAND|math|RAND()|0（含）到 1（不含）之间的随机数，每次重算都会变|（无参数）|=RAND()|例如 0.7236
RANDBETWEEN|math|RANDBETWEEN(下限, 上限)|两个整数之间的随机整数（含两端）|下限: 最小整数;上限: 最大整数|=RANDBETWEEN(1, 6)|1 到 6 之间的某个整数
ROUND|math|ROUND(数值, 小数位数)|四舍五入到指定位数；位数为负时舍入到十位、百位|数值: 要舍入的数;小数位数: 保留几位，负数表示小数点左边|=ROUND(3.14159, 2)|3.14
ROUNDDOWN|math|ROUNDDOWN(数值, 小数位数)|朝 0 的方向舍入|数值: 要舍入的数;小数位数: 保留几位|=ROUNDDOWN(3.789, 1)|3.7
ROUNDUP|math|ROUNDUP(数值, 小数位数)|朝远离 0 的方向舍入|数值: 要舍入的数;小数位数: 保留几位|=ROUNDUP(3.201, 1)|3.3
SIGN|math|SIGN(数值)|正数返回 1，负数返回 -1，0 返回 0|数值: 任意实数|=SIGN(-12)|-1
SIN|math|SIN(弧度)|正弦|弧度: 角度 × PI()/180|=SIN(0)|0
SQRT|math|SQRT(数值)|平方根|数值: 非负数|=SQRT(81)|9
SUBTOTAL|math|SUBTOTAL(函数编号, 区域1, ...)|分类汇总；1 平均 2 计数 3 非空计数 4 最大 5 最小 6 乘积 7 标准差 9 求和，101–111 忽略隐藏行|函数编号: 1–11 或 101–111;区域: 要汇总的区域|=SUBTOTAL(9, A2:A100)|A2:A100 的合计
SUM|math|SUM(数值1, [数值2], ...)|求和；区域里的文本和空格被忽略|数值: 数字、单元格或区域|=SUM(1, 2, 3)|6
SUMIF|math|SUMIF(区域, 条件, [求和区域])|对满足条件的单元格求和|区域: 用来判断条件的区域;条件: 如 ">100"、"北京"、"<>" 等;求和区域: 省略时对「区域」本身求和|=SUMIF(B2:B9, "华东", C2:C9)|华东地区 C 列的合计
SUMIFS|math|SUMIFS(求和区域, 条件区域1, 条件1, ...)|对同时满足多个条件的单元格求和|求和区域: 要加总的区域;条件区域: 用来判断的区域;条件: 与条件区域成对出现|=SUMIFS(D2:D9, B2:B9, "华东", C2:C9, ">100")|华东且数量大于 100 的合计
SUMPRODUCT|math|SUMPRODUCT(数组1, [数组2], ...)|对应元素相乘后求和|数组: 尺寸相同的区域|=SUMPRODUCT(B2:B9, C2:C9)|数量 × 单价 的总和
SUMSQ|math|SUMSQ(数值1, [数值2], ...)|各参数平方之和|数值: 数字、单元格或区域|=SUMSQ(3, 4)|25
TAN|math|TAN(弧度)|正切|弧度: 角度 × PI()/180|=TAN(0)|0
TRUNC|math|TRUNC(数值, [小数位数])|直接截断小数部分，不做舍入|数值: 要截断的数;小数位数: 默认 0|=TRUNC(-2.7)|-2
AVERAGE|stat|AVERAGE(数值1, [数值2], ...)|算术平均值；区域里的文本和空格被忽略|数值: 数字、单元格或区域|=AVERAGE(2, 4, 9)|5
AVERAGEA|stat|AVERAGEA(值1, [值2], ...)|平均值，区域里的文本按 0、TRUE 按 1 计入|值: 数字、单元格或区域|=AVERAGEA(A2:A9)|包含文本单元格的平均
AVERAGEIF|stat|AVERAGEIF(区域, 条件, [平均区域])|满足条件的单元格的平均值|区域: 用来判断条件的区域;条件: 如 ">0";平均区域: 省略时对「区域」本身求平均|=AVERAGEIF(C2:C9, ">0")|C 列正数的平均
AVERAGEIFS|stat|AVERAGEIFS(平均区域, 条件区域1, 条件1, ...)|同时满足多个条件的单元格的平均值|平均区域: 要求平均的区域;条件区域: 用来判断的区域;条件: 与条件区域成对出现|=AVERAGEIFS(D2:D9, B2:B9, "华东")|华东地区的平均
COUNT|stat|COUNT(值1, [值2], ...)|数字的个数|值: 单元格或区域|=COUNT(1, "a", 3)|2
COUNTA|stat|COUNTA(值1, [值2], ...)|非空单元格的个数|值: 单元格或区域|=COUNTA(1, "a", 3)|3
COUNTBLANK|stat|COUNTBLANK(区域)|空单元格的个数|区域: 要统计的区域|=COUNTBLANK(A2:A100)|A2:A100 里空白格的个数
COUNTIF|stat|COUNTIF(区域, 条件)|满足条件的单元格个数|区域: 要统计的区域;条件: 如 ">=60"、"张*"、"<>"|=COUNTIF(C2:C50, ">=60")|及格人数
COUNTIFS|stat|COUNTIFS(区域1, 条件1, [区域2, 条件2], ...)|同时满足多个条件的行数|区域: 用来判断的区域;条件: 与区域成对出现|=COUNTIFS(B2:B9, "华东", C2:C9, ">100")|华东且数量大于 100 的行数
LARGE|stat|LARGE(区域, k)|第 k 大的值|区域: 数值区域;k: 1 表示最大|=LARGE(C2:C50, 3)|第三名的分数
MAX|stat|MAX(数值1, [数值2], ...)|最大值|数值: 数字、单元格或区域|=MAX(4, 9, 2)|9
MAXA|stat|MAXA(值1, [值2], ...)|最大值，文本按 0、TRUE 按 1 计入|值: 数字、单元格或区域|=MAXA(A2:A9)|区域里的最大值
MAXIFS|stat|MAXIFS(最大值区域, 条件区域1, 条件1, ...)|满足条件的单元格里的最大值|最大值区域: 取最大值的区域;条件区域: 用来判断的区域;条件: 与条件区域成对出现|=MAXIFS(D2:D9, B2:B9, "华东")|华东地区的最大值
MEDIAN|stat|MEDIAN(数值1, [数值2], ...)|中位数|数值: 数字、单元格或区域|=MEDIAN(1, 3, 8, 10)|5.5
MIN|stat|MIN(数值1, [数值2], ...)|最小值|数值: 数字、单元格或区域|=MIN(4, 9, 2)|2
MINA|stat|MINA(值1, [值2], ...)|最小值，文本按 0、TRUE 按 1 计入|值: 数字、单元格或区域|=MINA(A2:A9)|区域里的最小值
MINIFS|stat|MINIFS(最小值区域, 条件区域1, 条件1, ...)|满足条件的单元格里的最小值|最小值区域: 取最小值的区域;条件区域: 用来判断的区域;条件: 与条件区域成对出现|=MINIFS(D2:D9, B2:B9, "华东")|华东地区的最小值
MODE|stat|MODE(数值1, [数值2], ...)|出现次数最多的值（众数）|数值: 数字、单元格或区域|=MODE(1, 2, 2, 3)|2
MODE.SNGL|stat|MODE.SNGL(数值1, [数值2], ...)|同 MODE|数值: 数字、单元格或区域|=MODE.SNGL(5, 5, 7)|5
PERCENTILE|stat|PERCENTILE(区域, k)|第 k 百分位数（k 在 0 到 1 之间，含两端）|区域: 数值区域;k: 0.9 表示第 90 百分位|=PERCENTILE(C2:C50, 0.9)|前 10% 的分数线
PERCENTILE.INC|stat|PERCENTILE.INC(区域, k)|同 PERCENTILE|区域: 数值区域;k: 0 到 1|=PERCENTILE.INC(C2:C50, 0.5)|中位数
QUARTILE|stat|QUARTILE(区域, 四分位)|四分位数；0 最小、1 下四分位、2 中位数、3 上四分位、4 最大|区域: 数值区域;四分位: 0–4|=QUARTILE(C2:C50, 1)|下四分位数
QUARTILE.INC|stat|QUARTILE.INC(区域, 四分位)|同 QUARTILE|区域: 数值区域;四分位: 0–4|=QUARTILE.INC(C2:C50, 3)|上四分位数
RANK|stat|RANK(数值, 区域, [升序])|数值在区域里的排名；相同的值排名相同|数值: 要排名的数;区域: 参与排名的区域;升序: 0 或省略为从大到小，非 0 为从小到大|=RANK(C2, C$2:C$50)|C2 在全体里的名次
RANK.EQ|stat|RANK.EQ(数值, 区域, [升序])|同 RANK|数值: 要排名的数;区域: 参与排名的区域;升序: 非 0 为从小到大|=RANK.EQ(C2, C$2:C$50)|C2 的名次
SMALL|stat|SMALL(区域, k)|第 k 小的值|区域: 数值区域;k: 1 表示最小|=SMALL(C2:C50, 1)|最低分
STDEV|stat|STDEV(数值1, [数值2], ...)|样本标准差|数值: 数字、单元格或区域|=STDEV(2, 4, 4, 4, 5, 5, 7, 9)|约 2.138
STDEV.P|stat|STDEV.P(数值1, [数值2], ...)|总体标准差|数值: 数字、单元格或区域|=STDEV.P(2, 4, 4, 4, 5, 5, 7, 9)|2
STDEV.S|stat|STDEV.S(数值1, [数值2], ...)|同 STDEV（样本标准差）|数值: 数字、单元格或区域|=STDEV.S(C2:C50)|样本标准差
STDEVP|stat|STDEVP(数值1, [数值2], ...)|同 STDEV.P（总体标准差）|数值: 数字、单元格或区域|=STDEVP(2, 4, 4, 4, 5, 5, 7, 9)|2
VAR|stat|VAR(数值1, [数值2], ...)|样本方差|数值: 数字、单元格或区域|=VAR(1, 2, 3, 4)|约 1.667
VAR.P|stat|VAR.P(数值1, [数值2], ...)|总体方差|数值: 数字、单元格或区域|=VAR.P(1, 2, 3, 4)|1.25
VAR.S|stat|VAR.S(数值1, [数值2], ...)|同 VAR（样本方差）|数值: 数字、单元格或区域|=VAR.S(C2:C50)|样本方差
VARP|stat|VARP(数值1, [数值2], ...)|同 VAR.P（总体方差）|数值: 数字、单元格或区域|=VARP(1, 2, 3, 4)|1.25
AND|logic|AND(条件1, [条件2], ...)|所有条件都为真时返回 TRUE|条件: 逻辑值或比较，如 A1>0|=AND(1<2, 3>2)|TRUE
FALSE|logic|FALSE()|逻辑值 FALSE|（无参数）|=FALSE()|FALSE
IF|logic|IF(条件, 真值, [假值])|条件为真返回真值，否则返回假值|条件: 逻辑判断，如 C2>=60;真值: 条件成立时的结果;假值: 省略时返回 FALSE|=IF(75>=60, "及格", "不及格")|及格
IFERROR|logic|IFERROR(值, 出错时的值)|值是错误（#DIV/0!、#N/A 等）时换成另一个值|值: 可能出错的表达式;出错时的值: 替代结果|=IFERROR(1/0, 0)|0
IFNA|logic|IFNA(值, 为 #N/A 时的值)|只在 #N/A 时替换，其它错误照常显示|值: 通常是查找函数;为 #N/A 时的值: 替代结果|=IFNA(NA(), "未找到")|未找到
IFS|logic|IFS(条件1, 值1, [条件2, 值2], ...)|按顺序检查条件，返回第一个成立的条件对应的值|条件: 逻辑判断;值: 与条件成对出现|=IFS(85>=90, "优", 85>=60, "良")|良
NOT|logic|NOT(条件)|逻辑取反|条件: 逻辑值或比较|=NOT(TRUE)|FALSE
OR|logic|OR(条件1, [条件2], ...)|任一条件为真就返回 TRUE|条件: 逻辑值或比较|=OR(1>2, 3>2)|TRUE
SWITCH|logic|SWITCH(表达式, 值1, 结果1, [值2, 结果2], ..., [默认])|表达式等于哪个值就返回对应结果，都不等时返回默认|表达式: 要比对的值;值: 候选值;结果: 与值成对出现;默认: 可选，放在最后|=SWITCH(2, 1, "一", 2, "二", "其它")|二
TRUE|logic|TRUE()|逻辑值 TRUE|（无参数）|=TRUE()|TRUE
XOR|logic|XOR(条件1, [条件2], ...)|为真的条件个数是奇数时返回 TRUE|条件: 逻辑值或比较|=XOR(TRUE, TRUE)|FALSE
CHOOSE|lookup|CHOOSE(序号, 值1, [值2], ...)|按序号从列表里挑一个值|序号: 从 1 开始;值: 候选值|=CHOOSE(2, "甲", "乙", "丙")|乙
COLUMN|lookup|COLUMN([引用])|引用所在的列号（A 列为 1）；省略时为公式所在列|引用: 单元格|=COLUMN(D1)|4
COLUMNS|lookup|COLUMNS(区域)|区域的列数|区域: 单元格区域|=COLUMNS(A1:E1)|5
HLOOKUP|lookup|HLOOKUP(查找值, 表格区域, 行序号, [近似匹配])|在首行查找，返回同一列里第 n 行的值|查找值: 要找的值;表格区域: 首行是查找行;行序号: 从 1 开始;近似匹配: FALSE 精确匹配（推荐）|=HLOOKUP("二月", A1:M3, 2, FALSE)|二月那一列第 2 行的值
INDEX|lookup|INDEX(区域, 行号, [列号])|区域里第 n 行第 m 列的值|区域: 单元格区域;行号: 从 1 开始;列号: 从 1 开始，单列区域可省略|=INDEX(A2:C9, 3, 2)|第 3 行第 2 列
LOOKUP|lookup|LOOKUP(查找值, 查找区域, [结果区域])|在已升序排列的区域里近似查找|查找值: 要找的值;查找区域: 升序排列的单行或单列;结果区域: 同尺寸的返回区域|=LOOKUP(75, A2:A6, B2:B6)|分数 75 对应的等级
MATCH|lookup|MATCH(查找值, 区域, [匹配类型])|查找值在区域里的位置|查找值: 要找的值;区域: 单行或单列;匹配类型: 0 精确，1 小于等于（升序），-1 大于等于（降序）|=MATCH("乙", A2:A9, 0)|「乙」在 A2:A9 里是第几个
ROW|lookup|ROW([引用])|引用所在的行号；省略时为公式所在行|引用: 单元格|=ROW(B7)|7
ROWS|lookup|ROWS(区域)|区域的行数|区域: 单元格区域|=ROWS(A2:A11)|10
TRANSPOSE|lookup|TRANSPOSE(区域)|行列互换|区域: 单元格区域|=TRANSPOSE(A1:C2)|3 行 2 列的结果，溢出到相邻单元格
SEQUENCE|lookup|SEQUENCE(行数, [列数], [起始], [步长])|生成一串等差数字，溢出到相邻单元格|行数: 结果的行数;列数: 结果的列数，默认 1;起始: 第一个数，默认 1;步长: 每次加多少，默认 1|=SEQUENCE(5, 1, 10, 10)|10、20、30、40、50 竖着排开
SORT|lookup|SORT(区域, [排序列], [顺序], [按列])|把区域按某一列排好序后整块返回|区域: 要排序的数据;排序列: 按第几列排，默认 1;顺序: 1 升序（默认），-1 降序;按列: TRUE 时按行排列的数据左右排序|=SORT(A2:C20, 3, -1)|按第 3 列从大到小排好的整块数据
UNIQUE|lookup|UNIQUE(区域, [按列], [仅一次])|去掉重复行，返回不重复的内容|区域: 数据;按列: TRUE 时比较列而不是行;仅一次: TRUE 时只返回只出现过一次的|=UNIQUE(B2:B100)|B 列去重后的列表
FILTER|lookup|FILTER(区域, 条件, [为空时])|按条件筛出符合的行，整块返回|区域: 数据;条件: 与区域等高的一列 TRUE/FALSE（如 C2:C20>100）;为空时: 一行都没筛到时显示的值，默认 #CALC!|=FILTER(A2:C20, C2:C20>100, "无")|C 列大于 100 的所有行
VLOOKUP|lookup|VLOOKUP(查找值, 表格区域, 列序号, [近似匹配])|在首列查找，返回同一行里第 n 列的值|查找值: 要找的值;表格区域: 首列是查找列;列序号: 从 1 开始;近似匹配: FALSE 精确匹配（推荐）|=VLOOKUP("P-102", A2:D100, 3, FALSE)|编号 P-102 那一行第 3 列
XLOOKUP|lookup|XLOOKUP(查找值, 查找区域, 返回区域, [未找到], [匹配模式], [搜索模式])|现代查找：查找列和返回列可以在任意位置|查找值: 要找的值;查找区域: 单行或单列;返回区域: 同尺寸的返回区域;未找到: 找不到时的结果，默认 #N/A;匹配模式: 0 精确，-1 精确或下一个较小，1 精确或下一个较大，2 通配符;搜索模式: 1 从头，-1 从尾|=XLOOKUP("P-102", A2:A100, D2:D100, "无")|编号 P-102 的 D 列值
XMATCH|lookup|XMATCH(查找值, 区域, [匹配模式], [搜索模式])|查找值在区域里的位置，默认精确匹配|查找值: 要找的值;区域: 单行或单列;匹配模式: 同 XLOOKUP;搜索模式: 1 从头，-1 从尾|=XMATCH("丙", A2:A9)|「丙」在 A2:A9 里是第几个
CHAR|text|CHAR(代码)|代码对应的字符|代码: 1–255|=CHAR(65)|A
CLEAN|text|CLEAN(文本)|删除不可打印字符|文本: 要清理的文本|=CLEAN(A2)|去掉换行等控制字符后的文本
CODE|text|CODE(文本)|第一个字符的代码|文本: 任意文本|=CODE("A")|65
CONCAT|text|CONCAT(文本1, [文本2], ...)|把多个文本或区域连接在一起|文本: 文本、单元格或区域|=CONCAT("Need", "table")|Needtable
CONCATENATE|text|CONCATENATE(文本1, [文本2], ...)|连接文本（旧写法，同 CONCAT 但不接受区域）|文本: 文本或单元格|=CONCATENATE("A", "-", 1)|A-1
EXACT|text|EXACT(文本1, 文本2)|两段文本是否完全相同（区分大小写）|文本1: 文本;文本2: 文本|=EXACT("abc", "ABC")|FALSE
FIND|text|FIND(要找的文本, 文本, [起始位置])|查找位置，区分大小写，不支持通配符|要找的文本: 子串;文本: 被查找的文本;起始位置: 默认 1|=FIND("b", "abcb")|2
FIXED|text|FIXED(数值, [小数位数], [不要千分位])|把数字格式化成固定小数位的文本|数值: 数字;小数位数: 默认 2;不要千分位: TRUE 时不加逗号|=FIXED(1234.567, 1)|1,234.6
LEFT|text|LEFT(文本, [字符数])|从左边取若干个字符|文本: 原文本;字符数: 默认 1|=LEFT("Needtable", 4)|Need
LEN|text|LEN(文本)|字符个数|文本: 任意文本|=LEN("你好ab")|4
LOWER|text|LOWER(文本)|转成小写|文本: 任意文本|=LOWER("ABC")|abc
MID|text|MID(文本, 起始位置, 字符数)|从中间取若干个字符|文本: 原文本;起始位置: 从 1 开始;字符数: 取几个|=MID("Needtable", 5, 5)|table
NUMBERVALUE|text|NUMBERVALUE(文本, [小数点], [千分位])|按指定的分隔符把文本转成数字|文本: 要转换的文本;小数点: 默认 ".";千分位: 默认 ","|=NUMBERVALUE("1.234,5", ",", ".")|1234.5
PROPER|text|PROPER(文本)|每个单词首字母大写|文本: 任意文本|=PROPER("hello world")|Hello World
REPLACE|text|REPLACE(原文本, 起始位置, 字符数, 新文本)|按位置替换一段字符|原文本: 原文本;起始位置: 从 1 开始;字符数: 替换几个;新文本: 换成什么|=REPLACE("2024-01", 1, 4, "2025")|2025-01
REPT|text|REPT(文本, 次数)|重复文本若干次|文本: 要重复的文本;次数: 非负整数|=REPT("★", 3)|★★★
RIGHT|text|RIGHT(文本, [字符数])|从右边取若干个字符|文本: 原文本;字符数: 默认 1|=RIGHT("Needtable", 5)|table
SEARCH|text|SEARCH(要找的文本, 文本, [起始位置])|查找位置，不区分大小写，支持 * 和 ? 通配符|要找的文本: 子串;文本: 被查找的文本;起始位置: 默认 1|=SEARCH("B", "abc")|2
SUBSTITUTE|text|SUBSTITUTE(文本, 旧文本, 新文本, [第几个])|按内容替换文本|文本: 原文本;旧文本: 要换掉的内容;新文本: 换成什么;第几个: 只换第 n 处，省略则全部替换|=SUBSTITUTE("a-b-c", "-", "/")|a/b/c
T|text|T(值)|值是文本就返回它，否则返回空文本|值: 任意值|=T(123)|
TEXT|text|TEXT(值, 格式)|按格式把数字或日期显示成文本|值: 数字或日期;格式: 如 "0.00"、"#,##0"、"0%"、"yyyy-mm-dd"|=TEXT(0.256, "0.0%")|25.6%
TEXTAFTER|text|TEXTAFTER(文本, 分隔符, [第几个])|取分隔符之后的部分|文本: 原文本;分隔符: 如 "@";第几个: 默认 1，负数从末尾数|=TEXTAFTER("user@example.com", "@")|example.com
TEXTBEFORE|text|TEXTBEFORE(文本, 分隔符, [第几个])|取分隔符之前的部分|文本: 原文本;分隔符: 如 "@";第几个: 默认 1，负数从末尾数|=TEXTBEFORE("user@example.com", "@")|user
TEXTJOIN|text|TEXTJOIN(分隔符, 忽略空值, 文本1, [文本2], ...)|用分隔符把多个文本或区域连接在一起|分隔符: 如 "、";忽略空值: TRUE 跳过空单元格;文本: 文本、单元格或区域|=TEXTJOIN("、", TRUE, "甲", "", "乙")|甲、乙
TRIM|text|TRIM(文本)|去掉首尾空格，中间连续空格保留一个|文本: 任意文本|=TRIM("  a   b ")|a b
UNICHAR|text|UNICHAR(代码)|Unicode 代码对应的字符|代码: Unicode 码位|=UNICHAR(9733)|★
UNICODE|text|UNICODE(文本)|第一个字符的 Unicode 码位|文本: 任意文本|=UNICODE("A")|65
UPPER|text|UPPER(文本)|转成大写|文本: 任意文本|=UPPER("abc")|ABC
VALUE|text|VALUE(文本)|把看起来像数字的文本转成数字|文本: 如 "12.5"、"50%"|=VALUE("12.5")|12.5
DATE|date|DATE(年, 月, 日)|由年、月、日组成日期；月和日超出范围会自动进位|年: 四位年份;月: 1–12;日: 1–31|=YEAR(DATE(2024, 13, 1))|2025
DATEDIF|date|DATEDIF(开始日期, 结束日期, 单位)|两个日期之间相差的整年、整月或天数|开始日期: 较早的日期;结束日期: 较晚的日期;单位: "Y" 年，"M" 月，"D" 天，"MD"、"YM"、"YD" 忽略更大单位|=DATEDIF(DATE(2020,1,15), DATE(2024,3,1), "Y")|4
DATEVALUE|date|DATEVALUE(日期文本)|把日期文本转成日期序号|日期文本: 如 "2024-03-15"|=DAY(DATEVALUE("2024-03-15"))|15
DAY|date|DAY(日期)|日期里的「日」|日期: 日期或日期序号|=DAY(DATE(2024, 3, 15))|15
DAYS|date|DAYS(结束日期, 开始日期)|两个日期相差的天数|结束日期: 较晚的日期;开始日期: 较早的日期|=DAYS(DATE(2024,3,1), DATE(2024,2,1))|29
EDATE|date|EDATE(开始日期, 月数)|若干个月之前或之后的同一天|开始日期: 日期;月数: 正数往后，负数往前|=MONTH(EDATE(DATE(2024,1,31), 1))|2
EOMONTH|date|EOMONTH(开始日期, 月数)|若干个月之前或之后那个月的最后一天|开始日期: 日期;月数: 0 表示当月|=DAY(EOMONTH(DATE(2024,2,10), 0))|29
HOUR|date|HOUR(时间)|时间里的小时（0–23）|时间: 时间或日期时间|=HOUR(TIME(14, 30, 0))|14
ISOWEEKNUM|date|ISOWEEKNUM(日期)|ISO 周数（周一为一周的第一天）|日期: 日期|=ISOWEEKNUM(DATE(2024, 1, 1))|1
MINUTE|date|MINUTE(时间)|时间里的分钟（0–59）|时间: 时间或日期时间|=MINUTE(TIME(14, 30, 0))|30
MONTH|date|MONTH(日期)|日期里的月份（1–12）|日期: 日期|=MONTH(DATE(2024, 3, 15))|3
NETWORKDAYS|date|NETWORKDAYS(开始日期, 结束日期, [节假日])|两个日期之间的工作日天数（不含周六日和节假日，含两端）|开始日期: 日期;结束日期: 日期;节假日: 节假日日期的区域|=NETWORKDAYS(DATE(2024,3,4), DATE(2024,3,10))|5
NOW|date|NOW()|当前日期和时间，每次重算都会变|（无参数）|=NOW()|当前日期时间
SECOND|date|SECOND(时间)|时间里的秒（0–59）|时间: 时间或日期时间|=SECOND(TIME(14, 30, 45))|45
TIME|date|TIME(时, 分, 秒)|由时、分、秒组成时间（一天的小数部分）|时: 0–23;分: 0–59;秒: 0–59|=TIME(12, 0, 0)|0.5
TIMEVALUE|date|TIMEVALUE(时间文本)|把时间文本转成一天的小数部分|时间文本: 如 "18:00"|=TIMEVALUE("18:00")|0.75
TODAY|date|TODAY()|今天的日期，每天自动更新|（无参数）|=TODAY()|今天
WEEKDAY|date|WEEKDAY(日期, [类型])|星期几；类型 1（默认）周日为 1，类型 2 周一为 1|日期: 日期;类型: 1、2 或 3|=WEEKDAY(DATE(2024, 3, 4), 2)|1
WEEKNUM|date|WEEKNUM(日期, [类型])|一年中的第几周；类型 1（默认）周日开始，类型 2 周一开始|日期: 日期;类型: 1 或 2|=WEEKNUM(DATE(2024, 1, 7))|2
WORKDAY|date|WORKDAY(开始日期, 天数, [节假日])|若干个工作日之后的日期|开始日期: 日期;天数: 工作日天数;节假日: 节假日日期的区域|=DAY(WORKDAY(DATE(2024,3,8), 1))|11
YEAR|date|YEAR(日期)|日期里的年份|日期: 日期|=YEAR(DATE(2024, 3, 15))|2024
YEARFRAC|date|YEARFRAC(开始日期, 结束日期, [基准])|两个日期之间相差的年数（带小数）|开始日期: 日期;结束日期: 日期;基准: 0 美式 30/360（默认），1 实际/实际，2 实际/360，3 实际/365，4 欧式 30/360|=YEARFRAC(DATE(2024,1,1), DATE(2024,7,1))|0.5
ISBLANK|info|ISBLANK(值)|是否为空单元格|值: 通常是单元格|=ISBLANK(A1)|A1 为空时 TRUE
ISERR|info|ISERR(值)|是否为除 #N/A 以外的错误|值: 任意表达式|=ISERR(1/0)|TRUE
ISERROR|info|ISERROR(值)|是否为任意错误|值: 任意表达式|=ISERROR(NA())|TRUE
ISEVEN|info|ISEVEN(数值)|是否为偶数|数值: 数字|=ISEVEN(4)|TRUE
ISLOGICAL|info|ISLOGICAL(值)|是否为逻辑值|值: 任意值|=ISLOGICAL(TRUE)|TRUE
ISNA|info|ISNA(值)|是否为 #N/A|值: 任意表达式|=ISNA(NA())|TRUE
ISNONTEXT|info|ISNONTEXT(值)|是否不是文本（空单元格也算）|值: 任意值|=ISNONTEXT(12)|TRUE
ISNUMBER|info|ISNUMBER(值)|是否为数字|值: 任意值|=ISNUMBER(12)|TRUE
ISODD|info|ISODD(数值)|是否为奇数|数值: 数字|=ISODD(3)|TRUE
ISTEXT|info|ISTEXT(值)|是否为文本|值: 任意值|=ISTEXT("a")|TRUE
N|info|N(值)|数字原样返回，TRUE 为 1，其它为 0|值: 任意值|=N(TRUE)|1
NA|info|NA()|返回 #N/A 错误，用来标记「暂无数据」|（无参数）|=NA()|#N/A
FV|finance|FV(利率, 期数, 每期付款, [现值], [类型])|按固定利率定期定额投资的未来值|利率: 每期利率;期数: 总期数;每期付款: 支出为负数;现值: 默认 0;类型: 0 期末（默认），1 期初|=ROUND(FV(0.05, 10, -100), 2)|1257.79
IRR|finance|IRR(现金流, [猜测值])|一组现金流的内部收益率|现金流: 包含至少一个负数和一个正数的区域;猜测值: 默认 0.1|=IRR(B2:B7)|现金流的内部收益率
NPV|finance|NPV(折现率, 现金流1, [现金流2], ...)|按折现率计算未来现金流的净现值（第一笔在第 1 期末）|折现率: 每期折现率;现金流: 数字或区域|=ROUND(NPV(0.1, 110, 121), 2)|200
PMT|finance|PMT(利率, 期数, 现值, [终值], [类型])|贷款每期还款额（结果为负数表示支出）|利率: 每期利率，年利率/12;期数: 总期数;现值: 贷款金额;终值: 默认 0;类型: 0 期末，1 期初|=ROUND(PMT(0.05/12, 360, 1000000), 2)|-5368.22
PV|finance|PV(利率, 期数, 每期付款, [终值], [类型])|未来一系列付款的现值|利率: 每期利率;期数: 总期数;每期付款: 每期金额;终值: 默认 0;类型: 0 期末，1 期初|=ROUND(PV(0.05, 10, -100), 2)|772.17
IMPORTRANGE|ext|IMPORTRANGE(表编号或链接, 区域)|引用另一张表的一块区域。表编号就是地址栏 /t/ 后面那一段，也可以直接粘贴整条表格链接|表编号或链接: 如 "tbl_xxx" 或 "https://table.example.com/t/tbl_xxx";区域: 如 "A1:C10"、"B:B"|=SUM(IMPORTRANGE("tbl_xxx", "B2:B100"))|另一张表 B 列的合计
`;

/**
 * @typedef {{ name: string, cat: string, sig: string, desc: string,
 *             params: [string, string][], example: string, result: string }} FnDoc
 */

// ── i18n：从 RAW 收集所有需要翻译的中文字段原文（供 scripts/i18n.mjs 扫描） ──────
const _han = /[㐀-鿿]/;
/** @type {string[]} */
export const I18N_KEYS = [];
{
  const _seen = new Set();
  const _key = (s) => { if (s && _han.test(s) && !_seen.has(s)) { _seen.add(s); I18N_KEYS.push(s); } };
  for (const _line of RAW.split('\n')) {
    if (!_line.trim()) continue;
    const [, , , _desc, _params, , _result = ''] = _line.split('|');
    _key(_desc);
    if (!_params.startsWith('（')) {
      for (const _p of _params.split(';')) {
        const _i = _p.indexOf(':');
        if (_i >= 0) _key(_p.slice(_i + 1).trim());
      }
    }
    _key(_result);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Record<string, FnDoc>} */
export const DOCS = {};
for (const line of RAW.split('\n')) {
  if (!line.trim()) continue;
  const [name, cat, sig, desc, params, example, result = ''] = line.split('|');
  DOCS[name] = {
    name, cat, sig, desc: t(desc),
    params: params.startsWith('（') ? [] : params.split(';').map((p) => {
      const i = p.indexOf(':');
      return /** @type {[string, string]} */ ([p.slice(0, i).trim(), t(p.slice(i + 1).trim())]);
    }),
    example, result: _han.test(result) ? t(result) : result,
  };
}

/** 帮助页上某个函数的地址。 @param {string} name */
export const helpUrl = (name) => '/help#' + encodeURIComponent(name);

/**
 * 一行短说明（自动完成列表、提示条用）。没有文档的函数退回名字本身。
 * @param {string} name @returns {[string, string]} [签名, 说明]
 */
export function brief(name) {
  const d = DOCS[name];
  return d ? [d.sig, d.desc] : [name + '()', ''];
}
