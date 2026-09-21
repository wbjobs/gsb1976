'use strict';
/* 主线程: UI 控制 + Canvas 可视化 + 异常提示。所有请求逻辑在 Worker 中执行。 */

const STATE_COLORS = { CLOSED: '#22c55e', OPEN: '#ef4444', HALF_OPEN: '#f59e0b' };
const STATE_LABELS = { CLOSED: '闭合 CLOSED', OPEN: '断开 OPEN', HALF_OPEN: '半开 HALF-OPEN' };

const els = {
  timeline: document.getElementById('timeline'),
  stateMachine: document.getElementById('stateMachine'),
  log: document.getElementById('log'),
  toasts: document.getElementById('toasts'),
  stateBadge: document.getElementById('stateBadge'),
  stats: {
    sent: document.getElementById('statSent'),
    ok: document.getElementById('statOk'),
    fail: document.getElementById('statFail'),
    rejected: document.getElementById('statRejected'),
    retries: document.getElementById('statRetries'),
    lastBackoff: document.getElementById('statLastBackoff')
  },
  inputs: {
    mode: document.getElementById('cfgMode'),
    url: document.getElementById('cfgUrl'),
    fault: document.getElementById('cfgFault'),
    failRate: document.getElementById('cfgFailRate'),
    outageMs: document.getElementById('cfgOutage'),
    maxRetries: document.getElementById('cfgMaxRetries'),
    baseDelay: document.getElementById('cfgBaseDelay'),
    maxDelay: document.getElementById('cfgMaxDelay'),
    threshold: document.getElementById('cfgThreshold'),
    resetTimeout: document.getElementById('cfgResetTimeout'),
    qps: document.getElementById('cfgQps')
  },
  btnStart: document.getElementById('btnStart'),
  btnStop: document.getElementById('btnStop'),
  btnSingle: document.getElementById('btnSingle'),
  btnReset: document.getElementById('btnReset')
};

// ---- 数据模型(渲染用) ----
const WINDOW_MS = 30000;          // 时间轴窗口 30s
const MAX_EVENTS = 4000;          // 环形上限, 防止内存膨胀
const attempts = [];              // {callId, attempt, start, end, result}
const rejections = [];            // {callId, ts, reason}
const stateSpans = [];            // {state, start, end|null}
const calls = new Map();          // callId -> {attempts:[...], done, ok}
const stats = { sent: 0, ok: 0, fail: 0, rejected: 0, retries: 0 };
let lastBackoffFormula = '—';
let latestTs = 0;
let currentState = 'CLOSED';

// ---- Worker ----
const worker = new Worker('js/worker.js');
worker.onmessage = e => handleEvent(e.data);
worker.onerror = err => {
  toast(`Worker 异常: ${err.message || '未知错误'}`, 'error');
  log(`[引擎] Worker 加载/运行失败: ${err.message}`, 'error');
};

function pushCapped(arr, item) {
  arr.push(item);
  if (arr.length > MAX_EVENTS) arr.splice(0, arr.length - MAX_EVENTS);
}

