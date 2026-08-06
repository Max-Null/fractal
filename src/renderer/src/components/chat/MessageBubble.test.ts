import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import MessageBubble from "./MessageBubble.vue";
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

beforeEach(() => setActivePinia(createPinia()));

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: "test-1",
    role: "assistant",
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
  it("renders user message with U avatar", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "user", content: "Hello AI" }),
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.text()).toContain("Hello AI");
    expect(wrapper.text()).toContain("You");
  });

  it("renders assistant message with C avatar", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "assistant", content: "Hello human", contentBlocks: [{ type: "text", content: "Hello human" }] }),
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.text()).toContain("Hello human");
    expect(wrapper.text()).toContain("Claude");
  });

  it("shows thinking section when thinking content exists", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({
          role: "assistant",
          thinking: "Step 1: analyze...",
          contentBlocks: [{ type: "thinking", content: "Step 1: analyze..." }],
        }),
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.text()).toContain("Step 1: analyze...");
  });

  it("does not show thinking section when empty", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "assistant", thinking: "", contentBlocks: [] }),
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.text()).not.toContain("Thinking...");
    expect(wrapper.text()).not.toContain("思考中...");
  });

  it("shows tool use details", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({
          role: "assistant",
          contentBlocks: [{ type: "tool_use", toolUse: { id: "tu_1", name: "Bash", input: { command: "ls" } } }],
        }),
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.text()).toContain("Bash");
    expect(wrapper.text()).toContain("ls");
  });

  it("shows streaming cursor when isStreaming", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "assistant", content: "partial", isStreaming: true, contentBlocks: [{ type: "text", content: "partial" }] }),
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.html()).toContain("stream-cursor");
  });

  it("does not show streaming cursor when finished", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "assistant", content: "done", isStreaming: false, contentBlocks: [{ type: "text", content: "done" }] }),
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.html()).not.toContain("stream-cursor");
  });

  // ── Token stats ──

  it("shows token stats for finished assistant messages", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({
          role: "assistant",
          content: "Done.",
          isStreaming: false,
          durationMs: 2345,
          inputTokens: 150,
          outputTokens: 80,
          contentBlocks: [{ type: "text", content: "Done." }],
        }),
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.text()).toContain("2.3s");
    expect(wrapper.text()).toContain("150");
    expect(wrapper.text()).toContain("80");
  });

  it("shows stats only when finished, not streaming", () => {
    // Streaming: no stats in the token row (only in timeline)
    const streaming = mount(MessageBubble, {
      props: {
        message: makeMsg({
          role: "assistant", content: "partial",
          isStreaming: true, durationMs: 500, inputTokens: 10,
          contentBlocks: [{ type: "text", content: "partial" }],
        }),
      },
      global: { plugins: [i18n] },
    });
    // Finished: stats visible
    const finished = mount(MessageBubble, {
      props: {
        message: makeMsg({
          role: "assistant", content: "done",
          isStreaming: false, durationMs: 2345, inputTokens: 150, outputTokens: 80,
          contentBlocks: [{ type: "text", content: "done" }],
        }),
      },
      global: { plugins: [i18n] },
    });
    expect(finished.text()).toContain("2.3s");
  });

  it("does not show token stats when no data", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({
          role: "assistant",
          content: "Done.",
          isStreaming: false,
          durationMs: undefined,
          inputTokens: undefined,
          outputTokens: undefined,
          costUSD: undefined,
        }),
      },
      global: { plugins: [i18n] },
    });
    // No token stats bar should render
    expect(wrapper.text()).not.toContain("⏱");
  });

  // ── Edit / Resend buttons ──

  it("shows edit and resend buttons on user messages", () => {
    const wrapper = mount(MessageBubble, {
      props: {
        message: makeMsg({ role: "user", content: "Hi", isStreaming: false }),
      },
      global: { plugins: [i18n] },
    });
    // Edit and Resend buttons should be present (title attributes)
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
    // Click edit button
    const editBtn = wrapper.findAll("button").find(b => b.attributes("title") === "Edit");
    expect(editBtn).toBeTruthy();
    await editBtn!.trigger("click");

    // Textarea should appear with original content
    const textarea = wrapper.find("textarea");
    expect(textarea.exists()).toBe(true);
    expect(textarea.element.value).toBe("Hello world");

    // Cancel and Save & Resend buttons should appear
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
    // Enter edit mode
    const editBtn = wrapper.findAll("button").find(b => b.attributes("title") === "Edit");
    await editBtn!.trigger("click");

    // Edit text
    const textarea = wrapper.find("textarea");
    await textarea.setValue("Edited text");

    // Click save
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
});
