/* global SRTEngine */
'use strict';

const { MIN_DUR, MIN_GAP, parseSRT, toSRT, normalizeCues, applyDrag, fmtTime } = SRTEngine;

// ---------- 常量与状态 ----------
const ZOOM_MIN = 0.01; // px/ms（10 px/s）
const ZOOM_MAX = 2; // px/ms（2000 px/s）
const UNDO_LIMIT = 100;
const SLIDER_MAX = 1000;

const state = {
  cues: [], // [{start, end, text}]，时间单位 ms
  pxPerMs: 0.1,
  undoStack: [], // 每次拖动前的 [{start,end}] 快照
  selected: -1,
  fileBase: 'edited',
};

// ---------- DOM 引用 ----------
const $ = (id) => document.getElementById(id);
const viewport = $('timelineViewport');
const content = $('timelineContent');
const ruler = $('ruler');
const track = $('track');
const tbody = $('cueBody');
const statusBar = $('status');
const tooltip = $('tooltip');
const emptyHint = $('emptyHint');
const btnUndo = $('btnUndo');
const btnExport = $('btnExport');
const zoomSlider = $('zoomSlider');
const safetyA = $('safetyA'); // 后继安全线（next.start - MIN_GAP）
const safetyB = $('safetyB'); // 前驱安全线（prev.end + MIN_GAP）

let blockEls = []; // [{root, title, txt}]
let rowEls = []; // [{tr, tdS, tdE, tdD}]
let rulerEndMs = -1;

// ---------- 工具 ----------
function totalMs() {
  return state.cues.length ? state.cues[state.cues.length - 1].end : 60000;
}

function fmtTick(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mmm = ms % 1000;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  const base = h ? `${String(h).padStart(2, '0')}:${mmss}` : mmss;
  return mmm ? `${base}.${String(mmm).padStart(3, '0')}` : base;
}

const zoomToSlider = (px) =>
  Math.round((Math.log(px / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * SLIDER_MAX);
const sliderToZoom = (v) => ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, v / SLIDER_MAX);

// ---------- 渲染 ----------
const TICK_INTERVALS = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000];

function renderRuler() {
  const px = state.pxPerMs;
  const interval = TICK_INTERVALS.find((v) => v * px >= 90) || TICK_INTERVALS[TICK_INTERVALS.length - 1];
  const end = totalMs() + interval * 2;
  rulerEndMs = end;
  ruler.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let t = 0; t <= end; t += interval) {
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.left = t * px + 'px';
    const lab = document.createElement('span');
    lab.textContent = fmtTick(t);
    tick.appendChild(lab);
    frag.appendChild(tick);
  }
  ruler.appendChild(frag);
}

function updateContentWidth() {
  content.style.width = totalMs() * state.pxPerMs + 400 + 'px';
}

function updateView() {
  const px = state.pxPerMs;
  for (let i = 0; i < state.cues.length; i++) {
    const c = state.cues[i];
    const b = blockEls[i];
    b.root.style.left = c.start * px + 'px';
    b.root.style.width = Math.max(6, (c.end - c.start) * px) + 'px';
    b.title.textContent = `#${i + 1}  ${fmtTime(c.start)} → ${fmtTime(c.end)}`;
    const r = rowEls[i];
    r.tdS.textContent = fmtTime(c.start);
    r.tdE.textContent = fmtTime(c.end);
    r.tdD.textContent = ((c.end - c.start) / 1000).toFixed(3) + ' s';
  }
  updateContentWidth();
  if (totalMs() > rulerEndMs) renderRuler();
  updateStatus();
}

let viewScheduled = false;
function requestViewUpdate() {
  if (viewScheduled) return;
  viewScheduled = true;
  requestAnimationFrame(() => {
    viewScheduled = false;
    updateView();
  });
}

function updateStatus() {
  if (!state.cues.length) {
    statusBar.textContent = '未加载文件 — 点击「导入 SRT」或将 .srt 文件拖入页面';
    return;
  }
  statusBar.textContent =
    `共 ${state.cues.length} 块 · 区间 ${fmtTime(state.cues[0].start)} ~ ${fmtTime(totalMs())}` +
    ` · 缩放 ${(state.pxPerMs * 1000).toFixed(0)} px/s · 约束：时长 ≥ ${MIN_DUR}ms，间隔 ≥ ${MIN_GAP}ms，起点 ≥ 0`;
}

function buildTimeline() {
  track.querySelectorAll('.cue-block').forEach((el) => el.remove());
  blockEls = state.cues.map((c, i) => {
    const root = document.createElement('div');
    root.className = 'cue-block';

    const hL = document.createElement('div');
    hL.className = 'handle left';
    hL.title = '拖动调整开始时间';
    const hR = document.createElement('div');
    hR.className = 'handle right';
    hR.title = '拖动调整结束时间';

    const body = document.createElement('div');
    body.className = 'body';
    body.title = '拖动整体移动（保持时长）';
    const title = document.createElement('div');
    title.className = 'cue-title';
    const txt = document.createElement('div');
    txt.className = 'cue-text';
    txt.textContent = c.text;
    body.append(title, txt);

    root.append(hL, body, hR);
    hL.addEventListener('pointerdown', (e) => startDrag(e, i, 'start'));
    hR.addEventListener('pointerdown', (e) => startDrag(e, i, 'end'));
    body.addEventListener('pointerdown', (e) => startDrag(e, i, 'move'));
    track.appendChild(root);
    return { root, title, txt };
  });
}

