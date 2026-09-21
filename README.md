# Fetch + Web Worker + Canvas 弹性请求演示

零依赖示例，覆盖重试、指数退避、熔断三态状态机、半开探测恢复和 Canvas 实时可视化。

## 启动

```bash
npm start
```

打开 http://localhost:3000 。

```bash
npm test
```

运行核心状态机测试。

## 演示步骤

1. 保持“持续失败”，点击“发起请求”。
2. 观察 Canvas 中的退避区间，默认延迟为 300ms、600ms、1200ms。
3. 失败达到阈值后进入 OPEN，再点击请求只会被熔断拒绝，不产生 Fetch。
4. 等待冷却结束进入 HALF_OPEN，此时只放行一个探测请求。
5. 切换到“成功”后点击请求，探测成功并恢复 CLOSED。
6. 切换到“超时”验证 AbortController 超时异常、错误提示和重试。

## 验收点

- 熔断后不再请求：OPEN 状态在 beforeFetch() 中直接拒绝，不调用 Fetch。
- 半开恢复：HALF_OPEN 仅允许一个探测，成功关闭，失败重新 OPEN。
- 退避正确：backoffDelayMs() 使用指数退避并受最大退避限制。
- 可视化准确：单画布绘制状态机、状态背景、退避、Fetch、拒绝和探测。
- 异常有提示：请求失败、熔断拒绝、配置错误和 Worker 错误均有 Toast 与日志。
- 性能：Fetch 与重试在 Worker 中执行，Canvas 使用 requestAnimationFrame 并限制 DPR。

## 文件

- circuit-breaker.js：熔断状态机。
- worker.js：Worker Fetch、超时、重试和指标。
- timeline.js：Canvas 可视化。
- app.js：页面控制、Worker 通信、日志和提示。
- server.js：静态文件服务和可控故障 API。
- test/breaker.test.js：核心自动化测试。
