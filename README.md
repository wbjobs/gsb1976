# 重试 / 指数退避 / 熔断 / 半开 可视化

基于 **Fetch + Web Worker + Canvas** 的弹性调用可视化 Demo。

## 运行

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

> 必须通过 HTTP 访问（Web Worker 限制），不能直接双击打开 html。

## 架构

- `js/worker.js` — 请求引擎：熔断状态机（CLOSED/OPEN/HALF_OPEN）、指数退避重试、Fetch 请求、故障模拟。所有计时与网络都在 Worker，UI 不卡顿。
- `js/main.js` — 渲染与交互：Canvas 时间轴 + 状态机图、统计、Toast 异常提示、事件日志。
- `index.html` / `css/style.css` — 页面与样式。

## 核心机制

- **退避**：`delay = min(maxDelay, baseDelay * 2^attempt)`，可选全抖动 `* rand(0,1)`。
- **熔断**：连续失败 ≥ 阈值 → OPEN，冷却期内所有调用直接拒绝（fail-fast，零请求）。
- **半开**：冷却结束进入 HALF_OPEN，放行有限探针；探针成功 → CLOSED 恢复流量，失败 → 重新 OPEN。
- **并发安全**：重试循环在每次发请求前重新检查熔断器状态，OPEN 即中止剩余重试。

## 验收对照

| 标准 | 实现 |
| --- | --- |
| 熔断后不再请求 | OPEN 期准入拒绝 + 在途调用重试前复检，OPEN 窗口零请求 |
| 半开恢复 | 探针成功 → CLOSED；探针失败 → 重新 OPEN |
| 退避正确 | 时间轴虚线标注每次退避毫秒数，统计栏显示计算公式 |
| 可视化准确 | 顶部色带 = 熔断器状态时间线；绿/红/橙点 = 成功/失败/超时；灰✕ = 熔断拒绝 |
| 异常有提示 | Toast 弹窗 + 分级事件日志 |

## 演示建议

默认剧本「宕机后恢复」+ 启动负载，可完整观察：正常 → 失败重试（退避拉长）→ 熔断（请求归零，✕ 增多）→ 冷却 → 半开探针 → 恢复闭合。