function buildList() {
  tbody.innerHTML = '';
  rowEls = state.cues.map((c, i) => {
    const tr = document.createElement('tr');
    const tdIdx = document.createElement('td');
    tdIdx.className = 'idx';
    tdIdx.textContent = i + 1;
    const tdS = document.createElement('td');
    tdS.className = 'tc';
    const tdE = document.createElement('td');
    tdE.className = 'tc';
    const tdD = document.createElement('td');
    tdD.className = 'tc';
    const tdT = document.createElement('td');
    tdT.className = 'txt';
    const ta = document.createElement('textarea');
    ta.value = c.text;
    ta.rows = Math.min(3, Math.max(1, c.text.split('\n').length));
    ta.spellcheck = false;
    ta.addEventListener('input', () => {
      c.text = ta.value;
      blockEls[i].txt.textContent = ta.value;
    });
    tdT.appendChild(ta);
    tr.append(tdIdx, tdS, tdE, tdD, tdT);
    tr.addEventListener('click', (e) => {
      if (e.target === ta) return;
      select(i);
      scrollToCue(i);
    });
    tbody.appendChild(tr);
    return { tr, tdS, tdE, tdD };
  });
}

// ---------- 选中与滚动 ----------
function select(i) {
  state.selected = i;
  blockEls.forEach((b, j) => b.root.classList.toggle('selected', j === i));
  rowEls.forEach((r, j) => r.tr.classList.toggle('selected', j === i));
  if (i >= 0 && rowEls[i]) rowEls[i].tr.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function scrollToCue(i) {
  viewport.scrollLeft = Math.max(0, state.cues[i].start * state.pxPerMs - viewport.clientWidth * 0.3);
}

// ---------- 拖动 ----------
let drag = null; // {index, edge, orig, startClientX, startScroll}
let lastClientX = 0;
let lastClientY = 0;
let autoScrollId = 0;

function startDrag(e, index, edge) {
  if (e.button !== 0 || !state.cues.length) return;
  e.preventDefault();
  select(index);
  const orig = state.cues.map((c) => ({ start: c.start, end: c.end }));
  drag = { index, edge, orig, startClientX: e.clientX, startScroll: viewport.scrollLeft };
  lastClientX = e.clientX;
  lastClientY = e.clientY;
  try {
    e.target.setPointerCapture(e.pointerId);
  } catch (_) {
    /* 某些环境不支持指针捕获，忽略 */
  }
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', onDragEnd);
  document.body.classList.add('dragging');
  autoScrollId = requestAnimationFrame(autoScrollTick);
  updateSafetyLines();
  updateTooltip();
}

function onDragMove(e) {
  if (!drag) return;
  lastClientX = e.clientX;
  lastClientY = e.clientY;
  applyDragDelta();
}

// 依据「指针位移 + 滚动位移」计算时间轴上的总位移并应用（从快照还原后施加，幂等）
function applyDragDelta() {
  const dx = lastClientX - drag.startClientX + (viewport.scrollLeft - drag.startScroll);
  applyDrag(state.cues, drag.orig, drag.index, drag.edge, dx / state.pxPerMs);
  requestViewUpdate();
  updateSafetyLines();
  updateTooltip();
}

// 指针靠近视口边缘时自动横向滚动，拖出的后继链再长也够得着
function autoScrollTick() {
  if (!drag) return;
  const r = viewport.getBoundingClientRect();
  const M = 40;
  const S = Math.max(6, state.pxPerMs * 40);
  let scrolled = false;
  if (lastClientX < r.left + M && viewport.scrollLeft > 0) {
    viewport.scrollLeft -= S;
    scrolled = true;
  } else if (lastClientX > r.right - M) {
    viewport.scrollLeft += S;
    scrolled = true;
  }
  if (scrolled) applyDragDelta();
  autoScrollId = requestAnimationFrame(autoScrollTick);
}

function onDragEnd() {
  if (!drag) return;
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);
  document.removeEventListener('pointercancel', onDragEnd);
  document.body.classList.remove('dragging');
  cancelAnimationFrame(autoScrollId);
  hideSafety();
  tooltip.hidden = true;
  const changed = state.cues.some((c, i) => c.start !== drag.orig[i].start || c.end !== drag.orig[i].end);
  if (changed) {
    state.undoStack.push(drag.orig);
    if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
    updateUndoBtn();
  }
  drag = null;
}

