# 分形 debug 启动入口（2026-08-10 新增——排查「卡思考中」等引擎无响应问题）
# 运行方式：npm run debug
#
# 三条排查通道：
#   1. OC_GUI_DEBUG=1 → 应用加载完成后自动打开 DevTools（渲染进程 console/网络请求）
#   2. 主进程 console 直接输出到本终端——serve stderr 已由主进程转发
#      （server-manager.ts handleServeStderrChunk：console + serve.log 双写）
#   3. serve 完整输出落盘 %APPDATA%\fractal\logs\serve.log（10MB 轮转），
#      应用内诊断面板「引擎日志」页（输入框左侧 ▸ 诊断信息按钮）实时可读
#
# 典型问题定位：
#   - 发送后卡「思考中」→ 看 serve.log 是否有消息接收/模型调用/报错行
#   - 引擎列表空 → 看 serve.log 是否正常 listening，或 serve-crash-*.log（崩溃转储）
# 注意：本文件必须保持 UTF-8 带 BOM——PS5.1 无 BOM 时按 ANSI 解析中文乱码（2026-08-10 审查发现）
$env:OC_GUI_DEBUG = "1"
Write-Host "=== 分形 debug 模式 ===" -ForegroundColor Cyan
Write-Host "DevTools 将自动打开；serve 输出经主进程转发到此终端" -ForegroundColor Yellow
Write-Host "serve 完整日志: $env:APPDATA\fractal\logs\serve.log" -ForegroundColor Yellow
npm run dev
