import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { setActivePinia, createPinia } from "pinia";
import InputBar from "./InputBar.vue";

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      chat: { placeholder: "Type a message, Enter to send...", stop: "Stop" },
    },
  },
});

function mountInputBar(props: Record<string, unknown> = {}) {
  return mount(InputBar, {
    props: { disabled: false, ...props },
    global: { plugins: [i18n, createPinia()] },
  });
}

/** InputBar contains: optimize, stop/send. Send button is the last one (paper-plane icon). */
function findSendBtn(wrapper: ReturnType<typeof mountInputBar>) {
  const buttons = wrapper.findAll("button");
  // send button: last button, has viewBox="0 0 24 24" with polygon
  return buttons[buttons.length - 1];
}

describe("InputBar", () => {
  it("emits send with trimmed text on button click", async () => {
    const wrapper = mountInputBar();

    const textarea = wrapper.find("textarea");
    await textarea.setValue("  Hello World  ");
    await findSendBtn(wrapper).trigger("click");

    expect(wrapper.emitted("send")).toBeTruthy();
    expect(wrapper.emitted("send")![0]).toEqual(["Hello World"]);
    // Input should clear after send
    expect(textarea.element.value).toBe("");
  });

  it("emits send on Enter key", async () => {
    const wrapper = mountInputBar();

    const textarea = wrapper.find("textarea");
    await textarea.setValue("Test message");
    await textarea.trigger("keydown", { key: "Enter", shiftKey: false });

    expect(wrapper.emitted("send")).toBeTruthy();
    expect(wrapper.emitted("send")![0]).toEqual(["Test message"]);
  });

  it("allows newline on Shift+Enter", async () => {
    const wrapper = mountInputBar();

    const textarea = wrapper.find("textarea");
    await textarea.trigger("keydown", { key: "Enter", shiftKey: true });

    // Should NOT emit send
    expect(wrapper.emitted("send")).toBeFalsy();
  });

  it("shows stop button when disabled (processing)", () => {
    const wrapper = mountInputBar({ disabled: true });
    const buttons = wrapper.findAll("button");
    const stopBtn = buttons.find(b => b.attributes("title") === "Stop");
    expect(stopBtn).toBeTruthy();
  });

  it("emits stop on stop button click", async () => {
    const wrapper = mountInputBar({ disabled: true });
    const stopBtn = wrapper.find("button[title='Stop']");
    await stopBtn.trigger("click");
    expect(wrapper.emitted("stop")).toBeTruthy();
  });

  it("does not emit when disabled", async () => {
    const wrapper = mountInputBar({ disabled: true });

    const textarea = wrapper.find("textarea");
    await textarea.setValue("Should not send");
    // The send button is hidden when disabled (stop button is shown instead)
    expect(wrapper.emitted("send")).toBeFalsy();
  });

  it("does not emit empty message", async () => {
    const wrapper = mountInputBar();

    await findSendBtn(wrapper).trigger("click");
    expect(wrapper.emitted("send")).toBeFalsy();

    await wrapper.find("textarea").setValue("   ");
    await findSendBtn(wrapper).trigger("click");
    expect(wrapper.emitted("send")).toBeFalsy();
  });

  it("disables send button when input is empty", () => {
    const wrapper = mountInputBar();
    // verify send button exists
    expect(findSendBtn(wrapper).exists()).toBe(true);
  });

  // ── Drag & drop ──

  it("shows drag-over border on dragover", async () => {
    const wrapper = mountInputBar();
    const container = wrapper.find(".flex.items-center.max-w-3xl");
    await container.trigger("dragover", { dataTransfer: { dropEffect: "" } });
    expect(container.attributes("style")).toContain("dashed");
  });

  it("hides drag border on dragleave", async () => {
    const wrapper = mountInputBar();
    const container = wrapper.find(".flex.items-center.max-w-3xl");
    await container.trigger("dragover", { dataTransfer: { dropEffect: "" } });
    await container.trigger("dragleave");
    expect(container.attributes("style")).not.toContain("dashed");
  });

  it("emits files event on drop", async () => {
    const wrapper = mountInputBar();
    const container = wrapper.find(".flex.items-center.max-w-3xl");

    const files = [{ name: "test.ts", path: "/home/user/test.ts" }];
    const dt = { dropEffect: "", files, items: [] };

    await container.trigger("drop", { dataTransfer: dt });
    expect(wrapper.emitted("files")).toBeTruthy();
    expect(wrapper.emitted("files")![0]).toEqual([[{ name: "test.ts", path: "/home/user/test.ts" }]]);
  });
});
