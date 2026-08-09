// NodeCard 测试：6 变体（thinking/text/tool/todo/subtask/summary）+ 展开收起 + D8 两态 + 梗概 + 无展开 todo
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import NodeCard from "./NodeCard.vue";
import type { TimelineNode } from "@/lib/node-timeline";
import type { SubTask } from "@/stores/chat";

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      chat: {
        thinkingDone: "Thinking",
        timelineSummary: "Summary",
        todoUpdate: "Update todos",
        todoDone: "Todos done",
        todoRecord: "Todos",
        todoRecordDone: "done",
        subTaskUnavailable: "Subtask details unavailable",
        subTaskStarting: "Starting subagent",
        toolInput: "Input",
        toolOutput: "Output",
        toolError: "Execution error",
      },
    },
  },
});

// SubTaskCard / MarkdownRenderer stub：只验证 NodeCard 的 props 传递与变体切换
const stubs = {
  SubTaskCard: {
    name: "SubTaskCard",
    props: ["subtask", "expanded"],
    template: '<div class="subtask-stub">{{ subtask.id }}</div>',
  },
  MarkdownRenderer: {
    props: ["content"],
    template: '<div class="md-stub">{{ content }}</div>',
  },
};

function node(overrides: Partial<TimelineNode> & { kind: TimelineNode["kind"] }): TimelineNode {
  return {
    key: "n1",
    ...overrides,
  };
}

function subTask(id = "ses_1"): SubTask {
  return {
    id,
    agent: "工匠",
    status: "done",
    deltaText: "",
    parts: [],
    startedAt: Date.now() - 5000,
    endedAt: Date.now(),
    summary: "子任务摘要",
  };
}

function mountCard(n: TimelineNode, extraProps: Record<string, unknown> = {}) {
  return mount(NodeCard, {
    props: { node: n, ...extraProps },
    global: { plugins: [i18n], stubs },
  });
}

