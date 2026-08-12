<!-- type: knowledge --><!-- status: pending --><!-- description: oc-plus agent model 占位符 DS_MODEL_HIGH/LOW 必须被 sync detectSlot 识别，否则槽位降级 inherit 导致 fractal 不替换 -->

# sync detectSlot 占位符识别（2026-08-12）

**事实**：oc-plus 双星.md 的 model 行是占位符 `model: "DS_MODEL_HIGH"`（model-aliases.json 映射 DS_MODEL_HIGH=pro / DS_MODEL_LOW=flash），非字面模型名。sync-to-fractal.mjs 的 detectSlot 从 model 行推断槽位：无 model 行→inherit；含 kimi→vision；含 ds-anthropic→anthropic；含 -pro→high；含 -flash→low。

**原则**：detectSlot 必须同时识别占位符——`DS_MODEL_HIGH`→high、`DS_MODEL_LOW`→low。

**反例**：❌ 2026-08-12 真实踩坑：双星 model 改为占位符后，detectSlot 不认识 → 槽位从 high 错误降为 inherit → fractal applyModelAliases 对 inherit 跳过替换 → preset 双星携带字面量 `DS_MODEL_HIGH` 运行（非法模型），且设置页「主模型选择」对双星失效；preset.test.ts 5 个用例失败暴露。✅ 修复 detectSlot 后槽位恢复 high，测试全绿。

**结论**：契约漂移信号 = preset.test.ts「按槽位替换」用例失败。修复后必须重跑 sync（manifest 重建 + preset version 递增）再跑 fractal 全量测试。
