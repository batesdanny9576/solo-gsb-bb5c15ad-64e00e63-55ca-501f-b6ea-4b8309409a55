'use strict';

// 核心引擎单元测试：node tests/engine.test.js
const assert = require('assert');
const E = require('../public/engine.js');

const cue = (start, end, text = 'x') => ({ start, end, text });
const snap = (cues) => cues.map((c) => ({ start: c.start, end: c.end }));
const times = (cues) => cues.map((c) => [c.start, c.end]);

function assertValid(cues, label) {
  cues.forEach((c, i) => {
    assert(c.start >= 0, `${label}: 第${i + 1}块起点为负`);
    assert(c.end - c.start >= E.MIN_DUR, `${label}: 第${i + 1}块时长不足 ${E.MIN_DUR}ms`);
    if (i > 0) {
      assert(c.start - cues[i - 1].end >= E.MIN_GAP, `${label}: 第${i + 1}块间隔不足 ${E.MIN_GAP}ms`);
    }
  });
}

// 1. 时间码格式化 / 解析
assert.strictEqual(E.fmtTime(0), '00:00:00,000');
assert.strictEqual(E.fmtTime(3723456), '01:02:03,456');
assert.strictEqual(E.parseTimecode('01:02:03,456'), 3723456);
assert.strictEqual(E.parseTimecode('00:00:01.500'), 1500);
assert.strictEqual(E.parseTimecode('00:00:00,5'), 500);
assert.strictEqual(E.parseTimecode('bad'), null);

// 2. SRT 解析与生成往返一致
const src = '1\n00:00:01,000 --> 00:00:02,500\n你好\n\n2\n00:00:03,000 --> 00:00:04,000\n第二行\n换行\n';
const parsed = E.parseSRT(src);
assert.strictEqual(parsed.length, 2);
assert.strictEqual(parsed[0].start, 1000);
assert.strictEqual(parsed[0].end, 2500);
assert.strictEqual(parsed[1].text, '第二行\n换行');
const roundtrip = E.parseSRT(E.toSRT(parsed));
assert.deepStrictEqual(times(roundtrip), times(parsed));
assert.strictEqual(roundtrip[1].text, parsed[1].text);
// 导出文件重新顺序编号
assert.ok(E.toSRT(parsed).startsWith('1\n00:00:01,000 --> 00:00:02,500\n'));

// 3. 导入规范化：负起点、时长不足、间隔不足都被修复
const bad = [cue(-500, 300), cue(400, 700), cue(750, 1000)];
E.normalizeCues(bad);
assertValid(bad, 'normalize');
assert.strictEqual(bad[0].start, 0);

// 4. 拖右边界越过后继安全线：递归推移所有受影响后继，且保持各自时长
let cues = [cue(0, 1000), cue(1100, 2100), cue(2200, 3200), cue(10000, 11000)];
let orig = snap(cues);
E.applyDrag(cues, orig, 0, 'end', 2500); // end: 1000 -> 3500，越线 2400
assert.deepStrictEqual(times(cues), [
  [0, 3500],
  [3600, 4600], // 时长 1000 不变
  [4700, 5700], // 时长 1000 不变
  [10000, 11000], // 间隔已满足，不受影响
]);
assertValid(cues, 'push');

// 5. 向回拖动只释放空隙，不拉回后继
cues = [cue(0, 3000), cue(5000, 6000)];
orig = snap(cues);
E.applyDrag(cues, orig, 0, 'end', -1500); // end: 3000 -> 1500
assert.deepStrictEqual(times(cues), [
  [0, 1500],
  [5000, 6000], // 后继保持不动
]);

// 6. 最短时长约束：右边界不能拖到 start+500 以内
E.applyDrag(cues, orig, 0, 'end', -99999);
assert.strictEqual(cues[0].end, cues[0].start + E.MIN_DUR);

// 7. 左边界约束：不早于 前块end+100、不早于 0、不晚于 end-500
cues = [cue(0, 1000), cue(1100, 2100)];
orig = snap(cues);
E.applyDrag(cues, orig, 1, 'start', -99999);
assert.strictEqual(cues[1].start, 1100); // 夹在前块 end+100
E.applyDrag(cues, orig, 0, 'start', -500);
assert.strictEqual(cues[0].start, 0); // 第一块夹在 0
E.applyDrag(cues, orig, 1, 'start', 99999);
assert.strictEqual(cues[1].start, 1600); // 夹在 end-500

// 8. 整体移动：向右越线推移后继；向左夹在 前块end+100 / 0；时长不变
cues = [cue(0, 1000), cue(1100, 2100), cue(2200, 3200)];
orig = snap(cues);
E.applyDrag(cues, orig, 1, 'move', 1500);
assert.deepStrictEqual(times(cues), [
  [0, 1000],
  [2600, 3600],
  [3700, 4700], // 被递归推移，时长保持 1000
]);
E.applyDrag(cues, orig, 1, 'move', -99999);
assert.strictEqual(cues[1].start, 1100); // 夹在前块 end+100
E.applyDrag(cues, orig, 0, 'move', -99999);
assert.deepStrictEqual(times(cues)[0], [0, 1000]); // 第一块夹在 0，时长不变

// 9. 同一手势内多次施加是幂等的（每次都从快照还原）
cues = [cue(0, 1000), cue(1100, 2100)];
orig = snap(cues);
E.applyDrag(cues, orig, 0, 'end', 5000);
E.applyDrag(cues, orig, 0, 'end', 0);
assert.deepStrictEqual(times(cues), [
  [0, 1000],
  [1100, 2100],
]);

// 10. 长链递归推移：一块越线推到底
cues = [];
for (let i = 0; i < 50; i++) cues.push(cue(i * 1100, i * 1100 + 1000));
orig = snap(cues);
E.applyDrag(cues, orig, 0, 'end', 20000); // 第一块 end 推到 21000
assertValid(cues, 'chain');
// 推移后第 1 块 start = 21000+100，之后每块间隔 100、时长 1000
assert.strictEqual(cues[1].start, 21100);
assert.strictEqual(cues[49].start, 21100 + 48 * 1100);
assert.strictEqual(cues[49].end - cues[49].start, 1000); // 时长保持