function handleEvent(msg) {
  latestTs = Math.max(latestTs, msg.ts || 0);
  switch (msg.type) {
    case 'state_change': {
      const prev = stateSpans[stateSpans.length - 1];
      if (prev && !prev.end) prev.end = msg.ts;
      stateSpans.push({ state: msg.to, start: msg.ts, end: null });
      currentState = msg.to;
      updateStateBadge();
      log(`[熔断器] ${STATE_LABELS[msg.from]} → ${STATE_LABELS[msg.to]}：${msg.reason}`,
          msg.to === 'OPEN' ? 'error' : msg.to === 'HALF_OPEN' ? 'warn' : 'ok');
      if (msg.to === 'OPEN') toast(`熔断器断开：${msg.reason}`, 'error');
      if (msg.to === 'CLOSED') toast(`熔断器恢复闭合：${msg.reason}`, 'ok');
      break;
    }
    case 'call_start':
      calls.set(msg.callId, { attempts: [], done: false, ok: false });
      if (calls.size > 500) calls.delete(calls.keys().next().value);
      break;
    case 'attempt_start': {
      const rec = { callId: msg.callId, attempt: msg.attempt, start: msg.startedAt, end: null, result: 'pending' };
      pushCapped(attempts, rec);
      const call = calls.get(msg.callId);
      if (call) call.attempts.push(rec);
      stats.sent += 1;
      if (msg.attempt > 0) stats.retries += 1;
      break;
    }
    case 'attempt_end': {
      const rec = attempts.find(a => a.callId === msg.callId && a.attempt === msg.attempt && a.end === null);
      if (rec) { rec.end = msg.endedAt; rec.result = msg.result; }
      if (msg.result === 'success') stats.ok += 1; else stats.fail += 1;
      if (msg.result !== 'success') {
        log(`[调用 #${msg.callId}] 第 ${msg.attempt + 1} 次尝试${msg.result === 'timeout' ? '超时' : '失败'}：${msg.detail}`, 'warn');
      }
      break;
    }
    case 'retry_scheduled':
      lastBackoffFormula = msg.formula;
      log(`[调用 #${msg.callId}] 退避等待 ${msg.delay.toFixed(0)}ms 后重试（${msg.formula}）`, 'info');
      break;
    case 'call_rejected':
      pushCapped(rejections, { callId: msg.callId, ts: msg.ts, reason: msg.reason });
      stats.rejected += 1;
      log(`[调用 #${msg.callId}] ${msg.reason}`, 'error');
      break;
    case 'call_aborted':
      log(`[调用 #${msg.callId}] ${msg.reason}`, 'warn');
      break;
    case 'call_done': {
      const call = calls.get(msg.callId);
      if (call) { call.done = true; call.ok = msg.ok; }
      if (!msg.ok) toast(`调用 #${msg.callId} 最终失败：${msg.error || ''}`, 'error');
      break;
    }
    case 'engine_error':
      toast(msg.message, 'error');
      log(`[引擎] ${msg.message}`, 'error');
      break;
    case 'reset_done':
      resetView();
      break;
  }
  renderStats();
}

// ---- 控制 ----
function readConfig() {
  const mode = els.inputs.mode.value;
  return {
    mode,
    url: els.inputs.url.value.trim(),
    faultProfile: els.inputs.fault.value,
    failRate: Number(els.inputs.failRate.value) / 100,
    outageMs: Number(els.inputs.outageMs.value),
    maxRetries: Number(els.inputs.maxRetries.value),
    baseDelayMs: Number(els.inputs.baseDelay.value),
    maxDelayMs: Number(els.inputs.maxDelay.value),
    failureThreshold: Number(els.inputs.threshold.value),
    resetTimeoutMs: Number(els.inputs.resetTimeout.value)
  };
}

function applyConfig() {
  worker.postMessage({ type: 'config', config: readConfig() });
}

els.btnStart.addEventListener('click', () => {
  applyConfig();
  worker.postMessage({ type: 'start', qps: Number(els.inputs.qps.value) });
  log(`[控制] 启动负载，QPS=${els.inputs.qps.value}`, 'info');
});
els.btnStop.addEventListener('click', () => {
  worker.postMessage({ type: 'stop' });
  log('[控制] 停止负载', 'info');
});
els.btnSingle.addEventListener('click', () => {
  applyConfig();
  worker.postMessage({ type: 'single' });
});
els.btnReset.addEventListener('click', () => {
  worker.postMessage({ type: 'reset' });
});
Object.values(els.inputs).forEach(input => input.addEventListener('change', applyConfig));
els.inputs.mode.addEventListener('change', () => {
  document.getElementById('simulateFields').style.display = els.inputs.mode.value === 'simulate' ? '' : 'none';
  document.getElementById('fetchFields').style.display = els.inputs.mode.value === 'fetch' ? '' : 'none';
});

function resetView() {
  attempts.length = 0;
  rejections.length = 0;
  calls.clear();
  stateSpans.length = 0;
  stateSpans.push({ state: 'CLOSED', start: latestTs, end: null });
  Object.keys(stats).forEach(k => { stats[k] = 0; });
  lastBackoffFormula = '—';
  currentState = 'CLOSED';
  updateStateBadge();
  renderStats();
  log('[控制] 已重置熔断器与统计', 'info');
}

// ---- 异常提示 ----
function toast(message, kind) {
  const div = document.createElement('div');
  div.className = `toast toast-${kind || 'info'}`;
  div.textContent = message;
  els.toasts.appendChild(div);
  setTimeout(() => div.classList.add('show'), 10);
  setTimeout(() => {
    div.classList.remove('show');
    setTimeout(() => div.remove(), 300);
  }, 4200);
  while (els.toasts.children.length > 5) els.toasts.firstChild.remove();
}