describe("NodeCard", () => {
  // ═══ thinking 变体 ═══

  it("thinking 收起态：标题行 + 前 60 字梗概，不渲染全文", () => {
    const long = "这是一段非常长的思考内容" + "啊".repeat(80);
    const w = mountCard(node({ kind: "thinking", text: long }));
    expect(w.find(".node-card-head--thinking").exists()).toBe(true);
    // 梗概 = 前 60 字 + …（标题行 snippet，截断不渲染全文）
    expect(w.find(".node-card-snippet").text()).toBe(long.slice(0, 60) + "…");
    expect(w.find(".node-card-snippet").text().length).toBeLessThan(long.length);
    // 收起态无 body
    expect(w.find(".node-card-body--thinking").exists()).toBe(false);
  });

  it("thinking 点击标题行 → emit update:expanded", async () => {
    const w = mountCard(node({ kind: "thinking", text: "思考" }));
    await w.find(".node-card-head--thinking").trigger("click");
    expect(w.emitted("update:expanded")).toEqual([[true]]);
  });

  it("thinking 展开态渲染全文", () => {
    const w = mountCard(node({ kind: "thinking", text: "全文" }), { expanded: true });
    expect(w.find(".node-card-body--thinking").text()).toBe("全文");
  });

  it("thinking 显示耗时（durationMs → 🧠x.xs）", () => {
    const w = mountCard(node({ kind: "thinking", text: "思考", durationMs: 1500 }));
    expect(w.text()).toContain("🧠1.5s");
  });

  // ═══ text / summary 变体 ═══

  it("text 变体：无标题行直接正文", () => {
    const w = mountCard(node({ kind: "text", text: "回答正文" }));
    expect(w.find(".node-card-text").exists()).toBe(true);
    expect(w.text()).toContain("回答正文");
    expect(w.find(".node-card-head").exists()).toBe(false);
  });

  it("summary 变体：绿底渐变类 + Flag + 总结 文案（isSummary 标记）", () => {
    const w = mountCard(node({ kind: "text", text: "最终总结", isSummary: true }));
    expect(w.classes()).toContain("node-card--summary");
    expect(w.find(".node-card-summary-head").text()).toContain("Summary");
  });

  // ═══ tool 变体 ═══

  it("tool 收起态：工具名 + 梗概 + ✓（有 result）", () => {
    const w = mountCard(node({
      key: "t1",
      kind: "tool",
      tool: { id: "t1", name: "Bash", input: { command: "ls -la" }, result: "file1" },
    }));
    expect(w.find(".node-card-tool-name").text()).toBe("Bash");
    expect(w.text()).toContain("ls -la"); // 梗概 = 命令首行
    expect(w.text()).toContain("✓");
    // 收起态不渲染 input/result 展开区
    expect(w.text()).not.toContain("file1");
  });

  it("tool 错误态显示 ✗（isError）", () => {
    const w = mountCard(node({
      key: "t1",
      kind: "tool",
      tool: { id: "t1", name: "Bash", input: { command: "bad" }, result: "not found", isError: true },
    }));
    expect(w.text()).toContain("✗");
  });

  it("tool 点击标题行展开 → emit update:expanded", async () => {
    const w = mountCard(node({
      key: "t1",
      kind: "tool",
      tool: { id: "t1", name: "Bash", input: { command: "ls" }, result: "file" },
    }));
    await w.find(".node-card-head--tool").trigger("click");
    expect(w.emitted("update:expanded")).toEqual([[true]]);
  });

  it("tool 展开态渲染 input + result", () => {
    const w = mountCard(node({
      key: "t1",
      kind: "tool",
      tool: { id: "t1", name: "Bash", input: { command: "ls" }, result: "file1\nfile2" },
    }), { expanded: true });
    expect(w.text()).toContain("Input");
    expect(w.text()).toContain('"command"');
    expect(w.text()).toContain("file1\nfile2");
  });

  it("tool 显示执行耗时（executionDurationMs → ⚡x.xs）", () => {
    const w = mountCard(node({
      key: "t1",
      kind: "tool",
      tool: { id: "t1", name: "Bash", input: { command: "ls" }, result: "file", executionDurationMs: 2300 },
    }));
    expect(w.text()).toContain("⚡2.3s");
  });

  it("D18 图标映射：websearch=globe / read=file-text / edit=pencil / bash=terminal / 未知=wrench", () => {
    const cases: Array<[string, string]> = [
      ["WebSearch", "globe"],
      ["Read", "file-text"],
      ["Edit", "pencil"],
      ["Bash", "terminal"],
      ["UnknownTool", "wrench"],
    ];
    for (const [name, icon] of cases) {
      const w = mountCard(node({
        key: name,
        kind: "tool",
        tool: { id: name, name, input: {} },
      }));
      // lucide 渲染 svg 携带 lucide-{icon} class（如 lucide-globe）
      expect(w.html()).toContain(`lucide-${icon}`);
    }
  });

  // ═══ 反馈 #4/#5：head 右对齐 + chevron + 耗时补全 ═══

  it("head 布局：左组(icon+名称+梗概) 右组(状态+耗时+chevron)——状态区独立节点", () => {
    const w = mountCard(node({
      key: "t1",
      kind: "tool",
      tool: { id: "t1", name: "Bash", input: { command: "ls" }, result: "file", executionDurationMs: 500 },
    }), { expanded: true });
    const head = w.find(".node-card-head--tool");
    expect(head.find(".node-card-head-left").exists()).toBe(true);
    expect(head.find(".node-card-head-right").exists()).toBe(true);
    // 右组内状态 → 耗时 → chevron 顺序（带闭合引号区分 node-card-status 与 node-card-stat 前缀相同）
    const rightHtml = head.find(".node-card-head-right").html();
    expect(rightHtml.indexOf('class="node-card-status"')).toBeGreaterThan(-1);
    expect(rightHtml.indexOf('class="node-card-stat"')).toBeGreaterThan(rightHtml.indexOf('class="node-card-status"'));
    expect(rightHtml.indexOf("node-card-chevron")).toBeGreaterThan(rightHtml.indexOf('class="node-card-stat"'));
  });

  it("可展开节点渲染 chevron：收起朝下 / 展开朝上（rotate 180）", () => {
    const collapsed = mountCard(node({ key: "t1", kind: "tool", tool: { id: "t1", name: "Bash", input: {} } }));
    expect(collapsed.find(".node-card-chevron").exists()).toBe(true);
    expect(collapsed.find(".node-card-chevron--up").exists()).toBe(false);
    const expanded = mountCard(node({ key: "t1", kind: "tool", tool: { id: "t1", name: "Bash", input: {} } }), { expanded: true });
    expect(expanded.find(".node-card-chevron--up").exists()).toBe(true);
    // thinking 也可展开 → 有 chevron
    const th = mountCard(node({ kind: "thinking", text: "思考" }));
    expect(th.find(".node-card-chevron").exists()).toBe(true);
    // text 恒展开（非可展开节点）→ 无 chevron
    const tx = mountCard(node({ kind: "text", text: "正文" }));
    expect(tx.find(".node-card-chevron").exists()).toBe(false);
  });

  it("text 节点不显示耗时（2026-08-10 用户拍板：demo 中耗时只在节点标题行，text 正文无）", () => {
    const withDur = mountCard(node({ kind: "text", text: "正文", durationMs: 3200 }));
    expect(withDur.text()).not.toContain("⏱");
    expect(withDur.text()).toBe("正文");
  });

  // ═══ todo 变体（2026-08-10 用户拍板：复用 TodoRecordCard——单行摘要默认收起，点击展开 chips 列表）═══

  it("todo 变体：TodoRecordCard 折叠摘要（标题 + 正在：xxx），默认不渲染列表，点击展开 chips", async () => {
    const w = mountCard(node({
      key: "t2",
      kind: "tool",
      tool: {
        id: "t2",
        name: "todowrite",
        input: { todos: [{ content: "写 README", status: "in_progress" }, { content: "发布", status: "pending" }, { content: "完成", status: "completed" }] },
      },
    }));
    // 折叠摘要：标题「Update todos」+ 正在：进行中任务 + 默认不渲染列表
    expect(w.text()).toContain("Update todos");
    expect(w.text()).toContain("正在：写 README");
    expect(w.find(".todo-record-card__list").exists()).toBe(false);
    // 不使用 NodeCard chevron（TodoRecordCard 自带 ▾ 箭头）
    expect(w.find(".node-card-chevron").exists()).toBe(false);
    // 点击展开：chips 列表 3 项（状态 + 标题）
    await w.find(".todo-record-card__header").trigger("click");
    const chips = w.findAll(".todo-record-chip");
    expect(chips).toHaveLength(3);
    expect(chips[0].classes()).toContain("todo-record-chip--in_progress");
    expect(chips[0].text()).toContain("写 README");
    expect(chips[2].classes()).toContain("todo-record-chip--completed");
    expect(chips[2].text()).toContain("完成");
    // 再点收起
    await w.find(".todo-record-card__header").trigger("click");
    expect(w.find(".todo-record-card__list").exists()).toBe(false);
    // 展开区不渲染（input/result 区）
    expect(w.text()).not.toContain("Input");
  });

  it("todo 变体无 todos 字段 → 摘要「正在：」+ 展开无列表", async () => {
    const w = mountCard(node({
      key: "t3",
      kind: "tool",
      tool: { id: "t3", name: "todowrite", input: {} },
    }));
    expect(w.text()).toContain("Update todos");
    expect(w.find(".todo-record-card__list").exists()).toBe(false);
    await w.find(".todo-record-card__header").trigger("click");
    expect(w.find(".todo-record-card__list").exists()).toBe(true);
    expect(w.findAll(".todo-record-chip")).toHaveLength(0);
  });

  // ═══ todo 全完成态（2026-08-10 反馈：全部完成 → 「待办完成」+ n/m 完成 + ✓ 标记，
  //   不再显示「正在：查看项目 README」（currentTodoTask 无 in_progress 时兜底首项的错误）═══
  it("todo 全完成：标题「Todos done」+ 摘要 n/m done + ✓ 状态标记", () => {
    const w = mountCard(node({
      key: "t4",
      kind: "tool",
      tool: {
        id: "t4",
        name: "todowrite",
        input: { todos: [
          { content: "写 README", status: "completed" },
          { content: "发布", status: "completed" },
        ] },
      },
    }));
    expect(w.text()).toContain("Todos done");
    expect(w.text()).toContain("2/2 done");
    expect(w.text()).not.toContain("正在：");
    expect(w.find(".todo-record-card__status").text()).toBe("✓");
  });

  it("todo 部分完成：仍「Update todos」+ 正在：xxx，无 ✓ 标记", () => {
    const w = mountCard(node({
      key: "t5",
      kind: "tool",
      tool: {
        id: "t5",
        name: "todowrite",
        input: { todos: [
          { content: "写 README", status: "completed" },
          { content: "发布", status: "in_progress" },
        ] },
      },
    }));
    expect(w.text()).toContain("Update todos");
    expect(w.text()).toContain("正在：发布");
    expect(w.find(".todo-record-card__status").exists()).toBe(false);
  });

  // ═══ subtask 变体（D14 复用 SubTaskCard）═══

  it("subtask 变体：SubTaskCard 收到 subtask 数据", () => {
    const s = subTask();
    const w = mountCard(node({ key: "s1", kind: "subtask", taskId: "ses_1" }), { subtask: s });
    expect(w.find(".subtask-stub").exists()).toBe(true);
    expect(w.find(".subtask-stub").text()).toBe("ses_1");
  });

  it("subtask 查不到数据 → D6 容错占位（无 SubTaskCard）", () => {
    const w = mountCard(node({ key: "s1", kind: "subtask", taskId: "ses_ghost" }), { subtask: null });
    expect(w.find(".subtask-stub").exists()).toBe(false);
    expect(w.text()).toContain("Subtask details unavailable");
  });

  it("subtask 无 taskId（serve 尚未下发 sessionId，启动窗口）→ 启动中提示而非不可用", () => {
    const w = mountCard(node({ key: "s1", kind: "subtask" }), { subtask: null });
    expect(w.find(".subtask-stub").exists()).toBe(false);
    expect(w.text()).toContain("Starting subagent");
    expect(w.text()).not.toContain("Subtask details unavailable");
    expect(w.findAll(".node-card-subtask-dots i")).toHaveLength(3);
  });

  it("subtask 转发 expand/monitor/detail 事件", async () => {
    const s = subTask();
    const w = mountCard(node({ key: "s1", kind: "subtask", taskId: "ses_1" }), { subtask: s });
    const stub = w.findComponent({ name: "SubTaskCard" });
    await stub.vm.$emit("expand");
    expect(w.emitted("subtask-expand")).toEqual([["ses_1"]]);
    await stub.vm.$emit("monitor");
    expect(w.emitted("subtask-monitor")).toEqual([["ses_1"]]);
    await stub.vm.$emit("detail");
    expect(w.emitted("subtask-detail")).toEqual([[s]]);
  });

  // ═══ D8 两态 ═══

  it("busy 进行中：node-card--busy 类 + 三连点跳动", () => {
    const w = mountCard(node({ kind: "thinking", text: "流式思考" }), { busy: true });
    expect(w.classes()).toContain("node-card--busy");
    expect(w.findAll(".node-card-dots i")).toHaveLength(3);
  });

  it("非 busy 无三连点", () => {
    const w = mountCard(node({ kind: "thinking", text: "完成思考" }), { busy: false });
    expect(w.find(".node-card-dots").exists()).toBe(false);
  });
});
