(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const STATES = Object.freeze({
    CLOSED: 'CLOSED',
    OPEN: 'OPEN',
    HALF_OPEN: 'HALF_OPEN'
  });

  const DEFAULTS = Object.freeze({
    maxRetries: 3,
    baseDelayMs: 300,
    maxDelayMs: 2400,
    jitterRatio: 0,
    failureThreshold: 4,
    openDurationMs: 5000,
    timeoutMs: 3000
  });

  class CircuitBreakerError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = 'CircuitBreakerError';
      this.code = options.code || 'CIRCUIT_ERROR';
      if (options.cause) {
        this.cause = options.cause;
      }
    }
  }

  class CircuitOpenError extends CircuitBreakerError {
    constructor(message, options = {}) {
      super(message, options);
      this.name = 'CircuitOpenError';
    }
  }

  function defaultScheduler() {
    return {
      now: () => Date.now(),
      setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
      clearTimeout: (timer) => clearTimeout(timer)
    };
  }

  function serializeError(error) {
    return {
      name: error && error.name ? error.name : 'Error',
      message: error && error.message ? error.message : String(error),
      code: error && error.code ? error.code : 'UNKNOWN',
      status: error ? error.status : undefined,
      retryable: Boolean(error && error.retryable)
    };
  }

  function isRetryable(error) {
    return Boolean(error && error.retryable);
  }

  class CircuitBreaker {
    constructor(config = {}, listener) {
      this.config = {};
      this.scheduler = defaultScheduler();
      this.configure(config);
      this.listener = typeof listener === 'function' ? listener : null;
      this.generation = 0;
      this.sequence = 0;
      this.reset();
    }

    configure(config = {}) {
      const nextConfig = { ...(config || {}) };
      const scheduler = nextConfig.scheduler || this.scheduler;
      delete nextConfig.scheduler;
      this.config = { ...DEFAULTS, ...this.config, ...nextConfig };
      this.scheduler = scheduler;

      const integerKeys = ['maxRetries', 'failureThreshold'];
      const numberKeys = [
        'baseDelayMs',
        'maxDelayMs',
        'openDurationMs',
        'timeoutMs',
        'jitterRatio'
      ];

      for (const key of integerKeys) {
        if (!Number.isInteger(this.config[key]) || this.config[key] < 0) {
          throw new Error(`${key} must be a non-negative integer`);
        }
      }
      for (const key of numberKeys) {
        if (!Number.isFinite(this.config[key]) || this.config[key] < 0) {
          throw new Error(`${key} must be a non-negative number`);
        }
      }
      if (this.config.failureThreshold < 1) {
        throw new Error('failureThreshold must be at least 1');
      }
      if (this.config.maxDelayMs < this.config.baseDelayMs) {
        throw new Error('maxDelayMs must be greater than or equal to baseDelayMs');
      }
      if (this.config.jitterRatio > 1) {
        throw new Error('jitterRatio must be between 0 and 1');
      }
    }

    reset(reason = 'RESET') {
      if (this.timer) {
        this.scheduler.clearTimeout(this.timer);
      }
      this.generation += 1;
      this.state = STATES.CLOSED;
      this.failureCount = 0;
      this.probeInFlight = false;
      this.openUntil = 0;
      this.timer = null;
      this.emit('breakerReset', { reason });
      this.emit('stateChanged', { reason });
    }

    now() {
      return this.scheduler.now();
    }

    sleep(delayMs) {
      return new Promise((resolve) => {
        this.scheduler.setTimeout(resolve, delayMs);
      });
    }

    getState() {
      const now = this.now();
      return {
        state: this.state,
        failureCount: this.failureCount,
        failureThreshold: this.config.failureThreshold,
        probeInFlight: this.probeInFlight,
        openUntil: this.openUntil,
        openRemainingMs: this.state === STATES.OPEN
          ? Math.max(0, this.openUntil - now)
          : 0,
        generation: this.generation,
        config: { ...this.config }
      };
    }

    backoffDelayMs(retryIndex) {
      const exponentialDelay = this.config.baseDelayMs * (2 ** retryIndex);
      const cappedDelay = Math.min(exponentialDelay, this.config.maxDelayMs);
      if (this.config.jitterRatio > 0) {
        const factor = 1 - this.config.jitterRatio * Math.random();
        return Math.max(0, Math.round(cappedDelay * factor));
      }
      return Math.round(cappedDelay);
    }

    open(reason) {
      if (this.timer) {
        this.scheduler.clearTimeout(this.timer);
        this.timer = null;
      }
      const now = this.now();
      this.state = STATES.OPEN;
      this.probeInFlight = false;
      this.openUntil = now + this.config.openDurationMs;
      this.emit('stateChanged', { reason });
      this.timer = this.scheduler.setTimeout(() => {
        this.timer = null;
        this.transitionToHalfOpen('COOLDOWN_FINISHED');
      }, this.config.openDurationMs);
    }

    transitionToHalfOpen(reason) {
      if (this.state !== STATES.OPEN) {
        return;
      }
      this.state = STATES.HALF_OPEN;
      this.probeInFlight = false;
      this.openUntil = 0;
      this.emit('stateChanged', { reason });
    }

    close(reason) {
      if (this.timer) {
        this.scheduler.clearTimeout(this.timer);
        this.timer = null;
      }
      this.state = STATES.CLOSED;
      this.failureCount = 0;
      this.probeInFlight = false;
      this.openUntil = 0;
      this.emit('stateChanged', { reason });
    }

    beforeFetch() {
      const now = this.now();
      if (this.state === STATES.OPEN && now >= this.openUntil) {
        this.transitionToHalfOpen('COOLDOWN_FINISHED');
      }

      if (this.state === STATES.OPEN) {
        return {
          allowed: false,
          isProbe: false,
          error: new CircuitOpenError(
            `熔断中，${Math.max(0, this.openUntil - now)}ms 后进入半开`,
            { code: 'CIRCUIT_OPEN' }
          )
        };
      }

      if (this.state === STATES.HALF_OPEN && this.probeInFlight) {
        return {
          allowed: false,
          isProbe: false,
          error: new CircuitBreakerError('半开探测进行中，本次请求不会访问服务端', {
            code: 'CIRCUIT_HALF_OPEN_BUSY'
          })
        };
      }

      const isProbe = this.state === STATES.HALF_OPEN;
      if (isProbe) {
        this.probeInFlight = true;
      }
      return { allowed: true, isProbe };
    }

    recordSuccess(isProbe) {
      if (isProbe) {
        this.probeInFlight = false;
        if (this.state === STATES.HALF_OPEN) {
          this.close('PROBE_SUCCESS');
        }
        return;
      }
      if (this.state === STATES.CLOSED) {
        this.failureCount = 0;
      }
    }

    recordFailure(isProbe) {
      if (isProbe) {
        this.probeInFlight = false;
        this.open('PROBE_FAILURE');
        return;
      }
      if (this.state !== STATES.CLOSED) {
        return;
      }
      this.failureCount += 1;
      if (this.failureCount >= this.config.failureThreshold) {
        this.open('FAILURE_THRESHOLD');
      }
    }

    async execute(fn) {
      if (typeof fn !== 'function') {
        throw new TypeError('CircuitBreaker.execute requires a function');
      }

      const id = ++this.sequence;
      const generation = this.generation;
      let attempt = 0;
      let lastError = null;

      this.emit('requestStarted', { id });

      try {
        while (true) {
          if (attempt > 0) {
            const delayMs = this.backoffDelayMs(attempt - 1);
            this.emit('retryScheduled', {
              id,
              attempt,
              delayMs
            });
            await this.sleep(delayMs);
            if (generation !== this.generation) {
              throw new CircuitBreakerError('请求因熔断器重置而终止', {
                code: 'BREAKER_RESET'
              });
            }
          }

          const permission = this.beforeFetch();
          if (!permission.allowed) {
            if (lastError) {
              permission.error.cause = lastError;
            }
            this.emit('requestRejected', {
              id,
              error: serializeError(permission.error)
            });
            throw permission.error;
          }

          const isProbe = permission.isProbe;
          this.emit('attemptStarted', {
            id,
            attempt,
            isProbe
          });

          try {
            const result = await fn({ attempt, isProbe });
            if (generation !== this.generation) {
              throw new CircuitBreakerError('请求因熔断器重置而终止', {
                code: 'BREAKER_RESET'
              });
            }
            this.recordSuccess(isProbe);
            this.emit('attemptSucceeded', {
              id,
              attempt,
              isProbe
            });
            this.emit('requestSucceeded', {
              id,
              attempt,
              isProbe,
              result
            });
            return result;
          } catch (error) {
            lastError = error;
            const retryable = isRetryable(error);
            if (generation === this.generation && retryable) {
              this.recordFailure(isProbe);
            }
            this.emit('attemptFailed', {
              id,
              attempt,
              isProbe,
              error: serializeError(error)
            });

            if (generation !== this.generation) {
              throw new CircuitBreakerError('请求因熔断器重置而终止', {
                code: 'BREAKER_RESET',
                cause: error
              });
            }
            if (this.state === STATES.OPEN) {
              throw new CircuitOpenError('熔断已打开，请求终止', {
                code: 'CIRCUIT_OPEN',
                cause: error
              });
            }
            if (!retryable) {
              throw error;
            }
            if (attempt >= this.config.maxRetries) {
              throw error;
            }
            attempt += 1;
          }
        }
      } catch (error) {
        this.emit('requestFailed', {
          id,
          error: serializeError(error)
        });
        throw error;
      }
    }

    emit(type, data = {}) {
      if (!this.listener) {
        return;
      }
      this.listener(type, {
        ...data,
        at: this.now(),
        breaker: this.getState()
      });
    }
  }

  return {
    STATES,
    CircuitBreaker,
    CircuitBreakerError,
    CircuitOpenError
  };
});
