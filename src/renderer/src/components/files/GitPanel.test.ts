import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";

// ── Mock 模块（hoisted，避免提升冲突）──
const {
  mockGitStatus, mockGitDiff, mockGitStage, mockGitUnstage, mockGitCommit, mockGitPush,
  mockEmitChatCommand, mockOpenGitDiff, mockCloseGitDiff,
} = vi.hoisted(() => ({
  mockGitStatus: vi.fn().mockResolvedValue({
    branch: "main",
    staged: [],
    modified: [{ path: "src/App.vue", status: "modified" }],
    untracked: [{ path: "new-file.ts", status: "untracked" }],
  }),
  mockGitDiff: vi.fn().mockResolvedValue("+added line\n-removed line"),
  mockGitStage: vi.fn().mockResolvedValue(undefined),
  mockGitUnstage: vi.fn().mockResolvedValue(undefined),
  mockGitCommit: vi.fn().mockResolvedValue("abc123def"),
  mockGitPush: vi.fn().mockResolvedValue(undefined),
  mockEmitChatCommand: vi.fn(),
  mockOpenGitDiff: vi.fn(),
  mockCloseGitDiff: vi.fn(),
}));

vi.mock("@/composables/useCommandPalette", () => ({
  emitChatCommand: mockEmitChatCommand,
}));

vi.mock("@/lib/electron-bridge", () => ({
  gitStatus: mockGitStatus,
  gitDiff: mockGitDiff,
  gitStage: mockGitStage,
  gitUnstage: mockGitUnstage,
  gitCommit: mockGitCommit,
  gitPush: mockGitPush,
}));

// ── i18n ──
const i18n = createI18n({
  legacy: false,
  locale: "zh",
  messages: {
    zh: {
      chat: { loading: "加载中..." },
      file: { refresh: "刷新" },
      git: {
        notRepo: "非 Git 仓库",
        clean: "工作区干净",
        diffError: "无法加载 diff",
        stageError: "Stage 失败",
        unstageError: "Unstage 失败",
        commitError: "提交失败",
        pushError: "推送失败",
        pushSuccess: "推送成功",
        pushing: "推送中...",
        commitPlaceholder: "Commit message...",
        staged: "已暂存",
        modified: "已修改",
        untracked: "未跟踪",
        commit: "提交",
        push: "推送",
        amend: "Amend",
        pushAfter: "提交后推送",
        stageTooltip: "Stage",
        unstageTooltip: "Unstage",
        closeDiff: "关闭 diff",
        initRepo: "初始化 Git",
        initRepoDesc: "让 CC 为工作空间建立 Git 版本控制",
      },
    },
  },
});

import GitPanel from "./GitPanel.vue";

function mountPanel(props?: { repoPath?: string }) {
  return mount(GitPanel, {
    props: { repoPath: props?.repoPath ?? "C:\\project" },
    global: {
      plugins: [i18n],
      provide: {
        openGitDiff: mockOpenGitDiff,
        closeGitDiff: mockCloseGitDiff,
      },
    },
  });
}