function log(text, level) {
  const line = document.createElement('div');
  line.className = `log-line log-${level || 'info'}`;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.textContent = `[${time}] ${text}`;
  els.log.appendChild(line);
  while (els.log.children.length > 300) els.log.firstChild.remove();
  els.log.scrollTop = els.log.scrollHeight;
}

// ---- 统计与状态徽标 ----
function renderStats() {
  els.stats.sent.textContent = stats.sent;
  els.stats.ok.textContent = stats.ok;
  els.stats.fail.textContent = stats.fail;
  els.stats.rejected.textContent = stats.rejected;
  els.stats.retries.textContent = stats.retries;
  els.stats.lastBackoff.textContent = lastBackoffFormula;
}

function updateStateBadge() {
  els.stateBadge.textContent = STATE_LABELS[currentState];
  els.stateBadge.style.background = STATE_COLORS[currentState];
}

// ---- Canvas: 时间轴 ----
function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

function drawTimeline() {
  const { ctx, w, h } = setupCanvas(els.timeline);
  const tEnd = Math.max(latestTs, WINDOW_MS);
  const tStart = tEnd - WINDOW_MS;
  const x = ts => ((ts - tStart) / WINDOW_MS) * w;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, w, h);

  // 网格(每 5s)
  ctx.strokeStyle = 'rgba(148,163,184,0.15)';
  ctx.fillStyle = 'rgba(148,163,184,0.7)';
  ctx.font = '10px monospace';
  ctx.lineWidth = 1;
  for (let t = Math.ceil(tStart / 5000) * 5000; t <= tEnd; t += 5000) {
    ctx.beginPath();
    ctx.moveTo(x(t), 0);
    ctx.lineTo(x(t), h);
    ctx.stroke();
    ctx.fillText(`${((t - tEnd) / 1000).toFixed(0)}s`, x(t) + 3, h - 4);
  }

  // 泳道: 顶部熔断状态带 / 中部请求尝试 / 底部熔断拒绝
  const bandH = 22;
  const laneAttemptY = h * 0.5;
  const laneRejectY = h - 22;

  // 熔断状态带
  for (const span of stateSpans) {
    const s = Math.max(span.start, tStart);
    const e = span.end === null ? tEnd : Math.min(span.end, tEnd);
    if (e <= tStart || s >= tEnd) continue;
    ctx.fillStyle = STATE_COLORS[span.state] + '55';
    ctx.fillRect(x(s), 0, Math.max(1, x(e) - x(s)), bandH);
    ctx.fillStyle = STATE_COLORS[span.state];
    if (x(e) - x(s) > 60) ctx.fillText(STATE_LABELS[span.state], x(s) + 4, 15);
  }
  ctx.strokeStyle = 'rgba(148,163,184,0.3)';
  ctx.strokeRect(0, 0, w, bandH);

  // 泳道标签
  ctx.fillStyle = 'rgba(148,163,184,0.8)';
  ctx.fillText('请求尝试', 4, laneAttemptY - 24);
  ctx.fillText('熔断拒绝', 4, laneRejectY - 6);

  // 退避连线: 同一调用的相邻尝试之间画线, 直观展示退避间隔
  ctx.lineWidth = 1.5;
  for (const call of calls.values()) {
    for (let i = 1; i < call.attempts.length; i++) {
      const a = call.attempts[i - 1];
      const b = call.attempts[i];
      if (b.start < tStart || a.start > tEnd) continue;
      ctx.strokeStyle = 'rgba(96,165,250,0.8)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x(a.start), laneAttemptY);
      ctx.lineTo(x(b.start), laneAttemptY);
      ctx.stroke();
      ctx.setLineDash([]);
      const gap = b.start - a.start;
      if (x(b.start) - x(a.start) > 46) {
        ctx.fillStyle = '#93c5fd';
        ctx.fillText(`⏳${gap.toFixed(0)}ms`, (x(a.start) + x(b.start)) / 2 - 22, laneAttemptY - 8);
      }
    }
  }

  // 尝试点: 绿=成功 红=失败 橙=超时 灰=进行中
  const dotColor = { success: '#22c55e', failure: '#ef4444', timeout: '#f97316', pending: '#94a3b8' };
  for (const a of attempts) {
    if (a.start < tStart || a.start > tEnd) continue;
    const y = laneAttemptY + (a.attempt % 2 === 0 ? -6 : 6);
    ctx.fillStyle = dotColor[a.result] || '#94a3b8';
    ctx.beginPath();
    ctx.arc(x(a.start), y, 4, 0, Math.PI * 2);
    ctx.fill();
    if (a.end !== null && a.end <= tEnd) {
      ctx.strokeStyle = (dotColor[a.result] || '#94a3b8') + '66';
      ctx.beginPath();
      ctx.moveTo(x(a.start), y);
      ctx.lineTo(x(a.end), y);
      ctx.stroke();
    }
  }

  // 熔断拒绝: 灰色叉
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 2;
  for (const r of rejections) {
    if (r.ts < tStart || r.ts > tEnd) continue;
    const rx = x(r.ts);
    ctx.beginPath();
    ctx.moveTo(rx - 4, laneRejectY - 4);
    ctx.lineTo(rx + 4, laneRejectY + 4);
    ctx.moveTo(rx + 4, laneRejectY - 4);
    ctx.lineTo(rx - 4, laneRejectY + 4);
    ctx.stroke();
  }
}

