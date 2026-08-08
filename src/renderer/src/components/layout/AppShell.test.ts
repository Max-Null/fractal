// AppShell 工作区菜单聚合测试：打开菜单时从 serve 全量会话提取 directory（契约字段 cwd），与本地 recentWorkspaces 合并显示
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createI18n } from "vue-i18n";
import { createRouter, createMemoryHistory } from "vue-router";
import { useSettingsStore } from "@/stores/settings";
import AppShell from "./AppShell.vue";

// mock electron-bridge：保留原模块（store 链条其他函数有 catch 兜底），仅覆盖 listSessions 返回可控会话
// vi.hoisted：mock 工厂被提升到文件顶部，mock 变量必须同层提升否则工厂执行时尚未初始化
const { listSessionsMock, getEngineStatusMock, openWorkspaceWindowMock, onInitWorkspaceMock, revealInExplorerMock } = vi.hoisted(() => ({
  listSessionsMock: vi.fn(),
  getEngineStatusMock: vi.fn(),
  openWorkspaceWindowMock: vi.fn(),
  onInitWorkspaceMock: vi.fn(),
  revealInExplorerMock: vi.fn(),
}));
vi.mock("@/lib/electron-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/electron-bridge")>();
  return {
    ...actual,
    listSessions: listSessionsMock,
    getEngineStatus: getEngineStatusMock,
    openWorkspaceWindow: openWorkspaceWindowMock,
    onInitWorkspace: onInitWorkspaceMock,
    revealInExplorer: revealInExplorerMock,
  };
});

// ── 测试数据 ──
const LOCAL_A = "H:\\local\\proj-a";
const SERVE_A = "H:\\serve\\proj-a";
const SERVE_B = "H:\\serve\\proj-b";

// 构造带 cwd（serve directory 的前端契约字段）的 SessionData
function makeSession(id: string, cwd: string) {
  return {
    id,
    title: `会话-${id}`,
    cli_session_id: null,
    cwd,
    model: "",
    status: "idle",
    mode: "",
    created_at: "2026-01-01T00:00:00",
    updated_at: "2026-01-01T00:00:00",
    message_count: 0,
    total_tokens: null,
    total_cost: null,
  };
}

const i18n = createI18n({
  legacy: false,
  locale: "zh",
  messages: {
    zh: {
      app: { title: "分形" },
      chat: { loading: "加载中", engineNotReady: "引擎未就绪，可稍后重试" },
      header: {
        cwdTitle: "选择工作区",
        selectWorkspace: "选择工作区",
        recentWorkspaces: "最近工作区",
        noRecentWorkspaces: "暂无最近工作区",
        refreshHint: "正在重启引擎…",
        newSession: "新会话",
        lightMode: "亮色模式",
        darkMode: "暗色模式",
        refresh: "刷新引擎",
        settings: "设置",
        toggleSidebar: "切换侧边栏",
      },
      session: { new: "新建会话" },
      manage: { title: "管理" },
    },
  },
});

// 真实内存路由：useRouter/useRoute 依赖 routerKey symbol 注入（字符串 provide 不匹配），用真实 router 最稳
const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: "/:pathMatch(.*)*", component: { template: "<div />" } }],
});
let pinia: Pinia;

function mountAppShell(): VueWrapper {
  return mount(AppShell, {
    global: {
      plugins: [pinia, i18n, router],
      stubs: {
        SessionSidebar: true,
        FilePanel: true,
        FilePreviewPanel: true,
        CommandPalette: true,
        ManagePanel: true,
        ChangelogDialog: true,
        Onboarding: true,
        "router-view": true,
      },
    },
  });
}

/** 打开工作区菜单（等待 onMounted + loadServeWorkspaces 完成），返回菜单项路径列表 */
async function openMenuAndGetPaths(wrapper: VueWrapper): Promise<string[]> {
  await flushPromises(); // onMounted（initializing → false）
  await wrapper.find(".ws-pill-arrow").trigger("click");
  await flushPromises(); // loadServeWorkspaces 的 listSessions resolve
  return wrapper.findAll(".ws-menu-item-path").map((n) => n.text());
}

