// V2Badge 状态胶囊测试：conflict 颜色 class + title（原生 tooltip）+ 点击 emit('open')
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import V2Badge from "./V2Badge.vue";

// V2Badge 模板使用 $t（title tooltip）——测试需 i18n plugin
const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      v2: {
        v2Available: "V2 service available",
        v2Conflict: "V2 service unavailable (port 8800 in use)",
      },
    },
  },
});

function mountBadge(conflict: boolean) {
  return mount(V2Badge, {
    props: { conflict },
    global: { plugins: [i18n] },
  });
}

describe("V2Badge", () => {
  it("conflict=false → accent 态（无 --conflict class），title 显示「V2 服务可用」", () => {
    const wrapper = mountBadge(false);
    const btn = wrapper.find(".v2-badge");
    expect(btn.exists()).toBe(true);
    expect(btn.classes()).not.toContain("v2-badge--conflict");
    expect(btn.text()).toBe("V2");
    expect(btn.attributes("title")).toBe("V2 service available");
  });

  it("conflict=true → coral 冲突态（--conflict class），title 显示「V2 服务不可用（8800 被占用）」", () => {
    const wrapper = mountBadge(true);
    const btn = wrapper.find(".v2-badge");
    expect(btn.classes()).toContain("v2-badge--conflict");
    expect(btn.attributes("title")).toBe("V2 service unavailable (port 8800 in use)");
  });

  it("点击 → emit('open')（AppShell 打开 V2Dialog）", async () => {
    const wrapper = mountBadge(true);
    await wrapper.find(".v2-badge").trigger("click");
    expect(wrapper.emitted("open")).toHaveLength(1);
  });
});
