// DiagnosticsModal 测试：classifyLogLine 纯函数（错误行高亮分类）+ 组件行为
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createI18n } from "vue-i18n";
import { nextTick } from "vue";
import { classifyLogLine, default as DiagnosticsModal } from "./DiagnosticsModal.vue";
import { useDebugLog } from "@/composables/useDebugLog";

// mock electron-bridge：只 mock 日志/信息读取，其余保留原模块
const { readServeLogMock, readRendererLogMock, getAppInfoMock } = vi.hoisted(() => ({
  readServeLogMock: vi.fn(),
  readRendererLogMock: vi.fn(),
  getAppInfoMock: vi.fn(),
}));
vi.mock("@/lib/electron-bridge", () => ({
  readServeLog: (...args: unknown[]) => readServeLogMock(...args),
  readRendererLog: (...args: unknown[]) => readRendererLogMock(...args),
  getAppInfo: (...args: unknown[]) => getAppInfoMock(...args),
  // 其他 bridge 成员测试不涉及——缺失会在组件 import 时暴露，按需补充
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

// 与 ChatPanel.test.ts 同款 en messages（诊断相关 keys 足够）
const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      chat: {
        debugTitle: "Diagnostics",
        debugLabel: "Event Log",
        debugServeTab: "Engine Log",
        debugRendererTab: "Console Log",
        debugNoServeLog: "No engine logs yet",
        debugNoRendererLog: "No console logs yet",
        debugRefresh: "Refresh",
        debugCopyDiag: "Copy Diagnostics",
        debugFooter: "Logs help troubleshooting",
        loading: "Loading",
        copy: "Copy",
        copied: "Copied",
      },
    },
  },
});

describe("classifyLogLine", () => {
  it("❌ 前缀 → error", () => {
    expect(classifyLogLine("❌ 模型调用失败")).toBe("error");
  });

  it("⚠️ 前缀 → warn", () => {
    expect(classifyLogLine("⚠️ 工具输入包含敏感字段")).toBe("warn");
  });

  it("普通行 → normal", () => {
    expect(classifyLogLine("🔌 engine status: running")).toBe("normal");
    expect(classifyLogLine("")).toBe("normal");
  });
});

describe("DiagnosticsModal 组件", () => {
  // 全局单例 debugLog：测试内直接写行，驱动事件日志渲染
  const debugLog = useDebugLog();
  let pinia: Pinia;
  let wrapper: VueWrapper;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    debugLog.setSession("test-session");
    debugLog.clear();
    vi.clearAllMocks();
  });

  async function mountModal() {
    wrapper = mount(DiagnosticsModal, {
      props: { open: true },
      global: { plugins: [pinia, i18n] },
    });
    await nextTick();
    return wrapper;
  }

  it("打开时渲染标题 + 三个标签页", async () => {
    await mountModal();
    expect(wrapper.text()).toContain("Diagnostics");
    expect(wrapper.text()).toContain("Event Log");
    expect(wrapper.text()).toContain("Engine Log");
    expect(wrapper.text()).toContain("Console Log");
  });

  it("事件日志逐行渲染并按前缀高亮（❌ error / ⚠️ warn / 普通 normal）", async () => {
    debugLog.add("❌ 模型调用失败");
    debugLog.add("普通信息行");
    await mountModal();
    debugLog.add("⚠️ 警告行");
    await nextTick();

    expect(wrapper.findAll(".diag-log-line--error").length).toBe(1);
    expect(wrapper.findAll(".diag-log-line--warn").length).toBe(1);
    expect(wrapper.findAll(".diag-log-line--normal").length).toBe(1);
    // 行数显示 = 事件日志当前行数（D8）
    expect(wrapper.find(".diag-count").text()).toBe("3");
  });

  it("切到引擎日志标签页 → readServeLog(500) 拉取并渲染", async () => {
    readServeLogMock.mockResolvedValue(["serve line 1", "serve line 2"]);
    await mountModal();

    const engineTab = wrapper.findAll(".diag-tab").find((b) => b.text() === "Engine Log");
    expect(engineTab).toBeTruthy();
    await engineTab!.trigger("click");
    await nextTick();

    expect(readServeLogMock).toHaveBeenCalledWith(500);
    expect(wrapper.text()).toContain("serve line 1");
    expect(wrapper.text()).toContain("serve line 2");
  });

  it("切到控制台标签页 → readRendererLog(500) 拉取并渲染", async () => {
    readRendererLogMock.mockResolvedValue(["renderer line"]);
    await mountModal();

    const consoleTab = wrapper.findAll(".diag-tab").find((b) => b.text() === "Console Log");
    await consoleTab!.trigger("click");
    await nextTick();

    expect(readRendererLogMock).toHaveBeenCalledWith(500);
    expect(wrapper.text()).toContain("renderer line");
  });

  it("复制当前标签页按钮 → execCommand copy + 状态提示", async () => {
    debugLog.add("❌ 错误行");
    debugLog.add("普通行");
    // 捕获 copyText 写入的 textarea 值（jsdom 无 execCommand，直接赋值；textarea 被移除前读取）
    const captured: string[] = [];
    const origExec = document.execCommand;
    document.execCommand = ((cmd: string) => {
      const ta = document.querySelector("textarea");
      captured.push(ta ? ta.value : "");
      return true;
    }) as typeof document.execCommand;
    try {
      await mountModal();

      // header 第一个按钮 = 复制当前标签页（Copy 图标）
      const copyBtn = wrapper.findAll(".diag-header-btn")[0];
      await copyBtn.trigger("click");

      expect(captured[0]).toBe("❌ 错误行\n普通行");
      // 复制状态反馈显示（footer status）
      expect(wrapper.find(".diag-footer-status").text()).toContain("Copied");
    } finally {
      document.execCommand = origExec;
    }
  });

  it("复制诊断信息按钮 → getAppInfo + readServeLog 打包", async () => {
    getAppInfoMock.mockResolvedValue({ name: "Fractal", version: "1.2.3" });
    readServeLogMock.mockResolvedValue(["diag line"]);
    const captured: string[] = [];
    const origExec = document.execCommand;
    document.execCommand = ((cmd: string) => {
      const ta = document.querySelector("textarea");
      captured.push(ta ? ta.value : "");
      return true;
    }) as typeof document.execCommand;
    try {
      await mountModal();

      const diagBtn = wrapper.findAll(".diag-header-btn")[1];
      await diagBtn.trigger("click");
      await nextTick();

      expect(getAppInfoMock).toHaveBeenCalled();
      expect(readServeLogMock).toHaveBeenCalledWith(500);
      expect(captured[0]).toBe("Fractal v1.2.3\n\ndiag line");
      expect(wrapper.find(".diag-footer-status").text()).toContain("Copied");
    } finally {
      document.execCommand = origExec;
    }
  });

  it("关闭 → 向父级 emit close", async () => {
    await mountModal();
    const shell = wrapper.findComponent({ name: "ModalShell" });
    shell.vm.$emit("close");
    await nextTick();
    expect(wrapper.emitted("close")).toBeTruthy();
  });
});
