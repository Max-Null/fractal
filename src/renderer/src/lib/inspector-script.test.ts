import { describe, it, expect } from "vitest";
import { buildInspectorScript, resolveLinkTarget, isIgnorableHref } from "./inspector-script";

describe("buildInspectorScript", () => {
  it("检查模式开启（true）时脚本初始化 window.__inspectEnabled=true", () => {
    const s = buildInspectorScript(true);
    expect(s).toContain("window.__inspectEnabled=true");
  });

  it("检查模式关闭（false）时脚本初始化 window.__inspectEnabled=false", () => {
    const s = buildInspectorScript(false);
    expect(s).toContain("window.__inspectEnabled=false");
  });

  it("保留运行时切换消息监听（set-inspect-enabled 仍可动态切换）", () => {
    const s = buildInspectorScript(false);
    expect(s).toContain("set-inspect-enabled");
    expect(s).toContain("window.__inspectEnabled=!!ev.data.enabled");
  });

  it("输出为完整 <script> 标签，可注入 <body> 后", () => {
    const s = buildInspectorScript(true);
    expect(s.startsWith("<script>")).toBe(true);
    expect(s.endsWith("</script>")).toBe(true);
  });
});

describe("链接点击拦截（防 iframe 导航白屏，2026-08-12）", () => {
  it("检查模式关闭时脚本包含链接拦截逻辑与 link-click 上报", () => {
    const s = buildInspectorScript(false);
    expect(s).toContain("closest('a[href]')");
    expect(s).toContain("link-click");
  });

  it("页面内锚点（# 开头）链接放行默认行为（同文档滚动）", () => {
    const s = buildInspectorScript(false);
    expect(s).toContain("href.charAt(0)==='#'");
  });

  it("检查模式开启时链接拦截不生效（保持 DOM 选择）", () => {
    const s = buildInspectorScript(true);
    expect(s).toContain("link-click");
    // 开启模式走原 DOM 选择逻辑：preventDefault 紧随判断，链接分支仅关闭模式进入
    expect(s.indexOf("!window.__inspectEnabled")).toBeLessThan(s.indexOf("link-click"));
  });
});

describe("resolveLinkTarget（相对链接 → 本地绝对路径）", () => {
  it("同级相对路径（./ 前缀）", () => {
    expect(resolveLinkTarget("H:\\site", "./page2.html")).toBe("H:\\site\\page2.html");
  });

  it("上级目录（../ 归一化）", () => {
    expect(resolveLinkTarget("H:\\site\\sub", "../page2.html")).toBe("H:\\site\\page2.html");
  });

  it("去掉 query 与 hash", () => {
    expect(resolveLinkTarget("H:\\site", "page2.html?x=1#sec")).toBe("H:\\site\\page2.html");
  });

  it("协议相对 URL（//cdn）不解析", () => {
    expect(resolveLinkTarget("H:\\site", "//cdn.example.com/a.js")).toBe("");
  });
});

describe("isIgnorableHref（非导航协议过滤，2026-08-12 审查修复）", () => {
  it("javascript: 协议（占位链接）应忽略", () => {
    expect(isIgnorableHref("javascript:void(0)")).toBe(true);
  });

  it("data: / vbscript: 协议应忽略", () => {
    expect(isIgnorableHref("data:text/html,hi")).toBe(true);
    expect(isIgnorableHref("vbscript:msgbox(1)")).toBe(true);
  });

  it("正常链接不误伤", () => {
    expect(isIgnorableHref("https://example.com")).toBe(false);
    expect(isIgnorableHref("page2.html")).toBe(false);
    expect(isIgnorableHref("#top")).toBe(false);
  });
});
