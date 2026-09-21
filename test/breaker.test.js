const assert = require('node:assert/strict');
const { CircuitBreaker, STATES } = require('../circuit-breaker.js');

function createFakeScheduler() {
  let now = 10000;
  const pending = [];
  return {
    now: () => now,
    setTimeout(fn, delayMs) {
      const timer = { fn, time: now + delayMs, cancelled: false };
      pending.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cancelled = true;
    },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = pending
          .filter((timer) => !timer.cancelled && timer.time >= now && timer.time <= end)
          .sort((a, b) => a.time - b.time)[0];
        if (!next) break;
        now = next.time;
        next.cancelled = true;
        await next.fn();
      }
      now = end;
    }
  };
}

function failure(message = 'temporary failure') {
  const error = new Error(message);
  error.retryable = true;
  return error;
}

async function testBackoff() {
  const scheduler = createFakeScheduler();
  const delays = [];
  let attempts = 0;
  const breaker = new CircuitBreaker({
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    failureThreshold: 10,
    scheduler
  }, (type, data) => {
    if (type === 'retryScheduled') delays.push(data.delayMs);
  });

  const promise = breaker.execute(async () => {
    attempts += 1;
    if (attempts < 4) throw failure();
    return { ok: true };
  });
  await scheduler.advance(700);
  await promise;

  assert.equal(attempts, 4);
  assert.deepEqual(delays, [100, 200, 400]);
  assert.equal(breaker.getState().state, STATES.CLOSED);
}

async function testOpensAndBlocksRequests() {
  const scheduler = createFakeScheduler();
  const calls = [];
  const breaker = new CircuitBreaker({
    maxRetries: 0,
    baseDelayMs: 100,
    failureThreshold: 2,
    openDurationMs: 1000,
    scheduler
  });

  await assert.rejects(breaker.execute(async () => {
    calls.push(1);
    throw failure();
  }));
  assert.equal(breaker.getState().state, STATES.CLOSED);

  await assert.rejects(breaker.execute(async () => {
    calls.push(2);
    throw failure();
  }));
  assert.equal(breaker.getState().state, STATES.OPEN);

  await assert.rejects(breaker.execute(async () => {
    calls.push(3);
    throw failure();
  }), /熔断中/);
  assert.deepEqual(calls, [1, 2]);
}

async function testHalfOpenProbeSuccessCloses() {
  const scheduler = createFakeScheduler();
  const calls = [];
  const transitions = [];
  const breaker = new CircuitBreaker({
    maxRetries: 0,
    baseDelayMs: 100,
    failureThreshold: 1,
    openDurationMs: 1000,
    scheduler
  }, (type, data) => {
    if (type === 'stateChanged') transitions.push(data.breaker.state);
  });

  await assert.rejects(breaker.execute(async () => {
    calls.push('failed');
    throw failure();
  }));
  await scheduler.advance(1000);
  assert.equal(breaker.getState().state, STATES.HALF_OPEN);

  const recovery = breaker.execute(async () => {
    calls.push('probe');
    return { recovered: true };
  });
  const result = await recovery;

  assert.deepEqual(result, { recovered: true });
  assert.equal(breaker.getState().state, STATES.CLOSED);
  assert.deepEqual(calls, ['failed', 'probe']);
  assert.deepEqual(transitions, ['OPEN', 'HALF_OPEN', 'CLOSED']);
}

async function testHalfOpenProbeFailureReopens() {
  const scheduler = createFakeScheduler();
  const calls = [];
  const breaker = new CircuitBreaker({
    maxRetries: 0,
    baseDelayMs: 100,
    failureThreshold: 1,
    openDurationMs: 1000,
    scheduler
  });

  await assert.rejects(breaker.execute(async () => {
    calls.push('initial');
    throw failure();
  }));
  await scheduler.advance(1000);
  assert.equal(breaker.getState().state, STATES.HALF_OPEN);

  await assert.rejects(breaker.execute(async () => {
    calls.push('probe');
    throw failure('probe still fails');
  }), /熔断已打开/);

  assert.equal(breaker.getState().state, STATES.OPEN);
  assert.deepEqual(calls, ['initial', 'probe']);
}

async function run() {
  await testBackoff();
  await testOpensAndBlocksRequests();
  await testHalfOpenProbeSuccessCloses();
  await testHalfOpenProbeFailureReopens();
  console.log('4 circuit breaker tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
