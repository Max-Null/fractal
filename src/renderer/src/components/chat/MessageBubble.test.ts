import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import MessageBubble from "./MessageBubble.vue";
import { useSlashCommands } from "@/composables/useSlashCommands";
import type { Message } from "@/stores/chat";

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      chat: { thinking: "Thinking...", thinkingDone: "Thinking", copy: "Copy", copied: "Copied", edit: "Edit", resend: "Resend", cancel: "Cancel", saveResend: "Save & Resend" },
      mode: { askBefore: "Ask", editAuto: "Edit", plan: "Plan", auto: "Auto" },
    },
    zh: {
      chat: { thinking: "思考中...", thinkingDone: "思考过程", copy: "复制", copied: "已复制", edit: "编辑", resend: "重发", cancel: "取消", saveResend: "保存并重发" },
      mode: { askBefore: "询问", editAuto: "编辑", plan: "计划", auto: "自动" },
    },
  },
});

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  // 重置 useSlashCommands 模块级 recentCommands（localStorage 清理不重置 ref——测试间状态隔离）
  useSlashCommands().recentCommands.value = [];
});

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: "test-1",
    role: "user",
    content: "",
    thinking: "",
    toolUses: [],
    contentBlocks: [],
    timestamp: Date.now(),
    isStreaming: false,
    ...overrides,
  };
}

