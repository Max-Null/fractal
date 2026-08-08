// SubTaskCard 三态渲染测试：运行中（耗时 + 动态行）/ 已完成（摘要 + 展开收起）/ 点击分流（monitor/expand/detail）
// + summaryLoader 懒加载（历史场景：summary 空 + 展开时拉取子会话摘要）
// 注意：trigger 须作用于 find('.subtask-card') 子元素（wrapper 根触发在 jsdom 不可靠，已实测）
import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import SubTaskCard from "./SubTaskCard.vue";
import type { SubTask } from "@/stores/chat";

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: { chat: { subTaskDetail: "View session" } },
  },
});

function makeSubTask(overrides: Partial<SubTask> = {}): SubTask {
  return {
    id: "sub-1",
    agent: "工匠",
    status: "running",
    deltaText: "",
    parts: [],
    startedAt: Date.now() - 3000, // 3 秒前开始
    ...overrides,
  };
}

function mountCard(
  subtask: SubTask,
  expanded = false,
  summaryLoader?: (subId: string) => Promise<string | undefined>
) {
  return mount(SubTaskCard, {
    props: { subtask, expanded, summaryLoader },
    global: { plugins: [i18n] },
  });
}

describe("SubTaskCard", () => {
  it("运行中：显示徽标 + agent 名 + 运行中耗时 + 动态行（deltaText 尾部）", () => {
    const wrapper = mountCard(makeSubTask({ deltaText: "正在分析代码结构" }));
    expect(wrapper.text()).toContain("👷");
    expect(wrapper.text()).toContain("工匠");
    expect(wrapper.text()).toContain("🔄 运行中 · 3s");
    expect(wrapper.text()).toContain("正在分析代码结构");
  });

  it("运行中：deltaText 超长截断尾部 120 字符", () => {
    const long = "x".repeat(200);
    const wrapper = mountCard(makeSubTask({ deltaText: long }));
    expect(wrapper.text()).toContain(long.slice(-120));
  });

  it("已完成：显示徽标 + agent 名 + 已完成耗时 + summary 前 3 行", () => {
    const summary = "第一行\n第二行\n第三行\n第四行";
    const wrapper = mountCard(
      makeSubTask({ status: "done", endedAt: Date.now(), summary })
    );
    expect(wrapper.text()).toContain("✅ 已完成 · 3s");
    expect(wrapper.text()).toContain("第一行");
    expect(wrapper.text()).toContain("第三行");
    expect(wrapper.text()).not.toContain("第四行");
  });

  it("运行中点击 → emit monitor（打开实时监视弹窗）", async () => {
    const wrapper = mountCard(makeSubTask());
    await wrapper.find(".subtask-card").trigger("click");
    expect(wrapper.emitted("monitor")).toBeTruthy();
    expect(wrapper.emitted("expand")).toBeFalsy();
  });

  it("已完成点击 → emit expand（行内展开摘要），不 emit monitor", async () => {
    const wrapper = mountCard(makeSubTask({ status: "done", endedAt: Date.now(), summary: "摘要" }));
    await wrapper.find(".subtask-card").trigger("click");
    expect(wrapper.emitted("expand")).toBeTruthy();
    expect(wrapper.emitted("monitor")).toBeFalsy();
  });

  it("点击「查看会话详情」按钮 → emit detail（@click.stop 不触发 expand）", async () => {
    const wrapper = mountCard(makeSubTask({ status: "done", endedAt: Date.now(), summary: "摘要" }));
    const btn = wrapper.find(".subtask-detail-btn");
    await btn.trigger("click");
    expect(wrapper.emitted("detail")).toBeTruthy();
    expect(wrapper.emitted("expand")).toBeFalsy();
  });

  it("展开态显示 summary 全文（不受前 3 行限制）", () => {
    const summary = "第一行\n第二行\n第三行\n第四行\n第五行";
    const wrapper = mountCard(makeSubTask({ status: "done", endedAt: Date.now(), summary }), true);
    expect(wrapper.text()).toContain("第五行");
  });

  it("agent 名映射徽标：工匠👷 军师🧭 侦查兵🕵️ 制图师🎨 其他🤖", () => {
    const cases: Array<[string, string]> = [
      ["工匠", "👷"],
      ["军师", "🧭"],
      ["参谋", "🧭"],
      ["侦查兵", "🕵️"],
      ["制图师", "🎨"],
      ["未知角色", "🤖"],
    ];
    for (const [agent, badge] of cases) {
      const wrapper = mountCard(makeSubTask({ agent }));
      expect(wrapper.text()).toContain(badge);
    }
  });

  it("运行中不显示「查看会话详情」按钮（军师 #8：原型对照表运行中无按钮）", () => {
    const wrapper = mountCard(makeSubTask({ status: "running", deltaText: "进行中" }));
    expect(wrapper.find(".subtask-detail-btn").exists()).toBe(false);
  });

  it("failed：显示 ❌ 失败 + 不显示详情按钮 + 不显示摘要（军师 #5/#8）", () => {
    const wrapper = mountCard(
      makeSubTask({ status: "done", failed: true, endedAt: Date.now(), summary: "不应显示" })
    );
    expect(wrapper.text()).toContain("❌ 失败");
    expect(wrapper.find(".subtask-detail-btn").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("不应显示");
  });

  it("stale：显示「状态未知 · 会话已切换」灰显 + 点击不 emit（军师 #4）", async () => {
    const wrapper = mountCard(
      makeSubTask({ status: "running", stale: true, deltaText: "切走前进度" })
    );
    expect(wrapper.text()).toContain("⚠️ 状态未知");
    expect(wrapper.text()).toContain("会话已切换");
    // 降级态不显示动态行内容
    expect(wrapper.text()).not.toContain("切走前进度");
    await wrapper.find(".subtask-card").trigger("click");
    expect(wrapper.emitted("monitor")).toBeFalsy();
    expect(wrapper.emitted("expand")).toBeFalsy();
  });

  it("summaryFailed：显示「（摘要获取失败）」（军师 #9）", () => {
    const wrapper = mountCard(
      makeSubTask({ status: "done", endedAt: Date.now(), summaryFailed: true })
    );
    expect(wrapper.text()).toContain("（摘要获取失败）");
  });

  it("无 summary 且未失败：显示「（无摘要）」（军师 #9）", () => {
    const wrapper = mountCard(
      makeSubTask({ status: "done", endedAt: Date.now(), summaryFailed: false })
    );
    expect(wrapper.text()).toContain("（无摘要）");
  });

  // ── summaryLoader 懒加载（历史场景 D1-D6：已完成子会话摘要为空，展开时拉取）──

  it("历史场景（summary 空 + loader）：展开时调用 loader（subId 参数），resolve 后显示结果", async () => {
    const loader = vi.fn().mockResolvedValue("子会话最终产出文本");
    const wrapper = mountCard(makeSubTask({ status: "done", endedAt: Date.now(), summary: "" }), true, loader);
    expect(loader).toHaveBeenCalledWith("sub-1");
    await flushPromises();
    expect(wrapper.text()).toContain("子会话最终产出文本");
  });

  it("loader pending 期间显示「正在加载结果…」", async () => {
    let resolveFn!: (v: string | undefined) => void;
    const loader = vi.fn().mockReturnValue(
      new Promise<string | undefined>((res) => { resolveFn = res; })
    );
    const wrapper = mountCard(makeSubTask({ status: "done", endedAt: Date.now(), summary: "" }), true, loader);
    expect(wrapper.text()).toContain("正在加载结果…");
    resolveFn("结果");
    await flushPromises();
    expect(wrapper.text()).toContain("结果");
  });

  it("loader 返回 undefined（无 assistant 产出）：显示「（无摘要）」", async () => {
    const loader = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountCard(makeSubTask({ status: "done", endedAt: Date.now(), summary: "" }), true, loader);
    await flushPromises();
    expect(wrapper.text()).toContain("（无摘要）");
  });

  it("loader 抛异常：显示「（摘要获取失败）」", async () => {
    const loader = vi.fn().mockRejectedValue(new Error("boom"));
    const wrapper = mountCard(makeSubTask({ status: "done", endedAt: Date.now(), summary: "" }), true, loader);
    await flushPromises();
    expect(wrapper.text()).toContain("（摘要获取失败）");
  });

  it("未展开 + summary 空 + loader：预览显「点击查看子任务结果…」，不调 loader", () => {
    const loader = vi.fn();
    const wrapper = mountCard(makeSubTask({ status: "done", endedAt: Date.now(), summary: "" }), false, loader);
    expect(wrapper.text()).toContain("点击查看子任务结果…");
    expect(loader).not.toHaveBeenCalled();
  });

  it("已展开 + summary 已有 + loader：summary 优先，不重复拉取", async () => {
    const loader = vi.fn();
    const wrapper = mountCard(makeSubTask({ status: "done", endedAt: Date.now(), summary: "已有摘要" }), true, loader);
    await flushPromises();
    expect(loader).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("已有摘要");
  });

  it("实时场景不传 loader：summary 有值展开直接显示全文（向后兼容）", async () => {
    const wrapper = mountCard(makeSubTask({ status: "done", endedAt: Date.now(), summary: "实时摘要全文" }), true);
    expect(wrapper.text()).toContain("实时摘要全文");
  });
});
