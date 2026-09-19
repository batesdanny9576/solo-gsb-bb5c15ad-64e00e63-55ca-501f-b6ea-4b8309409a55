/*
 * SRT 时间轴修整核心引擎（纯逻辑，无 DOM 依赖）
 * 同时支持浏览器（window.SRTEngine）与 Node.js（module.exports，供单元测试使用）。
 *
 * 全局约束：
 *   - 每块时长 >= MIN_DUR (500ms)
 *   - 相邻块间隔 >= MIN_GAP (100ms)
 *   - 块起点 >= 0
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SRTEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_DUR = 500; // 每块最短时长（毫秒）
  const MIN_GAP = 100; // 相邻块最小间隔（毫秒）

  function pad(n, w) {
    return String(n).padStart(w, '0');
  }

  // 毫秒 -> "HH:MM:SS,mmm"
  function fmtTime(ms) {
    ms = Math.max(0, Math.round(ms));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const mmm = ms % 1000;
    return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(mmm, 3)}`;
  }

  // "HH:MM:SS,mmm" 或 "HH:MM:SS.mmm" -> 毫秒；非法返回 null
  function parseTimecode(str) {
    const m = String(str).trim().match(/^(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
    if (!m) return null;
    return (
      Number(m[1]) * 3600000 +
      Number(m[2]) * 60000 +
      Number(m[3]) * 1000 +
      Number(m[4].padEnd(3, '0'))
    );
  }

  // 解析 SRT 文本 -> [{start, end, text}]（时间单位：毫秒）
  function parseSRT(text) {
    const clean = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'); // 去 BOM、统一换行
    const cues = [];
    for (const block of clean.split(/\n{2,}/)) {
      const lines = block
        .split('\n')
        .map((l) => l.replace(/\s+$/, ''))
        .filter((l) => l.trim() !== '');
      if (!lines.length) continue;
      const ti = lines.findIndex((l) => l.includes('-->'));
      if (ti === -1) continue;
      const m = lines[ti].match(
        /(\d{1,3}:\d{1,2}:\d{1,2}[,.]\d{1,3})\s*-->\s*(\d{1,3}:\d{1,2}:\d{1,2}[,.]\d{1,3})/
      );
      if (!m) continue;
      const start = parseTimecode(m[1]);
      const end = parseTimecode(m[2]);
      if (start === null || end === null) continue;
      cues.push({ start, end, text: lines.slice(ti + 1).join('\n') });
    }
    return cues;
  }

  // [{start, end, text}] -> 合法 SRT 文本（重新顺序编号）
  function toSRT(cues) {
    return (
      cues
        .map((c, i) => `${i + 1}\n${fmtTime(c.start)} --> ${fmtTime(c.end)}\n${c.text}`)
        .join('\n\n') + '\n'
    );
  }

  /*
   * 导入后规范化（原地修改并返回）：
   * 按开始时间排序后，依次保证 起点>=0、间隔>=MIN_GAP、时长>=MIN_DUR；
   * 不满足时把当前块整体向后推移（保持时长），后续块在后续迭代中同样被推移。
   */
  function normalizeCues(cues) {
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    let prevEnd = -MIN_GAP;
    for (const c of cues) {
      const minStart = Math.max(0, prevEnd + MIN_GAP);
      if (c.start < minStart) {
        const shift = minStart - c.start;
        c.start += shift;
        c.end += shift;
      }
      if (c.end - c.start < MIN_DUR) c.end = c.start + MIN_DUR;
      prevEnd = c.end;
    }
    return cues;
  }

  /*
   * 将第 i 块之后所有受影响的后继块递归向后推移：
   * 每块保持自身时长不变，仅平移到满足最小间隔的位置；
   * 一旦某块间隔已满足，其后块均不受影响，提前结束。
   */
  function pushSuccessors(cues, i) {
    for (let j = i + 1; j < cues.length; j++) {
      const minStart = cues[j - 1].end + MIN_GAP;
      if (cues[j].start < minStart) {
        const dur = cues[j].end - cues[j].start;
        cues[j].start = minStart;
        cues[j].end = minStart + dur;
      } else {
        break;
      }
    }
  }

  /*
   * 拖动应用函数（原地修改 cues）：
   * 每次调用先从拖动起始快照 orig 还原，再施加本次手势的总位移 deltaMs，
   * 因此同一次手势内来回拖动是幂等的，不会累积误差。
   *
   * edge:
   *   'end'   拖动右边界：最小受 start+MIN_DUR 限制；越过下一块安全线时递归推移后继（保持其时长）。
   *   'start' 拖动左边界：夹在 [max(0, 前块end+MIN_GAP), end-MIN_DUR] 之间，不影响其它块。
   *   'move'  整体移动：向左受 前块end+MIN_GAP 与 0 限制；向右越线时递归推移后继。
   * 向回拖动（缩小/左移）只释放空隙，不会把后继块拉回来。
   */
  function applyDrag(cues, orig, index, edge, deltaMs) {
    for (let i = 0; i < cues.length; i++) {
      cues[i].start = orig[i].start;
      cues[i].end = orig[i].end;
    }
    const c = cues[index];

    if (edge === 'end') {
      c.end = Math.max(orig[index].end + deltaMs, c.start + MIN_DUR);
      pushSuccessors(cues, index);
    } else if (edge === 'start') {
      const minStart = index > 0 ? cues[index - 1].end + MIN_GAP : 0;
      const s = Math.max(orig[index].start + deltaMs, minStart, 0);
      c.start = Math.min(s, c.end - MIN_DUR);
    } else if (edge === 'move') {
      const dur = orig[index].end - orig[index].start;
      const minStart = index > 0 ? cues[index - 1].end + MIN_GAP : 0;
      const s = Math.max(orig[index].start + deltaMs, minStart, 0);
      c.start = s;
      c.end = s + dur;
      pushSuccessors(cues, index);
    }
    return cues;
  }

  return {
    MIN_DUR,
    MIN_GAP,
    fmtTime,
    parseTimecode,
    parseSRT,
    toSRT,
    normalizeCues,
    pushSuccessors,
    applyDrag,
  };
});