// ---- Canvas: 状态机图 ----
function drawStateMachine() {
  const { ctx, w, h } = setupCanvas(els.stateMachine);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, w, h);

  const nodes = {
    CLOSED: { x: w * 0.18, y: h * 0.5, label: 'CLOSED\n闭合' },
    OPEN: { x: w * 0.5, y: h * 0.22, label: 'OPEN\n断开' },
    HALF_OPEN: { x: w * 0.82, y: h * 0.5, label: 'HALF-OPEN\n半开' }
  };

  function arrow(from, to, text, curve) {
    const a = nodes[from];
    const b = nodes[to];
    ctx.strokeStyle = 'rgba(148,163,184,0.6)';
    ctx.fillStyle = 'rgba(148,163,184,0.9)';
    ctx.lineWidth = 1.5;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 + curve;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(mx, my, b.x, b.y);
    ctx.stroke();
    // 箭头
    const ang = Math.atan2(b.y - my, b.x - mx);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - 9 * Math.cos(ang - 0.4), b.y - 9 * Math.sin(ang - 0.4));
    ctx.lineTo(b.x - 9 * Math.cos(ang + 0.4), b.y - 9 * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();
    ctx.font = '10px sans-serif';
    ctx.fillText(text, mx - ctx.measureText(text).width / 2, my - 4);
  }

  arrow('CLOSED', 'OPEN', '失败≥阈值', -24);
  arrow('OPEN', 'HALF_OPEN', '冷却超时', 40);
  arrow('HALF_OPEN', 'CLOSED', '探针成功', -24);
  arrow('HALF_OPEN', 'OPEN', '探针失败', -70);

  for (const [key, n] of Object.entries(nodes)) {
    const active = key === currentState;
    ctx.beginPath();
    ctx.arc(n.x, n.y, active ? 30 : 26, 0, Math.PI * 2);
    ctx.fillStyle = active ? STATE_COLORS[key] : '#1e293b';
    ctx.fill();
    ctx.strokeStyle = STATE_COLORS[key];
    ctx.lineWidth = active ? 3 : 1.5;
    ctx.stroke();
    if (active) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, 36 + 3 * Math.sin(latestTs / 200), 0, Math.PI * 2);
      ctx.strokeStyle = STATE_COLORS[key] + '55';
      ctx.stroke();
    }
    ctx.fillStyle = active ? '#0f172a' : '#e2e8f0';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    const lines = n.label.split('\n');
    lines.forEach((line, i) => ctx.fillText(line, n.x, n.y - 4 + i * 13));
    ctx.textAlign = 'left';
  }
}

// ---- 渲染循环(rAF, 主线程只画不算) ----
function frame() {
  drawTimeline();
  drawStateMachine();
  requestAnimationFrame(frame);
}

// 初始化
stateSpans.push({ state: 'CLOSED', start: 0, end: null });
updateStateBadge();
renderStats();
applyConfig();
requestAnimationFrame(frame);
log('[系统] 就绪。选择故障剧本后点击「启动负载」。', 'info');
