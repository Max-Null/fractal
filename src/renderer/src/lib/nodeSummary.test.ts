// nodeSummary 纯函数测试（D10 梗概 / D18 子智能体图标与色板）
import { describe, it, expect } from "vitest";
import { toolSummary, thinkingSummary, agentChar, agentColor } from "./nodeSummary";

describe("toolSummary（D10 工具梗概）", () => {
  it("read：文件路径首行", () => {
    expect(toolSummary("Read", { file_path: "src/main.ts" })).toBe("src/main.ts");
    // 大写/小写工具名均识别（serve 发小写，历史数据可能存大写）
    expect(toolSummary("read", { file_path: "a.ts" })).toBe("a.ts");
  });

  it("read：多行路径取首行，超 60 字符截断", () => {
    const long = "x".repeat(100);
    expect(toolSummary("Read", { file_path: `${long}\n第二行` })).toBe(long.slice(0, 60));
    expect(toolSummary("Read", { file_path: "a.ts\nb.ts" })).toBe("a.ts");
  });

  it("edit：文件路径首行（filePath 驼峰字段兜底）", () => {
    expect(toolSummary("Edit", { file_path: "src/lib/utils.ts" })).toBe("src/lib/utils.ts");
    expect(toolSummary("edit", { filePath: "src/lib/utils.ts" })).toBe("src/lib/utils.ts");
  });

  it("bash：命令首行", () => {
    expect(toolSummary("Bash", { command: "npm run test" })).toBe("npm run test");
    expect(toolSummary("bash", { command: "git status\n# 长输出" })).toBe("git status");
  });

  it("websearch：查询词", () => {
    expect(toolSummary("WebSearch", { query: "DeepSeek 官方文档" })).toBe("DeepSeek 官方文档");
    expect(toolSummary("websearch", "纯字符串输入")).toBe("纯字符串输入");
  });

  it("compress：固定文案", () => {
    expect(toolSummary("Compress", {})).toBe("已压缩历史消息（保留最近 N 轮）");
  });

  it("glob：patterns 数组首项优先，pattern 单值兜底", () => {
    expect(toolSummary("Glob", { patterns: ["src/**/*.ts", "lib/**/*.ts"] })).toBe("src/**/*.ts");
    expect(toolSummary("glob", { pattern: "*.vue" })).toBe("*.vue");
    expect(toolSummary("glob", { patterns: [] })).toBe("");
    expect(toolSummary("glob", {})).toBe("");
  });

  it("list：path 首行", () => {
    expect(toolSummary("List", { path: "src/renderer/src" })).toBe("src/renderer/src");
    expect(toolSummary("list", { path: "src\n其他" })).toBe("src");
  });

  it("todowrite：进行中任务优先，无则取首项", () => {
    const input = {
      todos: [
        { content: "任务一", status: "completed" },
        { content: "任务二", status: "in_progress" },
        { content: "任务三", status: "pending" },
      ],
    };
    expect(toolSummary("TodoWrite", input)).toBe("正在：任务二");
    expect(toolSummary("todowrite", { todos: [{ content: "唯一任务", status: "pending" }] })).toBe("正在：唯一任务");
    expect(toolSummary("TodoWrite", { todos: [] })).toBe("正在：");
    expect(toolSummary("TodoWrite", {})).toBe("正在：");
  });

  it("未知工具 → 空串", () => {
    expect(toolSummary("SomeRandomTool", {})).toBe("");
    expect(toolSummary("task", {})).toBe(""); // task 由 subtask 节点代替，不走 toolSummary
  });

  it("input 为 null/undefined 不崩溃", () => {
    expect(toolSummary("Read", undefined)).toBe("");
    expect(toolSummary("Bash", null)).toBe("");
  });
});

describe("thinkingSummary（D10 思考梗概）", () => {
  it("前 60 字符", () => {
    expect(thinkingSummary("短思考")).toBe("短思考");
    const long = "x".repeat(80);
    expect(thinkingSummary(long)).toBe(long.slice(0, 60));
  });
});

describe("agentChar / agentColor（D18 子智能体图标与色板）", () => {
  it("agentChar：角色标识字（参谋→谋，非首字参）", () => {
    expect(agentChar("侦查兵")).toBe("侦");
    expect(agentChar("工匠")).toBe("工");
    expect(agentChar("参谋")).toBe("谋");
    expect(agentChar("军师")).toBe("军");
    expect(agentChar("制图师")).toBe("制");
    expect(agentChar("助理")).toBe("助");
  });

  it("agentChar：带 agent type 前缀也能匹配", () => {
    expect(agentChar("pr-review-toolkit:侦查兵")).toBe("侦");
  });

  it("agentChar：未知角色/空名 → '?'", () => {
    expect(agentChar("code-simplifier")).toBe("?");
    expect(agentChar("导师")).toBe("?"); // 导师不在 6 角色色板
    expect(agentChar("")).toBe("?");
    expect(agentChar(undefined as unknown as string)).toBe("?");
    expect(agentChar("  ")).toBe("?");
  });

  it("agentColor：6 角色色板", () => {
    expect(agentColor("侦查兵")).toBe("#7c3aed");
    expect(agentColor("工匠")).toBe("#2563eb");
    expect(agentColor("参谋")).toBe("#0d9488");
    expect(agentColor("军师")).toBe("#9333ea");
    expect(agentColor("制图师")).toBe("#0891b2");
    expect(agentColor("助理")).toBe("#4f46e5");
  });

  it("agentColor：未知角色/空名 → 紫兜底", () => {
    expect(agentColor("导师")).toBe("#7c3aed"); // 导师不在 6 角色色板 → 兜底紫
    expect(agentColor("")).toBe("#7c3aed");
  });
});
