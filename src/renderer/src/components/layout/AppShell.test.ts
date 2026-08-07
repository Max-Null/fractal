// AppShell 工作区菜单聚合测试：打开菜单时从 serve 全量会话提取 directory（契约字段 cwd），与本地 recentWorkspaces 合并显示
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createI18n } from "vue-i18n";
import { createRouter, createMemoryHistory } from "vue-router";
import { useSettingsStore } from "@/stores/settings";
import AppShell from "./AppShell.vue";

// mock electron-bridge：保留原模块（store 链条其他函数有 catch 兜底），仅覆盖 listSessions 返回可控会话
// vi.hoisted：mock 工厂被提升到文件顶部，mock 变量必须同层提升否则工厂执行时尚未初始化
const { listSessionsMock } = vi.hoisted(() => ({ listSessionsMock: vi.fn() }));
vi.mock("@/lib/electron-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/electron-bridge")>();
  return { ...actual, listSessions: listSessionsMock };
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
      chat: { loading: "加载中" },
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

  it("点击 serve 聚合目录项 → 切换工作区（settings.cwd 更新 + recentWorkspaces 头部）", async () => {
    listSessionsMock.mockResolvedValue([makeSession("s1", SERVE_A)]);
    const wrapper = mountAppShell();
    await openMenuAndGetPaths(wrapper);

    // 第二个菜单项 = serve 聚合项（第一个是本地 recent）
    await wrapper.findAll(".ws-menu-item")[1].trigger("click");
    await flushPromises();

    const settings = useSettingsStore();
    expect(settings.cwd).toBe(SERVE_A);
    expect(settings.recentWorkspaces[0]).toBe(SERVE_A);
  });
});