describe("GitPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── repoPath 变化 ──

  it("fetches status on mount", async () => {
    mountPanel();
    await new Promise(r => setTimeout(r, 10));
    expect(mockGitStatus).toHaveBeenCalledWith("C:\\project");
  });

  it("closes diff and clears error on repoPath change", async () => {
    const wrapper = mountPanel();
    await new Promise(r => setTimeout(r, 10));

    // 模拟有选中文件的状态
    const vm = wrapper.vm as any;
    vm.selectedFile = { path: "test.ts", status: "modified" };
    await wrapper.vm.$nextTick();

    await wrapper.setProps({ repoPath: "C:\\other" });
    await new Promise(r => setTimeout(r, 10));

    expect(mockCloseGitDiff).toHaveBeenCalled();
    expect(vm.errorMsg).toBe("");
  });

  // ── 非 Git 仓库 ──

  it("shows non-repo message and init button when status is null", async () => {
    mockGitStatus.mockRejectedValueOnce("not a repo");
    const wrapper = mountPanel();
    await new Promise(r => setTimeout(r, 10));
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("非 Git 仓库");
    expect(wrapper.find(".git-init-btn").exists()).toBe(true);
  });

  it("clicking init button emits git-init command", async () => {
    mockGitStatus.mockRejectedValueOnce("not a repo");
    const wrapper = mountPanel();
    await new Promise(r => setTimeout(r, 10));
    await wrapper.vm.$nextTick();

    await wrapper.find(".git-init-btn").trigger("click");
    expect(mockEmitChatCommand).toHaveBeenCalledWith("git-init");
  });

  // ── 状态显示 ──

  it("renders file sections with Chinese labels", async () => {
    const wrapper = mountPanel();
    await new Promise(r => setTimeout(r, 10));
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("已修改");
    expect(wrapper.text()).toContain("src/App.vue");
    expect(wrapper.text()).toContain("未跟踪");
    expect(wrapper.text()).toContain("new-file.ts");
  });

  it("shows clean message when no changes", async () => {
    mockGitStatus.mockResolvedValueOnce({
      branch: "main",
      staged: [],
      modified: [],
      untracked: [],
    });
    const wrapper = mountPanel();
    await new Promise(r => setTimeout(r, 10));
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("工作区干净");
  });

  // ── Diff 推送到第四列 ──

  it("clicking a file fetches diff and opens it in 4th column", async () => {
    const wrapper = mountPanel();
    await new Promise(r => setTimeout(r, 10));
    await wrapper.vm.$nextTick();

    const fileRow = wrapper.find(".git-file-row");
    await fileRow.trigger("click");
    await wrapper.vm.$nextTick();

    expect(mockGitDiff).toHaveBeenCalledWith("C:\\project", "src/App.vue", false);
    expect(mockOpenGitDiff).toHaveBeenCalledWith({
      path: "src/App.vue",
      diff: "+added line\n-removed line",
    });
  });

  it("opens diff with error message on failure", async () => {
    mockGitDiff.mockRejectedValueOnce("diff failed");
    const wrapper = mountPanel();
    await new Promise(r => setTimeout(r, 10));
    await wrapper.vm.$nextTick();

    const fileRow = wrapper.find(".git-file-row");
    await fileRow.trigger("click");
    await wrapper.vm.$nextTick();

    expect(mockOpenGitDiff).toHaveBeenCalledWith({
      path: "src/App.vue",
      diff: "无法加载 diff",
    });
  });

  // ── Stage / Unstage ──

  it("stage button calls gitStage and refreshes", async () => {
    const wrapper = mountPanel();
    await new Promise(r => setTimeout(r, 10));
    await wrapper.vm.$nextTick();

    const stageBtns = wrapper.findAll(".git-file-action");
    await stageBtns[0].trigger("click");
    await wrapper.vm.$nextTick();

    expect(mockGitStage).toHaveBeenCalledWith("C:\\project", ["src/App.vue"]);
  });

  it("shows error when stage fails", async () => {
    mockGitStage.mockRejectedValueOnce("stage error");
    const wrapper = mountPanel();
    await new Promise(r => setTimeout(r, 10));
    await wrapper.vm.$nextTick();

    const stageBtns = wrapper.findAll(".git-file-action");
    await stageBtns[0].trigger("click");
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("Stage 失败");
  });

  // ── Commit ──

  it("commit bar appears when staged files exist", async () => {
    mockGitStatus.mockResolvedValueOnce({
      branch: "main",
      staged: [{ path: "f.ts", status: "staged" }],
      modified: [],
      untracked: [],
    });
    const wrapper = mountPanel();
    await new Promise(r => setTimeout(r, 10));
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".git-commit-bar").exists()).toBe(true);
  });

  it("commit button disabled when message is empty", async () => {
    mockGitStatus.mockResolvedValueOnce({
      branch: "main",
      staged: [{ path: "f.ts", status: "staged" }],
      modified: [],
      untracked: [],
    });
    const wrapper = mountPanel();
    await new Promise(r => setTimeout(r, 10));
    await wrapper.vm.$nextTick();

    const commitBtn = wrapper.find(".git-commit-btn");
    expect(commitBtn.attributes("disabled")).toBeDefined();
  });
});
