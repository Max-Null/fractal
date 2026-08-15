// ContextUsageModal 测试：ACP 数据展示（压缩块列表/分类/解压）/ 无 ACP 数据回退估算
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createI18n } from "vue-i18n";
import { nextTick } from "vue";
import ContextUsageModal from "./ContextUsageModal.vue";
import { useSessionStore } from "@/stores/session";

// mock acp-bridge：可编程返回 ACP 状态 / 解压结果
const { getAcpStateMock, decompressMock } = vi.hoisted(() => ({
  getAcpStateMock: vi.fn(),
  decompressMock: vi.fn(),
}));
vi.mock("@/lib/acp-bridge", () => ({
  getAcpSessionState: (...args: unknown[]) => getAcpStateMock(...args),
  decompressAcpBlock: (...args: unknown[]) => decompressMock(...args),
}));
vi.mock("@/components/shared/ModalShell.vue", () => ({
  default: {
    name: "ModalShell",
    props: ["open", "size"],
    emits: ["close"],
    template: `
      <div v-if="open" class="modal-shell-mock">
        <div class="modal-header"><slot name="header" /></div>
        <div class="modal-body"><slot /></div>
        <div class="modal-footer"><slot name="footer" /></div>
      </div>`,
  },
}));

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      contextUsage: {
        title: "Context Usage",
        category: "Category",
        tokens: "Tokens",
        usage: "Usage",
        freeSpace: "Free Space",
        systemPrompt: "System Prompt",
        systemTools: "System Tools",
        mcpTools: "MCP Tools",
        customAgents: "Custom Agents",
        memoryFiles: "Memory Files",
        skills: "Skills",
        messages: "Messages",
        user: "User",
        assistant: "Assistant",
        tool: "Tools",
        system: "System",
        note: "note-fallback",
        noteAcp: "note-acp",
        acpBlocks: "ACP Blocks",
        acpNoBlocks: "No compressed blocks yet",
        acpInactive: "Inactive",
        acpSaved: "{n} tokens saved in total",
        decompress: "Decompress",
        decompressing: "Decompressing…",
        decompressSubmitted: "submitted-notice",
        compact: "Compact Context",
      },
      settings: { model: "Model" },
    },
  },
});

const acpSample = {
  detected: true,
  blocks: [
    { blockId: 1, topic: "旧块", compressedTokens: 18000, summaryTokens: 1200, tier: 1, active: true, startId: "m00001", endId: "m00100", createdAt: "2026-08-14T10:00:00.000Z", summaryPreview: "短摘要" },
    { blockId: 2, topic: "新块", compressedTokens: 9000, summaryTokens: 800, tier: 2, active: false, startId: "m00101", endId: "m00200", createdAt: "2026-08-15T10:00:00.000Z", summaryPreview: "x".repeat(200) },
  ],
  categories: [
    { role: "user", tokens: 3200 },
    { role: "assistant", tokens: 15000 },
    { role: "system", tokens: 700 },
  ],
  totalPruneTokens: 3054778,
  modelContextLimit: 1000000,
};

function mountModal() {
  return mount(ContextUsageModal, {
    props: { open: true },
    global: { plugins: [pinia, i18n] },
  });
}

let pinia: Pinia;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  getAcpStateMock.mockReset();
  decompressMock.mockReset();
  getAcpStateMock.mockResolvedValue(acpSample);
  decompressMock.mockResolvedValue({ ok: true });
});

describe("ACP 数据加载", () => {
  it("open 时拉取当前会话 ACP 状态并渲染压缩块列表", async () => {
    const store = useSessionStore();
    store.setActiveSession("ses_1");
    const wrapper = mountModal();
    await flushPromises();
    expect(getAcpStateMock).toHaveBeenCalledWith("ses_1");
    // 压缩块列表：2 个块 + Tier 徽标 + 解压按钮
    expect(wrapper.text()).toContain("ACP Blocks");
    expect(wrapper.text()).toContain("旧块");
    expect(wrapper.text()).toContain("新块");
    expect(wrapper.text()).toContain("T1");
    expect(wrapper.text()).toContain("T2");
    expect(wrapper.text()).toContain("Inactive");
    expect(wrapper.findAll("button").some((b) => b.text() === "Decompress")).toBe(true);
  });

  it("无会话时清空 ACP 状态，不调用桥", async () => {
    mountModal();
    await flushPromises();
    expect(getAcpStateMock).not.toHaveBeenCalled();
  });
});

