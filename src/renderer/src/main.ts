import { createApp } from "vue";
import { createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import App from "./App.vue";
import router from "./router";
import "./assets/main.css";
import zh from "./locales/zh.json";
import en from "./locales/en.json";
import { debugLog } from "./lib/electron-bridge";

/** 序列化 console 参数为单行文本：字符串原样、Error 用 stack、对象 JSON（循环引用兜底 String） */
function serializeArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/** 渲染层 console 桥：保留原生输出（DevTools 控制台可见），同时单向上报主进程——
 * 调试模式（--debug 启动 / FRACTAL_DEBUG / OC_GUI_DEBUG）落盘 userData/logs/renderer.log，
 * 正式版用户复现问题后可直接取日志文件，无需 DevTools 操作 */
function installConsoleBridge(): void {
  const levels = ["log", "warn", "error", "debug", "info"] as const;
  for (const level of levels) {
    const orig = (console[level] ?? console.log).bind(console);
    console[level] = (...args: unknown[]) => {
      if (orig) orig(...args);
      try {
        debugLog(level, args.map(serializeArg).join(" "));
      } catch {
        // 上报失败不干扰主流程（桥异常时 console 原样输出已保留）
      }
    };
  }
}
installConsoleBridge();

const i18n = createI18n({
  legacy: false,
  locale: "zh",
  fallbackLocale: "en",
  messages: { zh, en },
});

const pinia = createPinia();
const app = createApp(App);

app.use(pinia);
app.use(i18n);
app.use(router);
app.mount("#app");
