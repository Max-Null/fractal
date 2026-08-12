// ConfirmDialog 组件测试：确认/取消事件、标题/消息/按钮文案渲染、danger 模式
import { describe, it, expect, afterEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import ConfirmDialog from "./ConfirmDialog.vue";

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: { en: { modal: { close: "Close", confirm: "Confirm", cancel: "Cancel" } } },
});

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(ConfirmDialog, {
    props: { open: true, title: "T", message: "M", ...props },
    global: {
      plugins: [i18n],
      stubs: { Teleport: { template: "<div><slot /></div>" } },
    },
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ConfirmDialog", () => {
  it("渲染标题与消息（title/message prop）", () => {
    const wrapper = mountDialog();
    expect(wrapper.text()).toContain("T");
    expect(wrapper.text()).toContain("M");
  });

  it("确认按钮 → emit confirm", async () => {
    const wrapper = mountDialog();
    const confirmBtn = wrapper.findAll("button").find(b => b.text() === "Confirm");
    expect(confirmBtn).toBeTruthy();
    await confirmBtn!.trigger("click");
    expect(wrapper.emitted("confirm")).toHaveLength(1);
  });

  it("取消按钮 → emit cancel", async () => {
    const wrapper = mountDialog();
    const cancelBtn = wrapper.findAll("button").find(b => b.text() === "Cancel");
    expect(cancelBtn).toBeTruthy();
    await cancelBtn!.trigger("click");
    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });

  it("自定义 confirmText/cancelText 覆盖默认文案", () => {
    const wrapper = mountDialog({ confirmText: "OK", cancelText: "Nope" });
    expect(wrapper.text()).toContain("OK");
    expect(wrapper.text()).toContain("Nope");
  });

  it("open=false 时不渲染内容（ModalShell v-if 控制）", () => {
    const wrapper = mount(ConfirmDialog, {
      props: { open: false, title: "T", message: "M" },
      global: { plugins: [i18n], stubs: { Teleport: { template: "<div><slot /></div>" } } },
    });
    expect(wrapper.text()).not.toContain("M");
  });

  it("danger 模式：确认按钮带危险类（coral 底）", () => {
    const wrapper = mountDialog({ danger: true });
    const confirmBtn = wrapper.findAll("button").find(b => b.text() === "Confirm") as VueWrapper["element"] | undefined;
    // danger class 挂在内层 button 上——通过组件实例的 class 断言
    const btnEl = wrapper.find(".confirm-dialog-btn--danger");
    expect(btnEl.exists()).toBe(true);
  });
});
