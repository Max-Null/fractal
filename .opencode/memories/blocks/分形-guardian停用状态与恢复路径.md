<!-- type: knowledge --><!-- status: auto --><!-- description: fractal-guardian 因日志风暴临时停用（事件钩子同步 IO 阻塞 serve），恢复需 oc-plus 修复后改三处 -->
# 分形-guardian停用状态与恢复路径
**事实**：guardian（oc-plus 插件）的 session.status 事件钩子同步 appendFileSync + 50KB 轮转（readFileSync+writeFileSync）——事件风暴时每秒 1-2 次大 IO 阻塞 serve 事件循环 → LLM 流事件排队 → GUI 卡「思考中」。2026-08-11 临时停用。
**原则**：停用是临时的（代码注释标记「oc-plus 修复后恢复」）；恢复需改三处：① preset.ts buildPluginDecls files 数组加回 fractal-guardian.js；② preset.ts ensurePresetConfig 的 filter 移除 fractal-guardian 清理；③ 隔离插件目录 fractal-guardian.js.bak 改回 .js。
**反例**：❌ 只改配置不还原名（.bak）→ serve 加载不到；❌ 只还文件不改 preset → 下次启动又被 filter 清掉。
**结论**：恢复前先修 oc-plus 的日志写入（异步/限流），否则风暴复现；当前状态 = 配置无声明 + 文件 .bak + preset filter 双保险。