// 安全线可视化：拖右边界/整体时显示后继安全线，拖左边界/整体时显示前驱安全线
function updateSafetyLines() {
  let showA = false;
  let showB = false;
  if (drag) {
    const px = state.pxPerMs;
    const i = drag.index;
    if ((drag.edge === 'end' || drag.edge === 'move') && i + 1 < state.cues.length) {
      safetyA.style.left = (state.cues[i + 1].start - MIN_GAP) * px + 'px';
      showA = true;
    }
    if ((drag.edge === 'start' || drag.edge === 'move') && i > 0) {
      safetyB.style.left = (state.cues[i - 1].end + MIN_GAP) * px + 'px';
      showB = true;
    }
  }
  safetyA.style.display = showA ? 'block' : 'none';
  safetyB.style.display = showB ? 'block' : 'none';
}

function hideSafety() {
  safetyA.style.display = 'none';
  safetyB.style.display = 'none';
}

function updateTooltip() {
  const c = state.cues[drag.index];
  let txt;
  if (drag.edge === 'start') txt = `开始 ${fmtTime(c.start)}`;
  else if (drag.edge === 'end') txt = `结束 ${fmtTime(c.end)}`;
  else txt = `${fmtTime(c.start)} → ${fmtTime(c.end)}`;
  tooltip.textContent = txt;
  tooltip.style.left = lastClientX + 14 + 'px';
  tooltip.style.top = lastClientY + 18 + 'px';
  tooltip.hidden = false;
}

// ---------- 撤销 ----------
function updateUndoBtn() {
  btnUndo.disabled = !state.undoStack.length;
  btnUndo.textContent = state.undoStack.length ? `撤销 (${state.undoStack.length})` : '撤销';
}

function undo() {
  const snap = state.undoStack.pop();
  if (!snap) return;
  state.cues.forEach((c, i) => {
    c.start = snap[i].start;
    c.end = snap[i].end;
  });
  updateView();
  updateUndoBtn();
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    const t = e.target;
    if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable) return;
    e.preventDefault();
    undo();
  }
});

// ---------- 缩放 ----------
function setZoom(px, anchorClientX) {
  px = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, px));
  const r = viewport.getBoundingClientRect();
  const ax = anchorClientX != null ? anchorClientX - r.left : r.width / 2;
  const t = (viewport.scrollLeft + ax) / state.pxPerMs; // 锚点对应的时间
  state.pxPerMs = px;
  renderRuler();
  updateView();
  viewport.scrollLeft = Math.max(0, t * px - ax); // 保持锚点时间不动
  zoomSlider.value = zoomToSlider(px);
}

function fitZoom() {
  if (!state.cues.length) return;
  setZoom((viewport.clientWidth - 60) / Math.max(1, totalMs()));
}

$('btnZoomIn').addEventListener('click', () => setZoom(state.pxPerMs * 1.5));
$('btnZoomOut').addEventListener('click', () => setZoom(state.pxPerMs / 1.5));
$('btnZoomFit').addEventListener('click', fitZoom);
zoomSlider.addEventListener('input', () => setZoom(sliderToZoom(Number(zoomSlider.value))));

viewport.addEventListener(
  'wheel',
  (e) => {
    if (!state.cues.length) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      setZoom(state.pxPerMs * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX);
    } else {
      viewport.scrollLeft += e.deltaY + e.deltaX; // 普通滚轮 = 横向滚动
    }
  },
  { passive: false }
);

// ---------- 导入 / 导出 ----------
function loadSRT(text, name) {
  const cues = parseSRT(text);
  if (!cues.length) {
    alert('未能从文件中解析到任何字幕块，请确认是合法的 SRT 文件。');
    return;
  }
  normalizeCues(cues); // 导入即规范化：起点≥0、时长≥500ms、间隔≥100ms
  state.cues = cues;
  state.undoStack.length = 0;
  state.selected = -1;
  state.fileBase = (name || 'edited').replace(/\.[^.]+$/, '') || 'edited';
  buildTimeline();
  buildList();
  emptyHint.style.display = 'none';
  btnExport.disabled = false;
  fitZoom();
  updateUndoBtn();
  updateView();
}

function exportSRT() {
  if (!state.cues.length) return;
  const blob = new Blob(['\uFEFF' + toSRT(state.cues)], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state.fileBase + '.fixed.srt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('btnImport').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) f.text().then((t) => loadSRT(t, f.name));
  e.target.value = '';
});
$('btnSample').addEventListener('click', () => {
  fetch('sample.srt')
    .then((r) => r.text())
    .then((t) => loadSRT(t, 'sample.srt'))
    .catch(() => alert('示例文件加载失败'));
});
btnExport.addEventListener('click', exportSRT);
btnUndo.addEventListener('click', undo);

// 拖放文件到页面任意位置
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) f.text().then((t) => loadSRT(t, f.name));
});

// ---------- 初始化 ----------
function init() {
  emptyHint.style.display = 'flex';
  btnExport.disabled = true;
  zoomSlider.value = zoomToSlider(state.pxPerMs);
  renderRuler();
  updateContentWidth();
  updateUndoBtn();
  updateStatus();
}
init();
