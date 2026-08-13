# 决策：自动更新机制 — 转 public + electron-updater

> 日期：2026-08-14
> 状态：已决策（待验证阶段真实发布确认）
> 决策人：MaxNull
> 关联仓库：fractal（本仓库，`Max-Null/fractal`）
> 结论绑定：electron-updater ^6.6.x；electron-builder ^26.15.3；Electron 43.x

---

## 一、背景

1. 分形面向非编程人员，当前无任何更新机制——用户永远不知道有新版本，只能手动找安装包重装。
2. 用户提问「我们可否借用 github 实现自动检查更新并一键更新的机制」，评估后确认可行（electron-builder 生态原生支持），但有一个关键分叉：**仓库可见性**。

## 二、关键事实

### 2.1 仓库为 private，决定方案走向

- `Max-Null/fractal` 为 **private** 仓库。
- electron-updater + GitHub Releases：private 仓库需客户端内嵌 GH_TOKEN（会打进安装包、可被提取泄露，对小白分发有安全风险）；转 public 则零 token 直接读 Releases。
- GitHub Pages 托管安装包方案：private 仓库开不了 Pages，死路。

### 2.2 技术栈现状

| 项 | 现状 | 结论 |
|---|---|---|
| 打包 | electron-builder.yml NSIS 向导模式 + extraResources | ✅ 已就绪，publish 为 generic 占位符需改 |
| electron-updater | 未安装 | 需新增 |
| electron-builder | ^24.9.1（2023 年旧版） | Electron 43 打包兼容性存疑，需升级 26.x |
| 主进程更新逻辑 | 无 | 需新增 |
| 渲染层更新 UI | 无 | 挂载点：SettingsPanel「关于」tab |

## 三、决策

1. **仓库转 public**（`Max-Null/fractal` private → public）——electron-updater 零 token 直读 Releases，体验最好。
2. **采用 electron-updater**（差分更新、静默安装、自动重启，官方生态最成熟）。
3. **升级 electron-builder 24.9.1 → ^26.15.3**——配套 electron-updater ^6.6.x，对 Electron 43 打包兼容。
4. **检查时机**：启动后延迟 10s 静默检查（有新版才提示）+ 关于页手动「检查更新」按钮。
5. **下载交互**：应用内置下载（进度条），不弹浏览器；下载完成提示重启安装。
6. **发布流程**：无 CI，先手动发布（`electron-builder --publish always` + GH_TOKEN），后续可加 GitHub Actions。

## 四、风险与验证要求

- [ ] NSIS 向导模式（oneClick:false）+ 自动更新：用户改过安装路径是已知 edge case——验证阶段必须真实发布测试版验证
- [ ] electron-builder 升级可能引入打包配置兼容问题——升级后立即跑真实打包验证
- [ ] 未签名安装包 SmartScreen 警告维持现状（不新增负担）

## 五、关联文档

- `docs/设计/自动更新-设计方案.md`（完整方案）
- `docs/变更记录.md`