describe("MessageBubble", () => {
  it("renders user message with 我 avatar (username 缺省兜底)", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "user", content: "Hello AI" }),
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.text()).toContain("Hello AI");
    // 2026-08-10：名字行由 'You' 换为消息发送时间 HH:mm（makeMsg timestamp=Date.now() → 匹配 HH:MM 形态）
    expect(wrapper.text()).toMatch(/\d{2}:\d{2}/);
    // 反馈 #1：用户头像 = 用户名首字 || '我'；settings 无 username 字段 → 兜底 '我'
    expect(wrapper.find(".msg-avatar--user").text()).toBe("我");
  });

  // ── Assistant 兜底分支（无 contentBlocks 旧存档 → 纯文本 Markdown + 流式光标）──
  // 注意：助手时间线渲染已迁移至 NodeTimeline/NodeCard（3b），这里只保留无 contentBlocks 的兜底路径

  it("renders assistant fallback text with C avatar", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "assistant", content: "Hello human" }),
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.text()).toContain("Hello human");
    expect(wrapper.text()).toContain("分形");
  });

  it("does not render contentBlocks timeline (migrated to NodeTimeline)", () => {
    // 助手时间线由 NodeTimeline 承接——MessageBubble 不再渲染 .f-timeline / tl-* 结构
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({
          role: "assistant",
          content: "",
          thinking: "Step 1: analyze...",
          contentBlocks: [
            { type: "thinking", content: "Step 1: analyze..." },
            { type: "tool_use", toolUse: { id: "tu_1", name: "Bash", input: { command: "ls" } } },
            { type: "text", content: "done" },
          ],
        }),
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.find(".f-timeline").exists()).toBe(false);
    expect(wrapper.find(".tl-thinking").exists()).toBe(false);
  });

  it("shows streaming cursor in fallback text when isStreaming (no contentBlocks)", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "assistant", content: "partial", isStreaming: true }),
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.html()).toContain("stream-cursor");
  });

  it("does not show streaming cursor when finished", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "assistant", content: "done", isStreaming: false }),
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.html()).not.toContain("stream-cursor");
  });

  // ── Edit / Resend buttons ──

  it("shows edit and resend buttons on user messages", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "user", content: "Hi", isStreaming: false }),
      },
      global: { plugins: [i18n] },
    });
    const buttons = wrapper.findAll("button");
    const titles = buttons.map(b => b.attributes("title")).filter(Boolean);
    expect(titles).toContain("Edit");
    expect(titles).toContain("Resend");
  });

  it("does not show edit/resend on assistant messages", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "assistant", content: "Reply", isStreaming: false }),
      },
      global: { plugins: [i18n] },
    });
    const buttons = wrapper.findAll("button");
    const titles = buttons.map(b => b.attributes("title")).filter(Boolean);
    expect(titles).not.toContain("Edit");
    expect(titles).not.toContain("Resend");
  });

  it("does not show edit/resend during streaming", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "user", content: "Hi", isStreaming: true }),
      },
      global: { plugins: [i18n] },
    });
    const buttons = wrapper.findAll("button");
    const titles = buttons.map(b => b.attributes("title")).filter(Boolean);
    expect(titles).not.toContain("Edit");
    expect(titles).not.toContain("Resend");
  });

  it("enters edit mode on edit click and shows textarea", async () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "user", content: "Hello world", isStreaming: false }),
      },
      global: { plugins: [i18n] },
    });
    const editBtn = wrapper.findAll("button").find(b => b.attributes("title") === "Edit");
    expect(editBtn).toBeTruthy();
    await editBtn!.trigger("click");

    const textarea = wrapper.find("textarea");
    expect(textarea.exists()).toBe(true);
    expect(textarea.element.value).toBe("Hello world");

    expect(wrapper.text()).toContain("Cancel");
    expect(wrapper.text()).toContain("Save");
  });

  it("emits editSave with new content on save", async () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "user", content: "Original", isStreaming: false }),
      },
      global: { plugins: [i18n] },
    });
    const editBtn = wrapper.findAll("button").find(b => b.attributes("title") === "Edit");
    await editBtn!.trigger("click");

    const textarea = wrapper.find("textarea");
    await textarea.setValue("Edited text");

    const saveBtn = wrapper.findAll("button").find(b => b.text().includes("Save"));
    await saveBtn!.trigger("click");

    expect(wrapper.emitted("editSave")).toBeTruthy();
    expect(wrapper.emitted("editSave")![0]).toEqual(["test-1", "Edited text"]);
  });

  it("emits resend event on resend button click", async () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "user", content: "Retry me", isStreaming: false }),
      },
      global: { plugins: [i18n] },
    });
    const resendBtn = wrapper.findAll("button").find(b => b.attributes("title") === "Resend");
    expect(resendBtn).toBeTruthy();
    await resendBtn!.trigger("click");

    expect(wrapper.emitted("resend")).toBeTruthy();
    expect(wrapper.emitted("resend")![0]).toEqual(["test-1", "Retry me"]);
  });

  // ── D15 指令徽标（@agent 中文词边界 / 斜杠命令白名单）──

  it("shows @agent badge (purple) with Chinese word boundary", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "user", content: "帮我把这个任务交给@工匠，谢谢" }),
      },
      global: { plugins: [i18n] },
    });
    const badge = wrapper.find(".msg-badge");
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe("@工匠");
    expect(badge.classes()).toContain("msg-badge--agent");
    // 边框色随变体微调（紫色边框类）
    expect(wrapper.find(".user-bubble").classes()).toContain("user-bubble--agent");
  });

  it("@agent 匹配多种角色 + 行尾/标点边界", () => {
    // 词边界：行尾 / 中文标点后接（D15：ASCII \b 对 CJK 无效，用标点/空白/行尾做边界）
    for (const content of ["交给@军师", "让@侦查兵，继续", "请@制图师，生成图表"]) {
      const wrapper = mount(MessageBubble, {
        props: { message: makeMsg({ role: "user", content }) },
        global: { plugins: [i18n] },
      });
      expect(wrapper.find(".msg-badge").exists()).toBe(true);
    }
  });

  it("@agent 后紧跟汉字不匹配（非词边界，避免误判）", () => {
    // 「@工匠处理」中 @工匠 后是汉字「处」→ 非词边界 → 不匹配
    const wrapper = mount(MessageBubble, {
      props: { message: makeMsg({ role: "user", content: "让@工匠处理这个任务" }) },
      global: { plugins: [i18n] },
    });
    expect(wrapper.find(".msg-badge").exists()).toBe(false);
  });

  it("email 场景不误判 @agent 徽标（a@b.com 词边界不匹配）", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "user", content: "发到 a@b.com 就好" }),
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.find(".msg-badge").exists()).toBe(false);
  });

  it("shows slash command badge (blue) when command in useSlashCommands history", () => {
    // 通过 recordCommand 填充模块级 recentCommands（localStorage 预置不更新模块 ref）
    useSlashCommands().recordCommand("/continue-session");
    useSlashCommands().recordCommand("/export-session");
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "user", content: "/continue-session 继续" }),
      },
      global: { plugins: [i18n] },
    });
    const badge = wrapper.find(".msg-badge");
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe("/continue-session");
    expect(badge.classes()).toContain("msg-badge--command");
    expect(wrapper.find(".user-bubble").classes()).toContain("user-bubble--command");
  });

  it("unknown slash command (not in history) shows no badge", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "user", content: "/unknown-cmd foo" }),
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.find(".msg-badge").exists()).toBe(false);
  });

  it("@agent 优先于斜杠命令（同时存在时显示 @agent 徽标）", () => {
    useSlashCommands().recordCommand("/continue-session");
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "user", content: "/continue-session 请@军师！" }),
      },
      global: { plugins: [i18n] },
    });
    const badge = wrapper.find(".msg-badge");
    expect(badge.text()).toBe("@军师");
    expect(badge.classes()).toContain("msg-badge--agent");
  });
});
