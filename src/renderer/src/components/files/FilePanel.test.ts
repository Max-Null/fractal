import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { PANEL_LAYOUT_KEY, type PanelLayout } from "@/composables/usePanelLayout";

// ── Mock tauri-bridge ──
const { mockListDir, mockReadFileContent, mockGetWorkspaceRoot } = vi.hoisted(() => ({
  mockListDir: vi.fn().mockResolvedValue([]),
  mockReadFileContent: vi.fn().mockResolvedValue("file content"),
  mockGetWorkspaceRoot: vi.fn().mockResolvedValue("C:\\project"),
}));

vi.mock("@/lib/electron-bridge", () => ({
  listDir: mockListDir,
  readFileContent: mockReadFileContent,
  getWorkspaceRoot: mockGetWorkspaceRoot,
}));

// ── Mock translateError ──
vi.mock("@/lib/utils", () => ({
  translateError: (e: unknown) => ({ key: "error", params: { message: String(e) } }),
}));

// ── Mock settings store（工作区切换 watch 使用）──
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({ cwd: ref("C:\\project") }),
}));

// ── i18n ──
const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      file: {
        title: "Files",
        backToRoot: "Back to Root",
        openPreview: "Open Preview",
        closePreview: "Close Preview",
        refresh: "Refresh",
      },
    },
  },
});

import FilePanel from "./FilePanel.vue";

// 简易 stub
function stub(name: string, template = "<div></div>") {
  return { name, template, props: {} as Record<string, unknown> };
}

// pony: <script setup> 内部变量无法被 vue-tsc 推断到 wrapper.vm 类型上，mount 时一并返回 any 类型的 vm
/** openFileInPanel mock，供测试验证调用参数 */
const mockOpenInPanel = vi.fn();

function mountPanel() {
  const mockLayout: PanelLayout = {
    previewWidth: ref(350),
    filesWidth: ref(280),
    previewDragging: ref(false),
    filesDragging: ref(false),
    startResize: vi.fn(),
    setupObserver: vi.fn(),
  };
  const wrapper = mount(FilePanel, {
    global: {
      plugins: [i18n],
      provide: {
        openFileInPanel: mockOpenInPanel,
        [PANEL_LAYOUT_KEY as symbol]: mockLayout,
      },
      stubs: {
        ErrorBoundary: stub("ErrorBoundary", "<div><slot /></div>"),
        FileTree: stub("FileTree"),
        FilePreview: stub("FilePreview"),
        GitPanel: stub("GitPanel"),
        MemoryPanel: stub("MemoryPanel"),
        StatusPanel: stub("StatusPanel"),
        PlansPanel: stub("PlansPanel"),
        CapabilitiesPanel: stub("CapabilitiesPanel"),
      },
    },
  });
  mockOpenInPanel.mockClear();
  return { wrapper, vm: wrapper.vm as any };
}

