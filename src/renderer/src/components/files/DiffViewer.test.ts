import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DiffViewer from "./DiffViewer.vue";

describe("DiffViewer", () => {
  it("renders empty state when both strings empty", () => {
    const wrapper = mount(DiffViewer, {
      props: { oldStr: "", newStr: "" },
    });
    expect(wrapper.text()).toContain("No diff to display");
    expect(wrapper.findAll("[style*='border-left']").length).toBe(0);
  });

  it("shows added lines in accent color", () => {
    const wrapper = mount(DiffViewer, {
      props: { oldStr: "", newStr: "new line" },
    });
    const lines = wrapper.findAll("[style*='border-left']");
    expect(lines.length).toBe(1);
    const line = lines[0];
    expect(line.text()).toContain("+new line");
    expect(line.attributes("style")).toContain("var(--accent)");
  });

  it("shows removed lines in coral color", () => {
    const wrapper = mount(DiffViewer, {
      props: { oldStr: "old line", newStr: "" },
    });
    const lines = wrapper.findAll("[style*='border-left']");
    expect(lines.length).toBe(1);
    const line = lines[0];
    expect(line.text()).toContain("-old line");
    expect(line.attributes("style")).toContain("var(--coral)");
  });

  it("shows unmodified lines without color markers", () => {
    const wrapper = mount(DiffViewer, {
      props: { oldStr: "same line", newStr: "same line" },
    });
    const text = wrapper.text();
    // 无差异，不出现 +/- 前缀
    expect(text).not.toContain("+same line");
    expect(text).not.toContain("-same line");
    expect(text).toContain("same line");
  });

  it("handles multi-line diff", () => {
    const wrapper = mount(DiffViewer, {
      props: {
        oldStr: "line1\nline2\nline3",
        newStr: "line1\nline2 modified\nline3",
      },
    });
    const lines = wrapper.findAll("[style*='border-left']");
    // 至少 1 行删除 + 1 行新增
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const text = wrapper.text();
    expect(text).toContain("-line2");
    expect(text).toContain("+line2 modified");
  });

  it("renders line numbers for added/removed lines", () => {
    const wrapper = mount(DiffViewer, {
      props: { oldStr: "", newStr: "a\nb\nc" },
    });
    // All 3 lines are added, each should have a line number
    const nums = wrapper.findAll("span").filter((s) => /^\d+$/.test(s.text().trim()));
    expect(nums.length).toBe(3);
  });
});
