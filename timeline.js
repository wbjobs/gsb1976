(function () {
  const COLORS = {
    CLOSED: '#3fb950',
    OPEN: '#f85149',
    HALF_OPEN: '#d29922',
    wait: '#bc8cff',
    success: '#3fb950',
    error: '#f85149',
    active: '#58a6ff',
    rejected: '#91a7c2',
    text: '#eef6ff',
    muted: '#91a7c2',
    grid: 'rgba(145,167,194,0.16)',
    panel: '#0b1c31'
  };

  class ResilienceTimeline {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.records = [];
      this.stateIntervals = [{ state: 'CLOSED', start: performance.now() }];
      this.currentState = 'CLOSED';
      this.openUntil = 0;
      this.resize();
      window.addEventListener('resize', () => this.resize());
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
      this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.width = rect.width;
      this.height = rect.height;
      this.draw();
    }

    reset() {
      this.records = [];
      this.stateIntervals = [{ state: 'CLOSED', start: performance.now() }];
      this.currentState = 'CLOSED';
      this.openUntil = 0;
      this.draw();
    }

    setState(state, at, reason, breaker) {
      if (state === this.currentState) {
        if (state === 'OPEN') {
          this.openUntil = breaker.openUntil ? performance.now() + breaker.openRemainingMs : 0;
        } else {
          this.openUntil = 0;
        }
        return;
      }
      const now = at || performance.now();
      const last = this.stateIntervals[this.stateIntervals.length - 1];
      if (last) {
        last.end = now;
      }
      this.stateIntervals.push({ state, start: now, reason });
      this.currentState = state;
      this.openUntil = state === 'OPEN' && breaker
        ? now + breaker.openRemainingMs
        : 0;
      this.draw();
    }

    addEvent(type, payload) {
      const now = performance.now();
      const id = Number(payload.id || 0);
      let record = this.records.find((item) => item.id === id && !item.completed);

      if (type === 'requestStarted') {
        const lane = this.findFreeLane(now);
        record = {
          id,
          lane,
          start: now,
          end: now,
          completed: false,
          attempts: [],
          waits: [],
          rejected: false
        };
        this.records.push(record);
      } else if (!record) {
        record = {
          id,
          lane,
          start: now,
          end: now,
          completed: false,
          attempts: [],
          waits: [],
          rejected: false
        };
        this.records.push(record);
      }

      if (type === 'retryScheduled') {
        record.waits.push({
          start: now,
          end: now + payload.delayMs,
          delayMs: payload.delayMs,
          attempt: payload.attempt
        });
      }

      if (type === 'attemptStarted') {
        record.attempts.push({
          start: now,
          end: 0,
          completed: false,
          attempt: payload.attempt,
          isProbe: Boolean(payload.isProbe)
        });
      }

      if (type === 'attemptFailed' || type === 'attemptSucceeded') {
        const attempt = [...record.attempts].reverse().find((item) => !item.completed);
        if (attempt) {
          attempt.end = now;
          attempt.completed = true;
          attempt.result = type === 'attemptSucceeded' ? 'success' : 'error';
          attempt.status = payload.error ? payload.error.status : undefined;
        }
        record.end = now;
      }

      if (type === 'requestRejected') {
        record.rejected = true;
        record.rejectedAt = now;
        record.end = now;
        record.completed = true;
      }

      if (type === 'requestFailed' || type === 'requestSucceeded') {
        record.end = now;
        record.completed = true;
      }

      this.trim();
      this.draw();
    }

    trim() {
      const cutoff = performance.now() - 18000;
      this.records = this.records.filter((record) => record.end >= cutoff || !record.completed);
      this.stateIntervals = this.stateIntervals.filter((interval, index) => {
        return index === this.stateIntervals.length - 1 || (interval.end && interval.end >= cutoff);
      });
    }

    draw(now = performance.now()) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.width, this.height);
      this.drawStateMachine(now);
      this.drawTimeline(now);
    }

    drawStateMachine(now) {
      const ctx = this.ctx;
      const top = 18;
      const width = this.width;
      const nodeRadius = 27;
      const y = top + nodeRadius + 6;
      const xs = [
        width * 0.22,
        width * 0.5,
        width * 0.78
      ];
      const nodes = [
        ['CLOSED', '正常'],
        ['OPEN', '熔断'],
        ['HALF_OPEN', '半开']
      ];

      ctx.save();
      ctx.font = '700 14px system-ui, sans-serif';
      ctx.textBaseline = 'middle';

      ctx.strokeStyle = COLORS.muted;
      ctx.lineWidth = 2;
      this.drawArrow(xs[0] + nodeRadius, y, xs[1] - nodeRadius - 8, y);
      this.drawArrow(xs[1] + nodeRadius, y - 7, xs[2] - nodeRadius - 8, y - 7);
      ctx.setLineDash([6, 6]);
      this.drawArrow(xs[2] + nodeRadius, y + 10, xs[0] + nodeRadius + 8, y + 10);
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(145,167,194,.85)';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('阈值失败', (xs[0] + xs[1]) / 2, y - 14);
      ctx.fillText('冷却结束', (xs[1] + xs[2]) / 2, y - 22);
      ctx.fillText('探测成功恢复', (xs[0] + xs[2]) / 2, y + 28);

      nodes.forEach(([state, label], index) => {
        const active = state === this.currentState;
        ctx.beginPath();
        ctx.arc(xs[index], y, nodeRadius, 0, Math.PI * 2);
        ctx.fillStyle = active ? COLORS[state] : COLORS.panel;
        ctx.fill();
        ctx.lineWidth = active ? 3 : 1.5;
        ctx.strokeStyle = active ? COLORS[state] : COLORS.muted;
        ctx.stroke();
        ctx.fillStyle = active ? '#06101c' : COLORS.muted;
        ctx.font = '700 12px system-ui, sans-serif';
        ctx.fillText(state, xs[index], y - 4);
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillText(label, xs[index], y + 12);
      });

      if (this.currentState === 'OPEN') {
        const remaining = Math.max(0, this.openUntil - now);
        ctx.textAlign = 'left';
        ctx.fillStyle = COLORS.OPEN;
        ctx.font = '700 12px system-ui, sans-serif';
        ctx.fillText(`OPEN：${Math.ceil(remaining / 1000)}s 后半开，放行一个探测`, xs[1] + nodeRadius + 10, y + 2);
      }
      ctx.restore();
    }

    drawArrow(x1, y1, x2, y2) {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const angle = Math.atan2(y2 - y1, x2 - x1);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - 8 * Math.cos(angle - Math.PI / 6), y2 - 8 * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(x2 - 8 * Math.cos(angle + Math.PI / 6), y2 - 8 * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    }

    drawTimeline(now) {
      const ctx = this.ctx;
      const left = 64;
      const right = 22;
      const top = 128;
      const bottom = 62;
      const chartW = this.width - left - right;
      const chartH = this.height - top - bottom;
      const duration = 15000;
      const start = now - duration;
      const xAt = (time) => left + ((time - start) / duration) * chartW;
      const laneH = Math.min(26, chartH / 11);

      ctx.save();
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.text;
      ctx.fillText('最近 15 秒请求时间线', left, top - 22);

      for (let second = 0; second <= 15; second += 3) {
        const time = start + second * 1000;
        const x = xAt(time);
        ctx.strokeStyle = COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + chartH);
        ctx.stroke();
        ctx.fillStyle = COLORS.muted;
        ctx.fillText(`-${15 - second}s`, x + 4, top + chartH + 18);
      }

      this.stateIntervals.forEach((interval) => {
        const intervalEnd = interval.end || now;
        const x1 = xAt(Math.max(start, interval.start));
        const x2 = xAt(Math.min(now, intervalEnd));
        if (x2 <= x1) return;
        ctx.fillStyle = this.hexToRgba(COLORS[interval.state], 0.09);
        ctx.fillRect(x1, top, x2 - x1, chartH);
      });

      this.records.forEach((record) => {
        const y = top + 8 + record.lane * laneH;
        record.waits.forEach((wait) => {
          const x1 = xAt(Math.max(start, wait.start));
          const x2 = xAt(Math.min(now, wait.end || now));
          if (x2 <= x1) return;
          ctx.fillStyle = COLORS.wait;
          ctx.fillRect(x1, y, Math.max(2, x2 - x1), 5);
          if (x2 - x1 > 30) {
            ctx.fillStyle = COLORS.muted;
            ctx.fillText(`${wait.delayMs}ms`, x1 + 3, y - 3);
          }
        });

        record.attempts.forEach((attempt) => {
          const x1 = xAt(Math.max(start, attempt.start));
          const x2 = xAt(Math.min(now, attempt.end || now));
          if (x2 <= x1 && attempt.end) return;
          ctx.fillStyle = attempt.result === 'error'
            ? COLORS.error
            : attempt.result === 'success'
              ? COLORS.success
              : COLORS.active;
          ctx.fillRect(x1, y + 8, Math.max(3, x2 - x1), 10);
          if (attempt.isProbe) {
            ctx.strokeStyle = COLORS.HALF_OPEN;
            ctx.strokeRect(x1 - 1, y + 7, Math.max(5, x2 - x1) + 2, 12);
          }
        });

        if (record.rejected) {
          const x = xAt(record.rejectedAt);
          ctx.strokeStyle = COLORS.rejected;
          ctx.beginPath();
          ctx.moveTo(x - 4, y + 8);
          ctx.lineTo(x + 4, y + 18);
          ctx.moveTo(x + 4, y + 8);
          ctx.lineTo(x - 4, y + 18);
          ctx.stroke();
        }

        ctx.fillStyle = COLORS.muted;
        ctx.fillText(`#${record.id}`, 12, y + 18);
      });

      const legend = [
        ['Fetch 成功', COLORS.success],
        ['Fetch 失败', COLORS.error],
        ['退避等待', COLORS.wait],
        ['熔断拒绝', COLORS.rejected],
        ['半开探测边框', COLORS.HALF_OPEN]
      ];
      legend.forEach(([label, color], index) => {
        const x = left + (index % 2) * 145;
        const y = this.height - 46 + Math.floor(index / 2) * 15;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 10, 10);
        ctx.fillStyle = COLORS.muted;
        ctx.fillText(label, x + 15, y + 9);
      });
      ctx.restore();
    }

    findFreeLane(now) {
      let fallbackLane = 0;
      let oldestEnd = Number.POSITIVE_INFINITY;
      for (let lane = 0; lane < 11; lane += 1) {
        const occupied = this.records.some((record) => {
          return record.lane === lane && (!record.completed || record.end > now - 15000);
        });
        if (!occupied) return lane;
        const laneEnd = Math.max(...this.records
          .filter((record) => record.lane === lane)
          .map((record) => record.end || 0));
        if (laneEnd < oldestEnd) {
          oldestEnd = laneEnd;
          fallbackLane = lane;
        }
      }
      return fallbackLane;
    }

    hexToRgba(hex, alpha) {
      const value = parseInt(hex.slice(1), 16);
      const r = (value >> 16) & 255;
      const g = (value >> 8) & 255;
      const b = value & 255;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }

  window.ResilienceTimeline = ResilienceTimeline;
})();
