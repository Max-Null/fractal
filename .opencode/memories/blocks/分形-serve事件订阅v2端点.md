<!-- type: knowledge --><!-- status: auto --><!-- description: serve 事件订阅必须用 v2 /global/event（v1 /event 按订阅时当前实例目录过滤，多工作区会话零事件卡「思考中」） -->
# 分形-serve事件订阅v2端点
**事实**：serve 1.18.15 有两条事件通道——v1 /event 按「订阅时的当前实例目录」过滤事件（源码 filter9：location.directory === instance.directory），v2 /global/event 直连全局事件总线不过滤（GlobalPaths.event 实锤）。
**原则**：分形订阅必须用 v2 /global/event；订阅前等 stderr `message=init` 行（/doc 可达 ≠ 事件总线就绪）；SDK createSseClient 硬编码 /event 无法指向 v2 → 手写 fetch + SSE 解析（data: 行 + payload 解包 + 指数退避重连）。
**反例**：❌ 用 SDK event.subscribe → 多工作区（fractal/doc-edit）会话在 serve 重启后零事件，GUI 永远卡「思考中」，serve.log 无 `global event connected` 回声；❌ 用 /api/event → 不存在，命中 SPA fallback 返回 200 HTML，看似成功实则零事件。
**结论**：事件零到达时先查订阅端点 + init 行；v2 端点报错（404/HTML）从 serve 源码验证 GlobalPaths，不猜。
