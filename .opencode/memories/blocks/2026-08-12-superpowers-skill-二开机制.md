<!-- type: knowledge --><!-- status: pending --><!-- description: superpowers 包内 skill 与项目约定冲突时，用全局目录同名覆盖实现二开，npm 更新不影响二开版 -->

# superpowers skill 二开机制（2026-08-12）

**事实**：superpowers v6.2.0 是 npm 插件包（`~/.config/opencode/node_modules/superpowers`，经 opencode.json plugin 加载），npm 更新会整目录覆盖。opencode skill 同名覆盖优先级：`.opencode/skills/`（项目级最高）→ `~/.config/opencode/skills/`（全局原生）→ 插件内置（superpowers 在此层，最低）。

**原则**：superpowers 内置 skill 与项目约定冲突时，不直接改 node_modules（会被更新冲掉），而是拷贝到 `~/.config/opencode/skills/<同名>/` 改定制点，靠同名覆盖生效。

**反例**：brainstorming 默认写 `docs/superpowers/specs/`、writing-plans 默认写 `docs/superpowers/plans/`，与项目 `docs/设计/`、`docs/计划/`、`.opencode/plans/` 体系冲突（2026-08-12 实际踩坑：brainstorming 差点写错目录被用户纠正）。

**已二开清单**（2026-08-12）：
- `~/.config/opencode/skills/brainstorming/`：设计文档 → `docs/设计/YYYY-MM-DD-<topic>-设计方案.md`，同主题已有文档则更新原文件
- `~/.config/opencode/skills/writing-plans/`：临时计划 → `.opencode/plans/{日期}-{时间}-{关键词}.md`，正式计划 → 额外复制到 `docs/计划/`
- 其余 12 个 superpowers skill 无路径冲突，未二开

**结论**：二开 = 分叉，无自动跟随；跟随更新 = 定期 diff `node_modules/superpowers/skills/<name>/SKILL.md` vs 二开版，手动合并上游新增逻辑（改动点少，成本低）。