describe("FilePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── openFile：路径存储 ──

  it("openFile stores filename and full path for root-level file", async () => {
    const { wrapper, vm } = mountPanel();
    await wrapper.vm.$nextTick();

    await vm.openFile({ name: "README.md", path: "C:\\project\\README.md", is_dir: false, size: 1024 });

    expect(vm.selectedFile).toBe("README.md");
    expect(vm.selectedFilePath).toBe("C:\\project\\README.md");
    expect(mockReadFileContent).toHaveBeenCalledWith("C:\\project\\README.md");
  });

  it("openFile stores full path including subdirectories for nested file", async () => {
    const { wrapper, vm } = mountPanel();
    await wrapper.vm.$nextTick();

    await vm.openFile({
      name: "ChatPanel.vue",
      path: "C:\\project\\src\\components\\ChatPanel.vue",
      is_dir: false,
      size: 5000,
    });

    expect(vm.selectedFile).toBe("ChatPanel.vue");
    expect(vm.selectedFilePath).toBe("C:\\project\\src\\components\\ChatPanel.vue");
  });

  it("openFile navigates to directory instead of previewing", async () => {
    const { wrapper, vm } = mountPanel();
    await wrapper.vm.$nextTick();

    await vm.openFile({ name: "src", path: "C:\\project\\src", is_dir: true, size: 0 });

    // 目录不设 selectedFile
    expect(vm.selectedFile).toBeNull();
    expect(vm.selectedFilePath).toBe("");
    expect(mockReadFileContent).not.toHaveBeenCalled();
    // 导航到目录
    expect(mockListDir).toHaveBeenCalledWith("C:\\project\\src");
  });

  it("openFile shows error message when readFileContent fails", async () => {
    mockReadFileContent.mockRejectedValueOnce("Permission denied");
    const { wrapper, vm } = mountPanel();
    await wrapper.vm.$nextTick();

    await vm.openFile({ name: "secret.txt", path: "C:\\project\\secret.txt", is_dir: false, size: 0 });

    // 即使读取失败，路径仍正确存储
    expect(vm.selectedFile).toBe("secret.txt");
    expect(vm.selectedFilePath).toBe("C:\\project\\secret.txt");
    expect(vm.previewContent).not.toBe("file content");
    expect(vm.previewContent).not.toBe("");
  });

  // ── openModalPreview：使用完整路径 ──

  it("openModalPreview opens file in 4th column panel", () => {
    const { wrapper, vm } = mountPanel();

    vm.selectedFile = "App.vue";
    vm.selectedFilePath = "C:\\project\\src\\App.vue";
    vm.openModalPreview();

    expect(mockOpenInPanel).toHaveBeenCalledWith({
      name: "App.vue",
      path: "C:\\project\\src\\App.vue",
    });
  });

  it("openModalPreview preserves deep path through subdirectories", () => {
    const { wrapper, vm } = mountPanel();

    vm.selectedFile = "index.ts";
    vm.selectedFilePath = "C:\\project\\src\\composables\\useStreamProcessor.ts";
    vm.openModalPreview();

    expect(mockOpenInPanel).toHaveBeenCalledWith({
      name: "index.ts",
      path: "C:\\project\\src\\composables\\useStreamProcessor.ts",
    });
  });

  it("openModalPreview does nothing when selectedFile is null", () => {
    const { wrapper, vm } = mountPanel();

    vm.selectedFile = null;
    vm.selectedFilePath = "";
    vm.openModalPreview();

    expect(mockOpenInPanel).not.toHaveBeenCalled();
  });

  it("openModalPreview does nothing when selectedFilePath is empty", () => {
    const { wrapper, vm } = mountPanel();

    vm.selectedFile = "orphan.txt";
    vm.selectedFilePath = "";
    vm.openModalPreview();

    expect(mockOpenInPanel).not.toHaveBeenCalled();
  });

  // ── 关闭预览清理状态 ──

  it("close button clears selectedFile, selectedFilePath, previewContent", async () => {
    const { wrapper, vm } = mountPanel();
    await wrapper.vm.$nextTick();

    // 展开面板才能渲染 inline preview 区域（collapsed 初始为 true）
    vm.collapsed = false;

    // 通过 openFile 设置预览状态
    await vm.openFile({ name: "test.ts", path: "C:\\project\\test.ts", is_dir: false, size: 100 });
    await wrapper.vm.$nextTick();

    expect(vm.selectedFile).toBe("test.ts");
    expect(vm.selectedFilePath).toBe("C:\\project\\test.ts");
    expect(vm.previewContent).toBeTruthy();

    // 点击关闭按钮（模板 inline preview 的 ×）
    const closeBtn = wrapper.find("button[title='Close Preview']");
    expect(closeBtn.exists()).toBe(true);
    await closeBtn.trigger("click");

    expect(vm.selectedFile).toBeNull();
    expect(vm.selectedFilePath).toBe("");
    expect(vm.previewContent).toBe("");
  });

  // ── 面包屑 ──

  it("pathSegments splits root path into clickable segments", async () => {
    const { wrapper, vm } = mountPanel();
    await wrapper.vm.$nextTick();

    vm.rootPath = "C:\\project\\src\\components";
    await wrapper.vm.$nextTick();

    const segments = vm.pathSegments;
    expect(segments).toHaveLength(4);
    expect(segments[0]).toEqual({ label: "C:", fullPath: "C:\\" });
    expect(segments[1]).toEqual({ label: "project", fullPath: "C:\\project" });
    expect(segments[2]).toEqual({ label: "src", fullPath: "C:\\project\\src" });
    expect(segments[3]).toEqual({ label: "components", fullPath: "C:\\project\\src\\components" });
  });

  // ── 外层增强面板 Tabs（文件/记忆/状态/计划/生态）──

  /** 展开面板并点击指定外层 tab（区分内层 文件/Git 子 tab） */
  async function clickPanelTab(wrapper: any, label: string) {
    const btn = wrapper.findAll("button.panel-tab").find((b: any) => b.text().includes(label));
    expect(btn).toBeTruthy();
    await btn.trigger("click");
    await wrapper.vm.$nextTick();
    return btn;
  }

  it("renders 5 outer panel tabs (files/memory/status/plans/ecosystem)", async () => {
    const { wrapper, vm } = mountPanel();
    await wrapper.vm.$nextTick();
    vm.collapsed = false;
    await wrapper.vm.$nextTick();

    const labels = wrapper.findAll("button.panel-tab").map((b: any) => b.text());
    expect(labels).toHaveLength(5);
    expect(labels[0]).toContain("文件");
    expect(labels[1]).toContain("记忆");
    expect(labels[2]).toContain("状态");
    expect(labels[3]).toContain("计划");
    expect(labels[4]).toContain("生态");
  });

  it("shows file tree by default and hides it after switching to memory tab", async () => {
    const { wrapper, vm } = mountPanel();
    await wrapper.vm.$nextTick();
    vm.collapsed = false;
    await wrapper.vm.$nextTick();

    // 默认文件 tab：文件树可见，骨架面板不可见
    expect(wrapper.findComponent({ name: "FileTree" }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: "MemoryPanel" }).exists()).toBe(false);

    await clickPanelTab(wrapper, "记忆");

    // 切到记忆 tab：骨架面板可见，文件树隐藏
    expect(wrapper.findComponent({ name: "MemoryPanel" }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: "FileTree" }).exists()).toBe(false);
  });

  it("switches to status/plans/ecosystem tabs and back to files", async () => {
    const { wrapper, vm } = mountPanel();
    await wrapper.vm.$nextTick();
    vm.collapsed = false;
    await wrapper.vm.$nextTick();

    await clickPanelTab(wrapper, "状态");
    expect(wrapper.findComponent({ name: "StatusPanel" }).exists()).toBe(true);

    await clickPanelTab(wrapper, "计划");
    expect(wrapper.findComponent({ name: "PlansPanel" }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: "StatusPanel" }).exists()).toBe(false);

    await clickPanelTab(wrapper, "生态");
    expect(wrapper.findComponent({ name: "CapabilitiesPanel" }).exists()).toBe(true);

    // 切回文件 tab：文件树恢复渲染
    await clickPanelTab(wrapper, "文件");
    expect(wrapper.findComponent({ name: "FileTree" }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: "CapabilitiesPanel" }).exists()).toBe(false);
  });

  it("file tab keeps inner files/git sub-tabs working", async () => {
    const { wrapper, vm } = mountPanel();
    await wrapper.vm.$nextTick();
    vm.collapsed = false;
    await wrapper.vm.$nextTick();

    // 外层仍在文件 tab 时，切换内层 Git 子 tab
    const gitTab = wrapper.findAll("button.file-panel-tab-btn").find((b: any) => b.text().includes("Git"));
    expect(gitTab).toBeTruthy();
    await gitTab!.trigger("click");
    await wrapper.vm.$nextTick();

    expect(vm.fileTab).toBe("git");
    expect(wrapper.findComponent({ name: "GitPanel" }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: "FileTree" }).exists()).toBe(false);

    // 切回文件子 tab
    const filesTab = wrapper.findAll("button.file-panel-tab-btn").find((b: any) => b.text().includes("Files"));
    expect(filesTab).toBeTruthy();
    await filesTab!.trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent({ name: "FileTree" }).exists()).toBe(true);
  });
});
