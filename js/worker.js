'use strict';
/*
 * 请求引擎 Worker
 * 职责：熔断状态机(CLOSED/OPEN/HALF_OPEN) + 指数退避重试 + Fetch 请求 + 故障模拟
 * 主线程只负责渲染，所有计时/网络/状态迁移都在 Worker 内完成，保证 UI 不卡顿。
 */

const STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

const DEFAULT_CONFIG = {
  mode: 'simulate',          // 'simulate' | 'fetch'
  url: 'https://httpbin.org/status/200',
  faultProfile: 'outage_then_recover', // 模拟故障剧本
  failRate: 0.7,             // flaky 模式失败率
  outageMs: 8000,            // outage_then_recover 故障持续时长
  latencyMs: 120,            // 模拟基础延迟
  maxRetries: 4,             // 单次调用最大重试次数(不含首次)
  baseDelayMs: 200,          // 退避基数
  maxDelayMs: 4000,          // 退避上限
  jitter: true,              // 全抖动
  failureThreshold: 5,       // 连续失败熔断阈值
  resetTimeoutMs: 5000,      // OPEN -> HALF_OPEN 冷却时长
  halfOpenProbes: 2,         // 半开允许的并发探针数
  requestTimeoutMs: 1500     // 单次请求超时
};

let config = { ...DEFAULT_CONFIG };
let running = false;
let qps = 2;
let loadTimer = null;
let callSeq = 0;

// ---- 熔断器状态 ----
const breaker = {
  state: STATE.CLOSED,
  consecutiveFailures: 0,
  openedAt: 0,
  halfOpenInFlight: 0,
  halfOpenSuccesses: 0
};

const simStart = now();

function now() { return performance.now(); }

function post(type, payload) {
  self.postMessage({ type, ts: now(), ...payload });
}

// ---- 状态机迁移 ----
function transition(to, reason) {
  const from = breaker.state;
  if (from === to) return;
  breaker.state = to;
  if (to === STATE.OPEN) {
    breaker.openedAt = now();
    breaker.halfOpenInFlight = 0;
    breaker.halfOpenSuccesses = 0;
  }
  if (to === STATE.CLOSED) {
    breaker.consecutiveFailures = 0;
    breaker.halfOpenInFlight = 0;
    breaker.halfOpenSuccesses = 0;
  }
  if (to === STATE.HALF_OPEN) {
    breaker.halfOpenInFlight = 0;
    breaker.halfOpenSuccesses = 0;
  }
  post('state_change', { from, to, reason, breaker: snapshot() });
}

function snapshot() {
  return {
    state: breaker.state,
    consecutiveFailures: breaker.consecutiveFailures,
    openElapsed: breaker.state === STATE.OPEN ? now() - breaker.openedAt : 0,
    resetTimeoutMs: config.resetTimeoutMs,
    halfOpenInFlight: breaker.halfOpenInFlight
  };
}

function onCallSuccess() {
  if (breaker.state === STATE.HALF_OPEN) {
    breaker.halfOpenSuccesses += 1;
    // 半开探针成功 -> 关闭熔断器, 恢复流量
    transition(STATE.CLOSED, '半开探针成功，熔断器关闭，恢复流量');
  } else {
    breaker.consecutiveFailures = 0;
  }
}

function onCallFailure() {
  if (breaker.state === STATE.HALF_OPEN) {
    // 半开期间任何失败 -> 重新熔断
    transition(STATE.OPEN, '半开探针失败，重新熔断');
    return;
  }
  breaker.consecutiveFailures += 1;
  if (breaker.state === STATE.CLOSED && breaker.consecutiveFailures >= config.failureThreshold) {
    transition(STATE.OPEN, `连续失败 ${breaker.consecutiveFailures} 次，达到阈值 ${config.failureThreshold}，熔断`);
  }
}

// ---- 退避计算: delay = min(maxDelay, base * 2^attempt), 可选全抖动 ----
function backoffDelay(attempt) {
  const exp = Math.min(config.maxDelayMs, config.baseDelayMs * Math.pow(2, attempt));
  return config.jitter ? Math.random() * exp : exp;
}

// ---- 单次请求(真实 fetch 或故障模拟) ----
function doFetchOnce(callId, attempt) {
  const startedAt = now();
  post('attempt_start', { callId, attempt, startedAt });

  const finish = (result, detail) => {
    const endedAt = now();
    post('attempt_end', {
      callId, attempt, startedAt, endedAt,
      duration: endedAt - startedAt,
      result, detail
    });
    return { ok: result === 'success', result, detail };
  };

  if (config.mode === 'simulate') {
    return simulateOnce().then(r => finish(r.ok ? 'success' : r.result, r.detail));
  }
  return fetchOnce().then(r => finish(r.ok ? 'success' : r.result, r.detail));
}

function simulateOnce() {
  return new Promise(resolve => {
    const elapsed = now() - simStart;
    const latency = config.latencyMs * (0.5 + Math.random());
    let outcome = { ok: true };
    switch (config.faultProfile) {
      case 'always_fail':
        outcome = { ok: false, result: 'failure', detail: '模拟: 服务端 500' };
        break;
      case 'flaky':
        if (Math.random() < config.failRate) {
          outcome = { ok: false, result: 'failure', detail: `模拟: 随机故障(失败率 ${(config.failRate * 100).toFixed(0)}%)` };
        }
        break;
      case 'outage_then_recover':
        if (elapsed < config.outageMs) {
          outcome = { ok: false, result: 'failure', detail: `模拟: 服务宕机中(${(config.outageMs / 1000).toFixed(0)}s 后恢复)` };
        }
        break;
      case 'slow':
        outcome = { ok: false, result: 'timeout', detail: `模拟: 响应超时(>${config.requestTimeoutMs}ms)` };
        setTimeout(() => resolve(outcome), config.requestTimeoutMs + 50);
        return;
    }
    setTimeout(() => resolve(outcome), latency);
  });
}