describe("分类展示", () => {
  it("ACP 检测到时使用真实分类，system 标注估算星号", async () => {
    const store = useSessionStore();
    store.setActiveSession("ses_1");
    const wrapper = mountModal();
    await flushPromises();
    expect(wrapper.text()).toContain("Category");
    // 真实分类行（user/assistant/system）+ system 估算星号
    const rows = wrapper.findAll("table tbody tr");
    expect(rows).toHaveLength(3);
    expect(wrapper.html()).toContain(">*</span>");
  });

  it("无 ACP 数据时回退固定开销估算行", async () => {
    getAcpStateMock.mockResolvedValue({ detected: false, blocks: [], categories: [] });
    const store = useSessionStore();
    store.setActiveSession("ses_1");
    const wrapper = mountModal();
    await flushPromises();
    // 回退 rows：7 行（6 固定开销 + messages）
    const rows = wrapper.findAll("table tbody tr");
    expect(rows).toHaveLength(7);
    expect(wrapper.text()).toContain("note-fallback");
  });
});

describe("解压操作", () => {
  it("点击解压调用桥并显示已提交提示（不立即刷新，模型异步执行）", async () => {
    const store = useSessionStore();
    store.setActiveSession("ses_1");
    const wrapper = mountModal();
    await flushPromises();
    getAcpStateMock.mockClear();
    const decompressBtn = wrapper.findAll("button").find((b) => b.text() === "Decompress");
    expect(decompressBtn).toBeTruthy();
    await decompressBtn!.trigger("click");
    await flushPromises();
    expect(decompressMock).toHaveBeenCalledWith("ses_1", 1);
    // 已提交提示而非断言成功；不重新拉取（模型执行完由会话事件驱动刷新）
    expect(wrapper.text()).toContain("submitted-notice");
    expect(getAcpStateMock).not.toHaveBeenCalled();
  });

  it("解压失败显示错误提示", async () => {
    const store = useSessionStore();
    store.setActiveSession("ses_1");
    const wrapper = mountModal();
    await flushPromises();
    decompressMock.mockRejectedValue(new Error("block not found"));
    const decompressBtn = wrapper.findAll("button").find((b) => b.text() === "Decompress");
    await decompressBtn!.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("block not found");
  });

  it("解压中按钮禁用（loading 态防重复提交）", async () => {
    const store = useSessionStore();
    store.setActiveSession("ses_1");
    const wrapper = mountModal();
    await flushPromises();
    // 挂起解压 Promise：点击后未 resolve，按钮应显示解压中且禁用
    let resolveDecompress!: (v: { ok: boolean }) => void;
    decompressMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDecompress = resolve;
        }),
    );
    const decompressBtn = wrapper.findAll("button").find((b) => b.text() === "Decompress");
    await decompressBtn!.trigger("click");
    await nextTick();
    const loadingBtn = wrapper.findAll("button").find((b) => b.text() === "Decompressing…");
    expect(loadingBtn).toBeTruthy();
    expect(loadingBtn!.attributes("disabled")).toBeDefined();
    // 两个块按钮都禁用（同一时刻仅一个解压中）
    const otherBtn = wrapper.findAll("button").find((b) => b.text() === "Decompress");
    expect(otherBtn!.attributes("disabled")).toBeDefined();
    resolveDecompress({ ok: true });
    await flushPromises();
  });
});

describe("竞态守卫", () => {
  it("快速切会话时旧响应不覆盖新会话数据", async () => {
    const store = useSessionStore();
    store.setActiveSession("ses_1");
    const wrapper = mountModal();
    await flushPromises();

    // 构造乱序：ses_2 先返回、ses_1 后返回——最终展示 ses_2 数据（最新序号）
    getAcpStateMock.mockClear();
    const resolvers: Array<(v: unknown) => void> = [];
    getAcpStateMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    store.setActiveSession("ses_2"); // 触发第一次拉取（挂起）
    await nextTick();
    store.setActiveSession("ses_3"); // 触发第二次拉取（挂起）
    await nextTick();
    // 旧请求（ses_2）晚返回——应被丢弃
    resolvers[0]({ detected: true, blocks: [{ blockId: 2, topic: "旧", compressedTokens: 1, summaryTokens: 1, tier: 1, active: true, startId: "m1", endId: "m2", createdAt: "2026-08-14T00:00:00.000Z", summaryPreview: "" }], categories: [], totalPruneTokens: 0, modelContextLimit: 1000000 });
    await flushPromises();
    // 新请求（ses_3）尚未返回，此时仍显示加载后空态（旧数据被丢弃不闪回）
    expect(getAcpStateMock).toHaveBeenCalledTimes(2);
    resolvers[1]({ detected: true, blocks: [{ blockId: 3, topic: "新", compressedTokens: 1, summaryTokens: 1, tier: 1, active: true, startId: "m3", endId: "m4", createdAt: "2026-08-15T00:00:00.000Z", summaryPreview: "" }], categories: [], totalPruneTokens: 0, modelContextLimit: 1000000 });
    await flushPromises();
    expect(wrapper.text()).toContain("新");
    expect(wrapper.text()).not.toContain("旧");
  });
});
