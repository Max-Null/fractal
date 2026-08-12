// FileChangeCard 测试：文件修改卡片（清单渲染 / 状态徽标 / 点击展开 diff / write 探测升级 added）
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import FileChangeCard from "./FileChangeCard.vue";
import { readFileContent } from "@/lib/electron-bridge";
import type { FileChangeItem } from "@/stores/chat";

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: { en: { chat: { fileChanges: "Files changed", added: "added", modified: "modified" } } },
});

// readFileContent mock：可注入不同错误；默认 ENOENT（文件不存在 → added 升级）
vi.mock("@/lib/electron-bridge", () => ({
  readFileContent: vi.fn(),
}));

beforeEach(() => {
  (readFileContent as any).mockRejectedValue(new Error("ENOENT: no such file"));
});

function mountCard(changes: FileChangeItem[]) {
  return mount(FileChangeCard, { props: { changes }, global: { plugins: [i18n] } });
}

describe("FileChangeCard", () => {
  it("渲染文件清单（图标 + 路径 + 状态徽标）", () => {
    const w = mountCard([{ filePath: "a.txt", toolName: "write", newString: "x", status: "modified" }]);
    expect(w.text()).toContain("a.txt");
    expect(w.text()).toContain("modified");
  });

  it("点击文件行展开 diff 区（write 显示新内容代码块）", async () => {
    const w = mountCard([{ filePath: "a.txt", toolName: "write", newString: "hello", status: "modified" }]);
    expect(w.find(".file-change-diff").exists()).toBe(false);
    await w.find(".file-change-item").trigger("click");
    expect(w.find(".file-change-diff").exists()).toBe(true);
    expect(w.text()).toContain("hello");
  });

  it("edit 显示 old→new 红绿对比", async () => {
    const w = mountCard([
      { filePath: "a.ts", toolName: "edit", oldString: "旧代码", newString: "新代码", status: "modified" },
    ]);
    await w.find(".file-change-item").trigger("click");
    expect(w.find(".file-change-old").text()).toContain("旧代码");
    expect(w.find(".file-change-new").text()).toContain("新代码");
  });

  it("write 文件不存在 → 状态升级 added", async () => {
    const w = mountCard([{ filePath: "new.txt", toolName: "write", newString: "x", status: "modified" }]);
    // onMounted 探测为 async，需 flush 全部 promise 链后状态才落定
    await flushPromises();
    expect(w.text()).toContain("added");
  });

  it("write 探测非 ENOENT 错误（如权限）→ 保持 modified", async () => {
    (readFileContent as any).mockRejectedValue(new Error("EACCES: permission denied"));
    const w = mountCard([{ filePath: "a.txt", toolName: "write", newString: "x", status: "modified" }]);
    await flushPromises();
    expect(w.text()).toContain("modified");
    expect(w.text()).not.toContain("added");
  });
});
