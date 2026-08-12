<!-- type: knowledge --><!-- status: auto --><!-- description: DeepSeek 模型端不支持 office/二进制附件，分形只做弱提示+发送确认不手搓提取 -->

# 分形-office附件模型端不支持（不手搓提取）

- 事实：DeepSeek 模型端无文档解析能力。pdf 报 `Cannot read "...pdf" (this model does not support pdf input)`；docx/xlsx base64 传过去读不了。文本类（txt/md/csv/html/json）serve 原生 Read 注入，模型正常读
- 原则：二进制附件（pdf/docx/xlsx/pptx/zip 等）**不做提取兜底**——OC 本身不支持，行为一致即可；分形只做 UI 层提示（chips ⚠ 弱提示 + 发送前确认），用户自行转文本
- 反例：❌ 曾想主进程用 mammoth/xlsx/pdf-parse 提取文本（用户明确「OC 原生如何处理」——不需要，OC 也不支持）
- ✅ 实现：`isOfficeAttachment(name)` 扩展名白名单（渲染层判断），ChatPanel handleSend 发送前 `confirm(t("chat.officeAttachConfirm"))`，取消保留附件 chips
- 结论：判断附件可读性看**模型端能力**而非 OC 能力；文本类 serve 自动注入，二进制类模型端接不住