/** 直接读当前菜单路径（不 toggle：菜单已打开时用，避免二次点击关闭菜单） */
function getMenuPaths(wrapper: VueWrapper): string[] {
  return wrapper.findAll(".ws-menu-item-path").map((n) => n.text());
}

describe("AppShell 工作区菜单（本地 recent + serve 会话目录聚合）", () => {
  beforeEach(() => {
    localStorage.clear();
    // 跳过 Onboarding：标记已跳过，主界面直接渲染
    localStorage.setItem("sb-onboarding-dismissed", "1");
    // 预置本地最近工作区（菜单聚合的 local 部分）
    localStorage.setItem("sb-recent-workspaces", JSON.stringify([LOCAL_A]));
    pinia = createPinia();
    setActivePinia(pinia);
    listSessionsMock.mockReset();
    openWorkspaceWindowMock.mockReset();
    revealInExplorerMock.mockReset();
    onInitWorkspaceMock.mockReset(); // 不 reset 会导致 calls[0] 取到上个用例的旧回调（闭包旧 pinia 实例）
    // 引擎就绪门禁默认放行：getEngineStatus 首查立即返回 running（串行链等待逻辑见 waitEngineReady）
    getEngineStatusMock.mockReset();
    getEngineStatusMock.mockResolvedValue({ running: true });
    // 新窗口打开默认成功（.then 链依赖 Promise 形状；断言失败场景的用例单独 mockRejectedValue）
    openWorkspaceWindowMock.mockResolvedValue(undefined);
    // onInitWorkspace 在 AppShell onMounted 同步段注册监听，mock 返回取消函数（不重复注册计数）
    onInitWorkspaceMock.mockReset();
    onInitWorkspaceMock.mockReturnValue(() => {});
  });

  afterEach(() => {
    // 超时用例用 fake timers 推进 15s；断言失败也要恢复，避免遗留 fake timers 影响后续用例
    vi.useRealTimers();
  });

  it("打开菜单时聚合 serve 会话目录，补充本地 recent（local 在前，serve 按出现序）", async () => {
    listSessionsMock.mockResolvedValue([makeSession("s1", SERVE_A), makeSession("s2", SERVE_B)]);
    const wrapper = mountAppShell();

    expect(await openMenuAndGetPaths(wrapper)).toEqual([LOCAL_A, SERVE_A, SERVE_B]);
  });

  it("serve 目录与本地 recent 重复 → 合并去重（local 优先，不重复显示）", async () => {
    // serve 含 LOCAL_A 重复项 + 两个新目录
    listSessionsMock.mockResolvedValue([
      makeSession("s1", LOCAL_A),
      makeSession("s2", SERVE_A),
      makeSession("s3", SERVE_B),
    ]);
    const wrapper = mountAppShell();

    expect(await openMenuAndGetPaths(wrapper)).toEqual([LOCAL_A, SERVE_A, SERVE_B]);
  });

  it("serve 未就绪（listSessions reject）→ 菜单降级显示本地 recent，不崩溃", async () => {
    listSessionsMock.mockRejectedValue(new Error("engine not ready"));
    const wrapper = mountAppShell();

    expect(await openMenuAndGetPaths(wrapper)).toEqual([LOCAL_A]);
  });

  it("serve 目录含空 cwd（未绑定工作区）→ 过滤空值", async () => {
    listSessionsMock.mockResolvedValue([
      makeSession("s1", SERVE_A),
      makeSession("s2", ""),
      makeSession("s3", "  "),
    ]);
    const wrapper = mountAppShell();

    expect(await openMenuAndGetPaths(wrapper)).toEqual([LOCAL_A, SERVE_A]);
  });

  it("点击非当前工作区项（serve 聚合）→ 新开窗口（openWorkspaceWindow），当前窗口 cwd/recent 不变", async () => {
    listSessionsMock.mockResolvedValue([makeSession("s1", SERVE_A)]);
    const wrapper = mountAppShell();
    await openMenuAndGetPaths(wrapper);

    // 第二个菜单项 = serve 聚合项（第一个是本地 recent，均非当前 cwd）
    await wrapper.findAll(".ws-menu-item-path")[1].trigger("click");
    await flushPromises();

    // 交互模式变更（用户需求）：非当前项 → 新开窗口，不再当前窗口内切换
    expect(openWorkspaceWindowMock).toHaveBeenCalledWith(SERVE_A);
    const settings = useSettingsStore();
    expect(settings.cwd).not.toBe(SERVE_A);
    expect(settings.recentWorkspaces[0]).not.toBe(SERVE_A);
  });

  it("点击当前工作区项 → 提示「已在该工作区」，不开新窗口", async () => {
    // cwd 初始 = localStorage sb-current-workspace（initFromDb 在测试环境无 SQLite，不会覆盖）
    localStorage.setItem("sb-current-workspace", LOCAL_A);
    listSessionsMock.mockResolvedValue([]);
    const wrapper = mountAppShell();
    await openMenuAndGetPaths(wrapper);

    // 第一个菜单项 = LOCAL_A（当前 cwd）
    await wrapper.findAll(".ws-menu-item-path")[0].trigger("click");
    await flushPromises();

    expect(openWorkspaceWindowMock).not.toHaveBeenCalled();
    expect(wrapper.find(".ws-alert").text()).toBe("已在该工作区");
  });

  it("onInitWorkspace 收到工作区下发 → 切 cwd + 按新工作区加载会话（新窗口初始化链路）", async () => {
    listSessionsMock.mockResolvedValue([]);
    const wrapper = mountAppShell();
    await flushPromises();

    // onMounted 同步段注册监听：捕获回调并手动触发（模拟主进程 did-finish-load 下发 window:init-workspace）
    expect(onInitWorkspaceMock).toHaveBeenCalledTimes(1);
    const cb = onInitWorkspaceMock.mock.calls[0][0] as (path: string) => void;
    cb(SERVE_B);
    await flushPromises();

    const settings = useSettingsStore();
    expect(settings.cwd).toBe(SERVE_B);
    // loadSessions 两次：onMounted 初始一次 + init-workspace 一次——
    // 新实现全量拉取 + store 前端过滤（listSessions 不再传 directory，绕开 serve 实例化崩溃，2026-08-08）
    expect(listSessionsMock).toHaveBeenCalledTimes(2);
  });

  it("点 × 移除最近工作区 → 菜单立即消失（含 serve 聚合场景）且不触发新开窗口（click.stop）", async () => {
    // serve 聚合里有 SERVE_A；本地 recent 有 LOCAL_A——删除 LOCAL_A 后菜单不应再有它
    listSessionsMock.mockResolvedValue([makeSession("s1", SERVE_A), makeSession("s2", LOCAL_A)]);
    const wrapper = mountAppShell();
    await flushPromises();
    await wrapper.find(".ws-pill-arrow").trigger("click");
    await flushPromises();

    const settings = useSettingsStore();
    expect(settings.recentWorkspaces).toContain(LOCAL_A);
    expect(getMenuPaths(wrapper)).toContain(LOCAL_A);
    // 第 1 项的删除按钮（.ws-menu-item-act-danger）
    await wrapper.find(".ws-menu-item-act-danger").trigger("click");
    await flushPromises();

    expect(settings.recentWorkspaces).not.toContain(LOCAL_A);
    // 菜单不再显示 LOCAL_A（dismissed 过滤 serve 聚合）——serve 聚合的 SERVE_A 仍显示
    const paths = getMenuPaths(wrapper);
    expect(paths).not.toContain(LOCAL_A);
    expect(paths).toContain(SERVE_A);
    // click.stop：删除不触发路径点击（不新开窗口）
    expect(openWorkspaceWindowMock).not.toHaveBeenCalled();
    // dismissed 持久化（localStorage）——刷新后仍过滤
    expect(JSON.parse(localStorage.getItem("sb-dismissed-workspaces") || "[]")).toContain(LOCAL_A);
  });

  it("删除 serve 聚合项 → 菜单立即消失；重新打开该工作区（init-workspace 下发）→ 恢复显示（unDismiss）", async () => {
    listSessionsMock.mockResolvedValue([makeSession("s1", SERVE_A)]);
    const wrapper = mountAppShell();
    await flushPromises();
    // 点一次 arrow 打开菜单（openMenuAndGetPaths 内部会再点一次导致 toggle 关闭，故此处用裸点击）
    await wrapper.find(".ws-pill-arrow").trigger("click");
    await flushPromises();
    expect(getMenuPaths(wrapper)).toContain(SERVE_A);

    // 删除 serve 聚合项（SERVE_A）——菜单含 beforeEach 预设的 LOCAL_A，须定位 SERVE_A 那一项的删除按钮
    const wsItems = wrapper.findAll(".ws-menu-item");
    const serIdx = wsItems.findIndex((n) => n.text().includes(SERVE_A));
    await wsItems[serIdx].find(".ws-menu-item-act-danger").trigger("click");
    await flushPromises();
    expect(JSON.parse(localStorage.getItem("sb-dismissed-workspaces") || "[]")).toContain(SERVE_A);
    expect(getMenuPaths(wrapper)).not.toContain(SERVE_A);

    // 模拟用户重新打开该工作区（新窗口 init-workspace 下发）→ unDismiss 清除标记 → 菜单恢复显示
    const cb = onInitWorkspaceMock.mock.calls[0][0] as (path: string) => void;
    cb(SERVE_A);
    await flushPromises();
    expect(JSON.parse(localStorage.getItem("sb-dismissed-workspaces") || "[]")).not.toContain(SERVE_A);
    expect(getMenuPaths(wrapper)).toContain(SERVE_A);
  });

  it("点 📂 打开位置 → revealInExplorer 调用且不触发新开窗口（click.stop）", async () => {
    listSessionsMock.mockResolvedValue([]);
    revealInExplorerMock.mockResolvedValue(undefined);
    const wrapper = mountAppShell();
    await flushPromises();
    await wrapper.find(".ws-pill-arrow").trigger("click");
    await flushPromises();

    // 第 1 项的打开位置按钮（.ws-menu-item-actions 内第一个 act）
    await wrapper.find(".ws-menu-item-act").trigger("click");
    await flushPromises();

    expect(revealInExplorerMock).toHaveBeenCalledWith(LOCAL_A);
    expect(openWorkspaceWindowMock).not.toHaveBeenCalled();
  });

  it("引擎 15s 未就绪 → 超时降级进主界面（不卡死，且绝不发 session:list）", async () => {
    getEngineStatusMock.mockResolvedValue({ running: false });
    vi.useFakeTimers();
    const wrapper = mountAppShell();
    await vi.advanceTimersByTimeAsync(0); // 推进 initFromDb 微任务链 + waitEngineReady 首查

    // 首查 running=false → 转圈等待中（门禁未解除，主界面未渲染）
    expect(wrapper.find(".ws-pill-arrow").exists()).toBe(false);
    expect(wrapper.find(".boot-timeout").exists()).toBe(false);

    // 15s 超时 → waitEngineReady 返回 false → 跳过 loadSessions，展示「引擎未就绪」提示
    await vi.advanceTimersByTimeAsync(15_000);
    expect(wrapper.find(".boot-timeout").exists()).toBe(true);
    // 引擎未就绪期间绝不发 session:list（问题根因：serve 未就绪时并发请求会打崩 serve）
    expect(listSessionsMock).not.toHaveBeenCalled();

    // 提示停留 1s 后进主界面（离线态：列表空 + 引擎离线占位）
    await vi.advanceTimersByTimeAsync(1_000);
    expect(wrapper.find(".ws-pill-arrow").exists()).toBe(true);
    expect(wrapper.find(".boot-timeout").exists()).toBe(false);
  });
});
