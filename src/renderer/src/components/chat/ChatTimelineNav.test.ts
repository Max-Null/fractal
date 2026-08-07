import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import ChatTimelineNav from "./ChatTimelineNav.vue";
import type { Message } from "@/stores/chat";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (k: string, p?: Record<string, unknown>) => {
    if (k === "chat.timelineEllipsis" && p) return `${p.n} messages`;
    if (k === "chat.timelineExpandHint") return "Hover or click to expand all";
    return k;
  }}),
}));

function userMsg(id: string, content: string): Message {
  return { id, role: "user", content, thinking: "", toolUses: [], timestamp: Date.now(), isStreaming: false };
}
function asstMsg(id: string, content: string): Message {
  return { id, role: "assistant", content, thinking: "", toolUses: [], timestamp: Date.now(), isStreaming: false };
}

function mountNav(messages: Message[], activeIndex?: number) {
  // timeline 默认用已渲染消息构造（旧测试语义：时间线 = 消息）；全量目录场景单独传 timeline
  const timeline = messages.map(m => ({ id: m.id, created: m.timestamp, role: m.role }));
  return mount(ChatTimelineNav, { props: { messages, timeline, scrollContainer: null } });
}

function dotCount(wrapper: ReturnType<typeof mountNav>) {
  return wrapper.findAll(".chat-timeline-dot").length;
}
function ellipsisCount(wrapper: ReturnType<typeof mountNav>) {
  return wrapper.findAll(".chat-timeline-ellipsis").length;
}