function fetchOnce() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const started = now();
  return fetch(config.url, { signal: controller.signal, cache: 'no-store' })
    .then(res => {
      clearTimeout(timer);
      if (res.ok) return { ok: true };
      return { ok: false, result: 'failure', detail: `HTTP ${res.status} ${res.statusText}` };
    })
    .catch(err => {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        return { ok: false, result: 'timeout', detail: `请求超时(>${config.requestTimeoutMs}ms)` };
      }
      return { ok: false, result: 'failure', detail: `网络异常: ${err && err.message ? err.message : String(err)}` };
    });
}

// ---- 带熔断 + 重试的一次调用 ----
async function executeCall(callId) {
  // 1) 熔断器准入判断
  if (breaker.state === STATE.OPEN) {
    const elapsed = now() - breaker.openedAt;
    if (elapsed >= config.resetTimeoutMs) {
      transition(STATE.HALF_OPEN, `冷却 ${config.resetTimeoutMs}ms 结束，进入半开，放行探针`);
    } else {
      // 熔断中: 直接拒绝, 不发任何请求 —— 验收点: 熔断后不再请求
      post('call_rejected', {
        callId, state: breaker.state,
        reason: `熔断中，拒绝请求(剩余冷却 ${(config.resetTimeoutMs - elapsed).toFixed(0)}ms)`
      });
      return;
    }
  }
  if (breaker.state === STATE.HALF_OPEN) {
    if (breaker.halfOpenInFlight >= config.halfOpenProbes) {
      post('call_rejected', {
        callId, state: breaker.state,
        reason: `半开中，探针数已达上限 ${config.halfOpenProbes}，拒绝`
      });
      return;
    }
    breaker.halfOpenInFlight += 1;
  }

  post('call_start', { callId, state: breaker.state });

  // 2) 重试 + 退避循环
  let lastResult = null;
  try {
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = backoffDelay(attempt - 1);
        post('retry_scheduled', {
          callId, attempt, delay,
          formula: `min(${config.maxDelayMs}, ${config.baseDelayMs}*2^${attempt - 1})${config.jitter ? ' * rand(0,1)' : ''} = ${delay.toFixed(0)}ms`
        });
        await sleep(delay);
      }
      // 退避等待期间熔断器可能已被并发调用打开: 发请求前再检查, OPEN 则 fail-fast
      if (breaker.state === STATE.OPEN) {
        post('call_aborted', {
          callId, attempt,
          reason: '熔断器已断开，中止本次调用的剩余重试（fail-fast）'
        });
        post('call_done', { callId, ok: false, attempts: attempt, error: '熔断器断开，重试被中止' });
        return;
      }
      const r = await doFetchOnce(callId, attempt);
      lastResult = r;
      if (r.ok) {
        onCallSuccess();
        post('call_done', { callId, ok: true, attempts: attempt + 1 });
        return;
      }
    }
    onCallFailure();
    post('call_done', {
      callId, ok: false, attempts: config.maxRetries + 1,
      error: lastResult ? lastResult.detail : '未知错误'
    });
  } finally {
    if (breaker.state === STATE.HALF_OPEN && breaker.halfOpenInFlight > 0) {
      breaker.halfOpenInFlight -= 1;
    }
  }
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// ---- 负载发生 ----
function startLoad() {
  stopLoad();
  const interval = Math.max(20, 1000 / qps);
  loadTimer = setInterval(() => {
    if (!running) return;
    executeCall(++callSeq).catch(err => {
      post('engine_error', { message: `运行时异常: ${err && err.message ? err.message : String(err)}` });
    });
  }, interval);
}

function stopLoad() {
  if (loadTimer) { clearInterval(loadTimer); loadTimer = null; }
}

function resetAll() {
  stopLoad();
  callSeq = 0;
  breaker.state = STATE.CLOSED;
  breaker.consecutiveFailures = 0;
  breaker.openedAt = 0;
  breaker.halfOpenInFlight = 0;
  breaker.halfOpenSuccesses = 0;
}

self.onmessage = e => {
  const msg = e.data || {};
  try {
    switch (msg.type) {
      case 'config':
        config = { ...config, ...msg.config };
        post('config', { breaker: snapshot() });
        break;
      case 'start':
        running = true;
        qps = msg.qps || qps;
        startLoad();
        post('engine', { running, qps });
        break;
      case 'stop':
        running = false;
        stopLoad();
        post('engine', { running, qps });
        break;
      case 'single':
        executeCall(++callSeq).catch(err => {
          post('engine_error', { message: `运行时异常: ${err && err.message ? err.message : String(err)}` });
        });
        break;
      case 'reset':
        resetAll();
        post('reset_done', { breaker: snapshot() });
        break;
    }
  } catch (err) {
    post('engine_error', { message: `引擎异常: ${err && err.message ? err.message : String(err)}` });
  }
};
