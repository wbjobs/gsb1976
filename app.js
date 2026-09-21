(function () {
  const API_URL = '/api/health';
  const worker = new Worker('./worker.js');
  const timeline = new ResilienceTimeline(document.getElementById('vizCanvas'));
  const logs = [];
  let requestId = 0;
  let serverInfo = null;

  const elements = {
    stateCard: document.getElementById('stateCard'),
    stateName: document.getElementById('stateName'),
    stateMeta: document.getElementById('stateMeta'),
    requestBtn: document.getElementById('requestBtn'),
    burstBtn: document.getElementById('burstBtn'),
    resetBtn: document.getElementById('resetBtn'),
    configForm: document.getElementById('configForm'),
    logBody: document.getElementById('logBody'),
    toastContainer: document.getElementById('toastContainer')
  };

  elements.requestBtn.addEventListener('click', () => sendRequest());
  elements.burstBtn.addEventListener('click', () => {
    for (let index = 0; index < 5; index += 1) {
      setTimeout(() => sendRequest(), index * 35);
    }
  });
  elements.resetBtn.addEventListener('click', resetAll);
  elements.configForm.addEventListener('submit', applyConfig);

  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.mode, button));
  });

  worker.onmessage = (event) => {
    const { type, payload } = event.data || {};
    handleWorkerEvent(type, payload);
  };

  worker.onerror = (event) => {
    showToast('Worker 异常', event.message || 'Web Worker 运行失败', 'error');
  };

  requestServerInfo();
  setInterval(requestServerInfo, 1000);
  setInterval(() => {
    worker.postMessage({ type: 'GET_METRICS' });
  }, 250);
  requestAnimationFrame(function frame(now) {
    timeline.draw(now);
    requestAnimationFrame(frame);
  });

  function sendRequest() {
    requestId += 1;
    worker.postMessage({
      type: 'REQUEST',
      payload: {
        url: API_URL,
        method: 'GET',
        requestId
      }
    });
  }

  async function setMode(mode, button) {
    try {
      const response = await fetch('/api/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '模式切换失败');
      }
      document.querySelectorAll('[data-mode]').forEach((item) => {
        item.classList.toggle('active', item === button);
      });
      serverInfo = data.state;
      updateServerMetric();
      showToast('接口模式已切换', `当前模式：${mode}`, mode === 'success' ? 'success' : 'warning');
    } catch (error) {
      showToast('接口模式切换失败', error.message, 'error');
    }
  }

  async function resetAll() {
    timeline.reset();
    logs.length = 0;
    renderLogs();
    worker.postMessage({ type: 'RESET' });
    try {
      const response = await fetch('/api/reset', { method: 'POST' });
      const data = await response.json();
      serverInfo = data.state;
      updateServerMetric();
    } catch (error) {
      showToast('服务端计数重置失败', error.message, 'error');
    }
  }

  function applyConfig(event) {
    event.preventDefault();
    const payload = {
      maxRetries: readNumber('maxRetries'),
      baseDelayMs: readNumber('baseDelayMs'),
      maxDelayMs: readNumber('maxDelayMs'),
      failureThreshold: readNumber('failureThreshold'),
      openDurationMs: readNumber('openDurationMs'),
      timeoutMs: readNumber('timeoutMs')
    };

    if (Object.values(payload).some((value) => !Number.isFinite(value))) {
      showToast('配置无效', '请检查所有数值字段', 'error');
      return;
    }
    if (payload.maxDelayMs < payload.baseDelayMs) {
      showToast('配置无效', '最大退避不能小于基础退避', 'error');
      return;
    }

    worker.postMessage({
      type: 'CONFIGURE',
      payload
    });
  }

  function readNumber(id) {
    return Number(document.getElementById(id).value);
  }

  function handleWorkerEvent(type, payload) {
    const breaker = payload && payload.breaker;
    if (breaker) {
      updateBreaker(breaker, type, payload);
    }
    if (payload && payload.metrics) {
      updateMetrics(payload.metrics);
    }
    if (type === 'metrics' && payload.state) {
      updateMetrics(payload);
      updateBreaker(payload.state, type, {});
      timeline.setState(payload.state.state, performance.now(), 'TICK', payload.state);
    }
    if (type === 'configUpdated') {
      showToast('配置已应用', '熔断器已按新配置重置', 'success');
    }

    if (shouldShowTimelineEvent(type)) {
      timeline.addEvent(type, payload);
    }

    if (type === 'stateChanged' && breaker) {
      timeline.setState(breaker.state, payload.at ? performance.now() : performance.now(), payload.reason, breaker);
    }
    if (type === 'breakerReset') {
      timeline.reset();
      showToast('熔断器已重置', '状态、指标与可视化时间线已清空', 'success');
    }

    if (type === 'requestRejected') {
      showToast('请求被熔断拦截', payload.error.message, 'warning');
    }
    if (type === 'requestFailed') {
      showToast('请求失败', payload.error.message, 'error');
    }
    if (type === 'requestSucceeded') {
      showToast('请求成功', payload.isProbe ? '半开探测成功，熔断器恢复 CLOSED' : '服务调用成功', 'success');
    }

    addLog(type, payload);
  }

  function shouldShowTimelineEvent(type) {
    return [
      'requestStarted',
      'retryScheduled',
      'attemptStarted',
      'attemptFailed',
      'attemptSucceeded',
      'requestRejected',
      'requestFailed',
      'requestSucceeded'
    ].includes(type);
  }

  function updateBreaker(breaker, type, payload) {
    elements.stateName.textContent = breaker.state;
    elements.stateCard.className = `state-card ${breaker.state}`;
    if (breaker.state === 'OPEN') {
      elements.stateMeta.textContent = `${Math.ceil(breaker.openRemainingMs / 1000)}s 后半开 · 不发起 Fetch`;
    } else if (breaker.state === 'HALF_OPEN') {
      elements.stateMeta.textContent = breaker.probeInFlight ? '探测请求执行中' : '仅放行一个探测请求';
    } else {
      elements.stateMeta.textContent = `失败 ${breaker.failureCount} / ${breaker.failureThreshold}`;
    }

    if (type === 'stateChanged' && payload && payload.reason) {
      const reasonMap = {
        FAILURE_THRESHOLD: '失败达到阈值，进入熔断',
        COOLDOWN_FINISHED: '冷却结束，进入半开',
        PROBE_SUCCESS: '探测成功，恢复正常',
        PROBE_FAILURE: '探测失败，重新熔断'
      };
      if (reasonMap[payload.reason]) {
        showToast('熔断状态变化', reasonMap[payload.reason], breaker.state === 'CLOSED' ? 'success' : 'warning');
      }
    }
  }

  function updateMetrics(metrics) {
    setMetric('metricRequests', metrics.requests);
    setMetric('metricFetches', metrics.fetches);
    setMetric('metricRetries', metrics.retries);
    setMetric('metricSuccesses', metrics.successes);
    setMetric('metricFailures', metrics.failures);
    setMetric('metricRejected', metrics.rejected);
  }

  function setMetric(id, value) {
    document.getElementById(id).textContent = String(value ?? 0);
  }

  function updateServerMetric() {
    document.getElementById('serverRequests').textContent = serverInfo ? String(serverInfo.requests) : '-';
  }

  async function requestServerInfo() {
    try {
      const response = await fetch('/api/status', { method: 'GET' });
      const data = await response.json();
      serverInfo = data.state || serverInfo;
      updateServerMetric();
    } catch {
      // 页面统计刷新不干扰演示主流程。
    }
  }

  function addLog(type, payload) {
    if (!['requestStarted', 'retryScheduled', 'attemptStarted', 'attemptFailed', 'attemptSucceeded', 'requestRejected', 'requestFailed', 'requestSucceeded', 'stateChanged', 'breakerReset'].includes(type)) {
      return;
    }

    const date = new Date();
    logs.unshift({
      time: date.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(date.getMilliseconds()).padStart(3, '0'),
      id: payload && payload.id ? `#${payload.id}` : '-',
      type,
      detail: describeEvent(type, payload)
    });
    logs.splice(18);
    renderLogs();
  }

  function describeEvent(type, payload) {
    if (type === 'retryScheduled') {
      return `第 ${payload.attempt + 1} 次请求将在 ${payload.delayMs}ms 后执行`;
    }
    if (type === 'attemptStarted') {
      return payload.isProbe ? '半开探测 Fetch 开始' : `第 ${payload.attempt + 1} 次 Fetch 开始`;
    }
    if (type === 'attemptFailed') {
      return `${payload.error.message}${payload.error.status ? ` · HTTP ${payload.error.status}` : ''}`;
    }
    if (type === 'attemptSucceeded') {
      return payload.isProbe ? '半开探测 Fetch 成功' : 'Fetch 成功';
    }
    if (type === 'requestRejected' || type === 'requestFailed') {
      return payload.error.message;
    }
    if (type === 'requestSucceeded') {
      return payload.isProbe ? '请求成功，熔断器关闭' : '请求成功';
    }
    if (type === 'stateChanged') {
      return payload.breaker ? `进入 ${payload.breaker.state}（${payload.reason || '-'}）` : payload.reason;
    }
    if (type === 'breakerReset') {
      return '重置为 CLOSED';
    }
    return '请求进入 Worker';
  }

  function renderLogs() {
    elements.logBody.innerHTML = logs.map((log) => {
      const tone = getTone(log.type);
      return `<tr>
        <td>${escapeHtml(log.time)}</td>
        <td>${escapeHtml(log.id)}</td>
        <td><span class="tag ${tone}">${escapeHtml(log.type)}</span></td>
        <td>${escapeHtml(log.detail)}</td>
      </tr>`;
    }).join('');
  }

  function getTone(type) {
    if (type.includes('Succeeded')) return 'good';
    if (type.includes('Failed') || type === 'requestRejected') return 'bad';
    if (type.includes('retry') || type === 'stateChanged') return 'warn';
    return 'info';
  }

  function showToast(title, message, tone = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${tone}`;
    toast.innerHTML = `<strong>${escapeHtml(title)}</strong><div>${escapeHtml(message)}</div>`;
    elements.toastContainer.appendChild(toast);
    while (elements.toastContainer.children.length > 5) {
      elements.toastContainer.firstElementChild.remove();
    }
    setTimeout(() => toast.remove(), 4200);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }
})();