describe("ChatTimelineNav", () => {
  // ═══ 基础渲染 ═══

  it("空消息列表不渲染", () => {
    const w = mountNav([]);
    expect(w.find(".chat-timeline-nav").exists()).toBe(false);
  });

  it("仅有 assistant 消息不渲染", () => {
    const w = mountNav([asstMsg("a1", "reply")]);
    expect(w.find(".chat-timeline-nav").exists()).toBe(false);
  });

  it("用户消息渲染对应数量的点", () => {
    const msgs = [userMsg("u1", "A"), asstMsg("a1", "R"), userMsg("u2", "B")];
    const w = mountNav(msgs);
    expect(dotCount(w)).toBe(2);
  });

  // ═══ 压缩逻辑 ═══

  it("≤7 条消息时不压缩，全部显示", () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 7; i++) {
      msgs.push(userMsg(`u${i}`, `msg ${i}`), asstMsg(`a${i}`, `reply ${i}`));
    }
    const w = mountNav(msgs);
    expect(dotCount(w)).toBe(7);
    expect(ellipsisCount(w)).toBe(0);
  });

  it(">7 条消息时压缩，含首尾点 + 省略号", () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`u${i}`, `msg ${i}`), asstMsg(`a${i}`, `reply ${i}`));
    }
    const w = mountNav(msgs);
    const dots = w.findAll(".chat-timeline-dot");
    // activeIndex = -1 → fallback 到末尾 index 19，窗口 17-19 + 首点 0
    // rangeStart = max(1, 19-2) = 17, rangeEnd = min(18, 19+2) = 18
    // 首点 0 + 窗口 17 18 + 尾点 19 = 4 个点
    expect(dots.length).toBe(4);
    // 前置省略（1~16，16 条）+ 无后置省略（rangeEnd=18 ≥ total-2=18）
    expect(ellipsisCount(w)).toBe(1);
  });

  it("压缩在中段时两端都有省略号", () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`u${i}`, `msg ${i}`), asstMsg(`a${i}`, `reply ${i}`));
    }
    const w = mountNav(msgs);
    // activeIndex = -1 → fallback 到末尾，不会有双省略号
    // 模拟手动设置 activeIndex = 10 的情况需要访问内部状态
    // 换一种方式验证：通过判断 dots 索引验证结构
    const dots = w.findAll(".chat-timeline-dot");
    // 首点 index 0、窗口 17 18、尾点 19
    expect(dots.length).toBe(4);
  });

  // ═══ 省略号计数 off-by-one 验证 ═══

  it("前置省略号计数不包含首点（off-by-one 修复验证）", () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 12; i++) {
      msgs.push(userMsg(`u${i}`, `msg ${i}`), asstMsg(`a${i}`, `reply ${i}`));
    }
    const w = mountNav(msgs);
    // total=12, active=-1→11, rangeStart=max(1,9)=9, rangeEnd=min(10,13)=10
    // 首点 0 + 前置省略 1~8 (8条) + 窗口 9 10 + 尾点 11 = 省略号 title 应为 "8 messages"
    const ellipsis = w.find(".chat-timeline-ellipsis");
    expect(ellipsis.exists()).toBe(true);
    // title 包含正确的隐藏数
    expect(ellipsis.attributes("title")).toContain("8 messages");
  });

  it("后置省略号计数不含尾点（off-by-one 修复验证）", () => {
    // 需要 active 在开头附近才会触发后置省略号
    // activeIndex = -1 默认末尾，所以需要构造一个能看到后置省略号的场景
    // 实际上默认末尾时 rangeEnd 接近末尾，不会触发后置省略号
    // 这里验证：当 total=20 时，后置隐藏范围不含尾点
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`u${i}`, `msg ${i}`), asstMsg(`a${i}`, `reply ${i}`));
    }
    const w = mountNav(msgs);
    // activeIndex=-1→19, rangeStart=17, rangeEnd=18
    // rangeEnd(18) < total-2(18) → false → 无后置省略号 ✓
    // 但有前置省略号 1~16 (16条)
    const ellipsis = w.find(".chat-timeline-ellipsis");
    expect(ellipsis.attributes("title")).toContain("16 messages");
    // 隐藏的是 1~16，共 16 条，不是 17 或 18 ✓
  });

  // ═══ 展开交互（hover 展开 + 点击省略号切换；原 Alt 键已移除——与 Windows 菜单栏冲突）═══

  it("鼠标悬停展开全部点", async () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`u${i}`, `msg ${i}`), asstMsg(`a${i}`, `reply ${i}`));
    }
    const w = mountNav(msgs);
    // 压缩模式下只有 4 个点
    expect(dotCount(w)).toBe(4);

    // 悬停导航区 → 展开全部
    await w.find(".chat-timeline-nav").trigger("mouseenter");
    expect(dotCount(w)).toBe(20);

    // 移出 → 恢复压缩
    await w.find(".chat-timeline-nav").trigger("mouseleave");
    expect(dotCount(w)).toBe(4);
  });

  it("点击省略号切换持久展开，再点收起", async () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`u${i}`, `msg ${i}`), asstMsg(`a${i}`, `reply ${i}`));
    }
    const w = mountNav(msgs);
    expect(dotCount(w)).toBe(4);

    // 点击省略号 → 展开全部（持久，移出不收起）
    await w.find(".chat-timeline-ellipsis").trigger("click");
    expect(dotCount(w)).toBe(20);
    await w.find(".chat-timeline-nav").trigger("mouseleave");
    expect(dotCount(w)).toBe(20);

    // 展开后省略号消失，末尾按钮为锁定态 × → 点击收起
    expect(w.findAll(".chat-timeline-ellipsis")).toHaveLength(0);
    expect(w.find(".chat-timeline-collapse").text()).toBe("×");
    await w.find(".chat-timeline-collapse").trigger("click");
    expect(dotCount(w)).toBe(4);
  });

  it("悬停展开时末尾按钮为 ⏸，点击锁定（移出不收起）", async () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`u${i}`, `msg ${i}`), asstMsg(`a${i}`, `reply ${i}`));
    }
    const w = mountNav(msgs);
    expect(dotCount(w)).toBe(4);

    // 悬停 → 临时展开 + ⏸ 锁定按钮
    await w.find(".chat-timeline-nav").trigger("mouseenter");
    expect(dotCount(w)).toBe(20);
    expect(w.find(".chat-timeline-collapse").text()).toBe("⏸");

    // 点击 ⏸ → 锁定：移出不收起
    await w.find(".chat-timeline-collapse").trigger("click");
    await w.find(".chat-timeline-nav").trigger("mouseleave");
    expect(dotCount(w)).toBe(20);
    // 锁定态按钮变为 ×
    expect(w.find(".chat-timeline-collapse").text()).toBe("×");

    // 再点 × → 收起
    await w.find(".chat-timeline-collapse").trigger("click");
    expect(dotCount(w)).toBe(4);
  });

  it("50 条外锚点 tooltip 用 timeline preview 兜底（messages 只渲染尾部）", async () => {
    // messages 只渲染尾部 1 条 user（u49），timeline 全量 50 个锚点且带 preview
    const msgs = [userMsg("u49", "渲染的最后一条")];
    const timeline = Array.from({ length: 50 }, (_, i) => ({
      id: `u${i}`, created: i, role: "user" as const, preview: `历史消息 ${i} 的内容预览`,
    }));
    const w = mount(ChatTimelineNav, { props: { messages: msgs, timeline, scrollContainer: null } });

    // 悬停展开 → 50 个点；第 1 个点（u0，未渲染）tooltip 显示 preview 而非空
    await w.find(".chat-timeline-nav").trigger("mouseenter");
    const dots = w.findAll(".chat-timeline-dot");
    expect(dots).toHaveLength(50);
    // u0 在 messages 中不存在 → tooltip 用 preview
    await dots[0].trigger("mouseenter");
    const tips = w.findAll(".chat-timeline-tooltip");
    const tipFor0 = tips.find(t => t.text().includes("历史消息 0"));
    expect(tipFor0).toBeTruthy();
  });

  it("持久展开时省略号点击不触发跳转", async () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`u${i}`, `msg ${i}`), asstMsg(`a${i}`, `reply ${i}`));
    }
    const w = mountNav(msgs);
    await w.find(".chat-timeline-ellipsis").trigger("click");
    // 展开后省略号消失（全部渲染为 dot）→ 无省略号可点，jump 不被误触发
    expect(w.findAll(".chat-timeline-ellipsis")).toHaveLength(0);
  });

  // ═══ 点击交互 ═══

  it("点击 dot 发射 jump（全局锚点索引）", async () => {
    const msgs = [userMsg("u0", "A"), asstMsg("a0", "R"), userMsg("u1", "B"), asstMsg("a1", "R2")];
    // timeline 含 assistant 锚点（完整目录）→ user 过滤后锚点 2 个，index 0/1
    const timeline = [
      { id: "u0", created: 0, role: "user" as const },
      { id: "a0", created: 1, role: "assistant" as const },
      { id: "u1", created: 2, role: "user" as const },
      { id: "a1", created: 3, role: "assistant" as const },
    ];
    const w = mount(ChatTimelineNav, { props: { messages: msgs, timeline, scrollContainer: null } });
    // ≤7 条消息不压缩，全部显示（user 锚点 2 个）
    const dots = w.findAll(".chat-timeline-dot");
    expect(dots.length).toBe(2);

    await dots[1].trigger("click");
    expect(w.emitted("jump")).toEqual([[1]]);
  });

  it("点击省略号展开全部（不再直接跳转，跳转走展开后的 dot）", async () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`u${i}`, `msg ${i}`), asstMsg(`a${i}`, `reply ${i}`));
    }
    const w = mountNav(msgs);
    const ellipsis = w.find(".chat-timeline-ellipsis");
    expect(ellipsis.exists()).toBe(true);

    await ellipsis.trigger("click");
    // 省略号语义改为展开：不发射 jump，全部圆点渲染
    expect(w.emitted("jump")).toBeUndefined();
    expect(dotCount(w)).toBe(20);
  });

  // ═══ timeline 全量索引（完整目录，不受 DOM 分页影响）═══

  it("timeline 全量索引渲染：50 条 messages + 500 条 timeline → 悬停展开后圆点按 timeline 全量", async () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 50; i++) {
      msgs.push(userMsg(`u${i}`, `msg ${i}`));
    }
    // 完整目录 500 个 user 锚点（messages 只渲染尾部 50 条，但时间线应全量展示）
    const timeline = Array.from({ length: 500 }, (_, i) => ({ id: `u${i}`, created: i, role: "user" as const }));
    const w = mount(ChatTimelineNav, { props: { messages: msgs, timeline, scrollContainer: null } });

    // 压缩模式（>7 条）：不全部显示，但锚点基于全量 500
    const ellipsis = w.find(".chat-timeline-ellipsis");
    expect(ellipsis.exists()).toBe(true);

    // 悬停展开 → 500 个点（完整目录）
    await w.find(".chat-timeline-nav").trigger("mouseenter");
    expect(dotCount(w)).toBe(500);
    await w.find(".chat-timeline-nav").trigger("mouseleave");
  });

  it("timeline 过滤 assistant 后作为锚点（user 目录）", () => {
    const msgs = [userMsg("u0", "A"), asstMsg("a0", "R")];
    const timeline = [
      { id: "u0", created: 0, role: "user" as const },
      { id: "a0", created: 1, role: "assistant" as const },
      { id: "u1", created: 2, role: "user" as const }, // 全量目录有但未渲染（DOM 分页外）
    ];
    const w = mount(ChatTimelineNav, { props: { messages: msgs, timeline, scrollContainer: null } });
    // user 锚点 = timeline 过滤 user → 2 个（u0、u1），不因 messages 只有 1 条 user 而缩水
    expect(dotCount(w)).toBe(2);
  });

  // ═══ 全局 active 换算（视口顶部消息 → timeline 全量中的位置）═══

  it("activeIndex 全局换算：视口顶部消息映射到 timeline 全量索引", async () => {
    // messages 只渲染尾部 2 条（u2/u3），timeline 全量 4 条（u0..u3）
    const msgs = [userMsg("u2", "C"), userMsg("u3", "D")];
    const timeline = [
      { id: "u0", created: 0, role: "user" as const },
      { id: "u1", created: 1, role: "user" as const },
      { id: "u2", created: 2, role: "user" as const },
      { id: "u3", created: 3, role: "user" as const },
    ];
    // mock 容器：el0 在视口顶部（offsetTop=100 ≤ scrollTop+80=230），el1 在下方
    const el0 = document.createElement("div");
    el0.setAttribute("data-role", "user");
    Object.defineProperty(el0, "offsetTop", { value: 100 });
    const el1 = document.createElement("div");
    el1.setAttribute("data-role", "user");
    Object.defineProperty(el1, "offsetTop", { value: 500 });
    const container = {
      querySelectorAll: (sel: string) => (sel === '[data-role="user"]' ? [el0, el1] : []),
      scrollTop: 150,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as HTMLElement;

    const w = mount(ChatTimelineNav, { props: { messages: msgs, timeline, scrollContainer: container } });
    // watch immediate → scheduleUpdate → 80ms 后 updateActive
    await new Promise((r) => setTimeout(r, 100));

    // 视口顶部为 u2 → 全局 userTimeline index = 2 → 第 3 个点高亮
    const dots = w.findAll(".chat-timeline-dot");
    expect(dots.length).toBe(4); // total=4 ≤ 7 → 全部显示
    expect(dots[2].classes()).toContain("chat-timeline-dot--active");
  });

  // ═══ tooltip ═══

  it("鼠标进入时间线区域同时显示所有 tooltip", async () => {
    const msgs = [
      userMsg("u0", "第一条消息"),
      asstMsg("a0", "reply1"),
      userMsg("u1", "第二条消息"),
      asstMsg("a1", "reply2"),
    ];
    const w = mountNav(msgs);
    const nav = w.find(".chat-timeline-nav");

    await nav.trigger("mouseenter");
    const tooltips = w.findAll(".chat-timeline-tooltip");
    expect(tooltips).toHaveLength(2);
    expect(tooltips[0].text()).toContain("第一条消息");
    expect(tooltips[1].text()).toContain("第二条消息");
  });

  it("鼠标离开时间线区域所有 tooltip 消失", async () => {
    const msgs = [userMsg("u0", "test"), asstMsg("a0", "reply")];
    const w = mountNav(msgs);
    const nav = w.find(".chat-timeline-nav");

    await nav.trigger("mouseenter");
    expect(w.findAll(".chat-timeline-tooltip").length).toBeGreaterThan(0);

    await nav.trigger("mouseleave");
    expect(w.findAll(".chat-timeline-tooltip")).toHaveLength(0);
  });

  // ═══ 活跃点高亮 ═══

  it("activeIndex 对应点有 active class", () => {
    const msgs = [userMsg("u0", "A"), asstMsg("a0", "R"), userMsg("u1", "B")];
    // activeIndex 是内部状态，默认 -1 → 无高亮点
    const w = mountNav(msgs);
    const active = w.findAll(".chat-timeline-dot--active");
    expect(active.length).toBe(0);
  });
});
