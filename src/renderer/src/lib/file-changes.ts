// 文件修改卡片提取逻辑：从 toolUses 提取 write/edit → 按 file_path 合并去重
// 设计取舍：删除识别 / bash 修改精确列出 / 完整文件级 diff 均不做（见设计方案六）
import type { ToolUse, FileChangeItem } from "@/stores/chat";

/** 会修改工作区文件的工具（小写判定；与 useStreamProcessor 的 oc-file-changed 集合一致但只取可提取路径的） */
const FILE_TOOLS = new Set(["write", "edit"]);

/** 从工具数组提取文件修改条目：write/edit 且含 file_path；同文件按序合并 old/new */
export function extractFileChanges(toolUses: ToolUse[]): FileChangeItem[] {
  const items: FileChangeItem[] = [];
  for (const tu of toolUses) {
    const name = (tu.name ?? "").toLowerCase();
    if (!FILE_TOOLS.has(name)) continue;
    const filePath = (tu.input?.file_path as string | undefined)?.trim();
    // 缺 file_path 的 write/edit（如 edit 仅传 old/new 无路径）无法定位文件 → 跳过
    if (!filePath) continue;
    const oldString = name === "edit" ? (tu.input.old_string as string | undefined) : undefined;
    const newString = (name === "edit" ? tu.input.new_string : tu.input.content) as string | undefined;
    items.push({
      filePath,
      toolName: name,
      ...(oldString ? { oldString } : {}),
      ...(newString ? { newString } : {}),
      // 持久化默认 modified；added 由显示层探测文件存在性后升级（见 FileChangeCard）
      status: "modified",
    });
  }
  return mergeFileChanges(items);
}

/** 已提取条目的合并：同 filePath 合并（edit 的 old/new 按序拼接；write 只留首次 newString） */
export function mergeFileChanges(items: FileChangeItem[]): FileChangeItem[] {
  const byPath = new Map<string, FileChangeItem>();
  const order: string[] = [];
  for (const item of items) {
    const prev = byPath.get(item.filePath);
    if (!prev) {
      byPath.set(item.filePath, { ...item });
      order.push(item.filePath);
      continue;
    }
    // 同文件合并：edit 片段按序拼接；write 的 newString 保留首次（后续 edit 续接）
    if (item.oldString) prev.oldString = prev.oldString ? `${prev.oldString}\n${item.oldString}` : item.oldString;
    if (item.newString) prev.newString = prev.newString ? `${prev.newString}\n${item.newString}` : item.newString;
    prev.toolName = prev.toolName === "write" || item.toolName === "write" ? "write" : "edit";
  }
  return order.map((p) => byPath.get(p)!);
}
