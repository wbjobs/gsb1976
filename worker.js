importScripts('./circuit-breaker.js');

const DEFAULT_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 300,
  maxDelayMs: 2400,
  failureThreshold: 4,
  openDurationMs: 5000,
  timeoutMs: 3000
};

let requestSequence = 0;
const timerIds = new Set();
let metrics = createMetrics();

const breaker = new CircuitBreaker(DEFAULT_CONFIG, (type, data) => {
  updateMetrics(type, data);
  post(type, data);
});

self.onmessage = async (event) => {
  const message = event.data || {};

  if (message.type === 'REQUEST') {
    await executeRequest(message.payload || {});
    return;
  }

  if (message.type === 'CONFIGURE') {
    breaker.configure({
      ...DEFAULT_CONFIG,
      ...(message.payload || {})
    });
    breaker.reset('CONFIG_UPDATED');
    resetMetrics();
    post('configUpdated', breaker.getState());
    return;
  }

  if (message.type === 'RESET') {
    breaker.reset('MANUAL_RESET');
    resetMetrics();
    post('breakerReset', breaker.getState());
    return;
  }

  if (message.type === 'GET_METRICS') {
    post('metrics', getMetrics());
  }
};

async function executeRequest({ url, method = 'GET', body, requestId }) {
  const id = requestId || ++requestSequence;

  try {
    const response = await breaker.execute(async ({ attempt, isProbe }) => {
      const controller = new AbortController();
      const timerId = setTimeout(() => controller.abort(), breaker.config.timeoutMs);
      timerIds.add(timerId);

      try {
        const fetchOptions = {
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-Attempt': String(attempt),
            'X-Probe': isProbe ? '1' : '0'
          },
          signal: controller.signal
        };
        if (body !== undefined && body !== null && method !== 'GET') {
          fetchOptions.body = JSON.stringify(body);
        }

        const fetchResponse = await fetch(url, fetchOptions);
        if (!fetchResponse.ok) {
          const error = new Error(`HTTP ${fetchResponse.status}`);
          error.status = fetchResponse.status;
          error.retryable = statusIsRetryable(fetchResponse.status);
          if (fetchResponse.headers.get('Retry-After')) {
            error.retryAfter = fetchResponse.headers.get('Retry-After');
          }
          throw error;
        }
        return await fetchResponse.json();
      } catch (error) {
        if (error.name === 'AbortError') {
          error.message = `请求超过 ${breaker.config.timeoutMs}ms`;
          error.retryable = true;
        } else if (!error.status) {
          error.retryable = true;
        }
        throw error;
      } finally {
        clearTimeout(timerId);
        timerIds.delete(timerId);
      }
    });

    post('requestCompleted', {
      id,
      response,
      metrics: getMetrics()
    });
  } catch (error) {
    post('requestCompleted', {
      id,
      error: serializeError(error),
      metrics: getMetrics()
    });
  }
}

function statusIsRetryable(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function serializeError(error) {
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
    code: error.code || 'UNKNOWN',
    status: error.status,
    retryable: Boolean(error.retryable)
  };
}

function createMetrics() {
  return {
    requests: 0,
    attempts: 0,
    successes: 0,
    failures: 0,
    rejected: 0,
    retries: 0,
    fetches: 0
  };
}

function resetMetrics() {
  metrics = createMetrics();
  post('metrics', getMetrics());
}

function getMetrics() {
  return {
    ...metrics,
    state: breaker.getState()
  };
}

function updateMetrics(type) {
  if (type === 'requestStarted') {
    metrics.requests += 1;
  } else if (type === 'attemptStarted') {
    metrics.attempts += 1;
    metrics.fetches += 1;
  } else if (type === 'requestSucceeded') {
    metrics.successes += 1;
  } else if (type === 'requestFailed') {
    metrics.failures += 1;
  } else if (type === 'requestRejected') {
    metrics.rejected += 1;
  } else if (type === 'retryScheduled') {
    metrics.retries += 1;
  }
}

function post(type, payload) {
  self.postMessage({ type, payload });
}
