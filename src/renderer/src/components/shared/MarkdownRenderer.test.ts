import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import MarkdownRenderer from "./MarkdownRenderer.vue";

// ── Helpers ──

function rendered(md: string) {
  return mount(MarkdownRenderer, { props: { content: md } });
}

/** Check that every word in the list appears in the rendered output */
function expectAllWords(md: string, words: string[]) {
  const text = rendered(md).text();
  for (const w of words) expect(text).toContain(w);
}

// ═══════════════════════════════════════════════════════════
// Content-preservation tests — one per markdown feature type
// ═══════════════════════════════════════════════════════════

describe("MarkdownRenderer", () => {
  // ─── Headers ───
  describe("headers", () => {
    it("renders h1/h2/h3 with correct text", () => {
      expectAllWords("# Title", ["Title"]);
      expectAllWords("## Section", ["Section"]);
      expectAllWords("### Sub", ["Sub"]);
    });

    it("generates correct HTML tags with id anchors", () => {
      const h1 = rendered("# H").html();
      expect(h1).toContain("<h1");
      expect(h1).toContain('id="h"');
      expect(rendered("## H").html()).toContain("<h2");
      expect(rendered("### H").html()).toContain("<h3");
    });

    it("preserves inline formatting inside headers", () => {
      const html = rendered("## **bold** and `code`").html();
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("<code>code</code>");
      expect(html).not.toContain("$1");
    });
  });

  // ─── Bold / Italic ───
  describe("bold & italic", () => {
    it("renders bold", () => {
      expect(rendered("**bold**").html()).toContain("<strong>bold</strong>");
    });

    it("renders italic", () => {
      expect(rendered("*italic*").html()).toContain("<em>italic</em>");
    });

    it("renders mixed bold+italic", () => {
      const html = rendered("***bold-italic***").html();
      expect(html).toContain("<strong>");
      expect(html).toContain("<em>");
    });

    it("preserves literal asterisks in text (not markdown)", () => {
      const text = rendered("3 * 4 = 12").text();
      expect(text).toContain("3 * 4 = 12");
    });
  });

  // ─── Inline Code ───
  describe("inline code", () => {
    it("wraps in <code>", () => {
      expect(rendered("use `const x = 1`").html()).toContain("<code>const x = 1</code>");
    });

    it("does not lose content with special chars", () => {
      expectAllWords("`<div>$2</div>`", ["<div>$2</div>"]);
    });

    it("handles multiple inline code spans in one line", () => {
      const html = rendered("run `npm test` then `npm build`").html();
      expect(html).toContain("<code>npm test</code>");
      expect(html).toContain("<code>npm build</code>");
    });
  });

  // ─── Fenced Code Blocks ───
  describe("fenced code blocks", () => {
    it("renders with language class", () => {
      const html = rendered("```ts\nconst x = 1;\n```").html();
      expect(html).toContain("<pre>");
      expect(html).toContain("language-ts");
      expect(html).toContain("const x = 1;");
    });

    it("preserves $N and backticks inside (no inline replacement)", () => {
      const pre = rendered("```\n$x = $2\n`backtick`\n```").find("pre");
      expect(pre.text()).toContain("$2");
      expect(pre.text()).toContain("`backtick`");
    });

    it("preserves **bold** markers (not converted)", () => {
      const pre = rendered("```\n**keep as-is**\n```").find("pre");
      expect(pre.html()).not.toContain("<strong>");
      expect(pre.text()).toContain("**keep as-is**");
    });

    it("preserves [links](url) markers (not converted)", () => {
      const pre = rendered("```\n[text](http://x.com)\n```").find("pre");
      expect(pre.html()).not.toContain("<a href");
      expect(pre.text()).toContain("[text](http://x.com)");
    });

    it("preserves * and # and - markers (not converted)", () => {
      const pre = rendered("```\n# not a header\n* not italic\n- not a list\n```").find("pre");
      const text = pre.text();
      expect(text).toContain("# not a header");
      expect(text).toContain("* not italic");
      expect(text).toContain("- not a list");
    });

    it("empty code block", () => {
      expect(rendered("```\n```").html()).toContain("<pre>");
    });
  });

  // ─── Unordered Lists ───
  describe("unordered lists", () => {
    it("wraps items in <ul>", () => {
      const html = rendered("- one\n- two").html();
      expect(html).toContain("<ul>");
      expect(html).toContain("</ul>");
      expect(rendered("- one\n- two").findAll("ul li")).toHaveLength(2);
    });

    it("preserves inline formatting in list items", () => {
      const html = rendered("- **bold**\n- `code`\n- *italic*").html();
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("<code>code</code>");
      expect(html).toContain("<em>italic</em>");
    });

    it("single item gets <ul> wrapper", () => {
      expect(rendered("- only one").html()).toContain("<ul>");
    });

    it("stops list at blank line", () => {
      const html = rendered("- item\n\nnot list").html();
      expect(html).not.toContain("not list</li>");
    });
  });

  // ─── Ordered Lists ───
  describe("ordered lists", () => {
    it("renders items with correct content (no $2 regression)", () => {
      const text = rendered("1. first\n2. second\n3. third").text();
      expect(text).toContain("first");
      expect(text).toContain("second");
      expect(text).toContain("third");
      expect(text).not.toContain("$1");
      expect(text).not.toContain("$2");
    });

    it("wraps items in <ol>", () => {
      const html = rendered("1. a\n2. b").html();
      expect(html).toContain("<ol>");
      expect(html).toContain("</ol>");
      expect(rendered("1. a\n2. b").findAll("ol li")).toHaveLength(2);
    });

    it("preserves inline formatting", () => {
      const html = rendered("1. **bold**\n2. `code`\n3. *italic*").html();
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("<code>code</code>");
      expect(html).toContain("<em>italic</em>");
    });

    it("real session content — 5 items, no artifacts", () => {
      const content = `## 关键观察

1. **API 后端** 指向 DeepSeek 的 Anthropic 兼容 API
2. **所有模型** 统一使用 deepseek-v4-pro
3. **权限模式** 为 auto
4. **PostToolUse Hook** 在每次写文件后自动执行 npm test
5. 代理设置为本地 127.0.0.1:7897`;
      const wrapper = rendered(content);
      expect(wrapper.findAll("ol li")).toHaveLength(5);
      for (const w of ["API 后端", "所有模型", "权限模式", "PostToolUse", "代理设置"]) {
        expect(wrapper.text()).toContain(w);
      }
      expect(wrapper.text()).not.toContain("$2");
    });
  });

  // ─── Blockquotes ───
  describe("blockquotes", () => {
    it("renders with correct text", () => {
      expect(rendered("> quoted text").html()).toContain("<blockquote>");
      expect(rendered("> quoted text").text()).toContain("quoted text");
    });

    it("preserves inline formatting", () => {
      const html = rendered("> **bold** and `code`").html();
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("<code>code</code>");
    });
  });

  // ─── Horizontal Rules ───
  describe("horizontal rules", () => {
    it("renders <hr>", () => {
      expect(rendered("---").html()).toContain("<hr>");
    });

    it("does not lose surrounding text", () => {
      const text = rendered("above\n---\nbelow").text();
      expect(text).toContain("above");
      expect(text).toContain("below");
    });
  });

  // ─── Tables ───
  describe("tables", () => {
    it("renders complete HTML structure", () => {
      const html = rendered("| A | B |\n|---|---|\n| 1 | 2 |").html();
      expect(html).toContain("<table>");
      expect(html).toContain("<thead>");
      expect(html).toContain("<tbody>");
      expect(html).toContain("<th");      // may have style attr
      expect(html).toContain("<td");
    });

    it("preserves all cell content", () => {
      const text = rendered("| Name | Value |\n|------|-------|\n| foo  | bar   |").text();
      expect(text).toContain("Name");
      expect(text).toContain("Value");
      expect(text).toContain("foo");
      expect(text).toContain("bar");
    });

    it("handles alignment columns", () => {
      const html = rendered("| L | C | R |\n|:--|:-:|--:|\n| a | b | c |").html();
      expect(html).toContain('align="left"');
      expect(html).toContain('align="center"');
      expect(html).toContain('align="right"');
    });

    it("table with inline formatting in cells", () => {
      const html = rendered("| A |\n|---|\n| **bold** |").html();
      expect(html).toContain("<strong>bold</strong>");
    });
  });

  // ─── Links ───
  describe("links", () => {
    it("renders with correct href and text", () => {
      const html = rendered("[click](https://x.com)").html();
      expect(html).toContain('href="https://x.com"');
      expect(html).toContain(">click<");
    });

    it("handles URL with special chars like underscores", () => {
      expect(rendered("[a](https://x.com/foo_bar)").html()).toContain("foo_bar");
    });

    it("handles multiple links in one line", () => {
      const html = rendered("[a](http://a.com) and [b](http://b.com)").html();
      expect(html).toContain('href="http://a.com"');
      expect(html).toContain('href="http://b.com"');
    });
  });

  // ─── XSS / HTML Escaping ───
  describe("security", () => {
    it("escapes <script> tags", () => {
      const html = rendered("<script>alert('xss')</script>").html();
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
    });

    it("escapes HTML in inline code", () => {
      const html = rendered("`<img src=x onerror=alert(1)>`").html();
      expect(html).toContain("&lt;img");
      expect(html).not.toContain("<img");
    });
  });

  // ─── Regex-safety edge cases ───
  describe("regex safety", () => {
    it("preserves $1 $2 $3 ... $9 as literal text", () => {
      const text = rendered("prices: $1 $2 $3 $4 $5 $6 $7 $8 $9").text();
      for (let i = 1; i <= 9; i++) expect(text).toContain("$" + i);
    });

    it("preserves backslash characters", () => {
      const text = rendered("C:\\\\Users\\\\Max").text();
      expect(text).toContain("C:");
      expect(text).toContain("Users");
      expect(text).toContain("Max");
    });

    it("preserves regex-like patterns in text", () => {
      const text = rendered("/^\\d+\\. (.+)$/gm").text();
      expect(text).toContain("/^\\d+");
    });

    it("preserves pipe characters in text (not tables)", () => {
      const text = rendered("a | b | c").text();
      expect(text).toContain("a");
      expect(text).toContain("b");
      expect(text).toContain("c");
    });
  });

  // ─── CJK / Unicode ───
  describe("unicode", () => {
    it("preserves Chinese characters", () => {
      expect(rendered("你好世界").text()).toContain("你好世界");
    });

    it("preserves emoji", () => {
      expect(rendered("✅ done").text()).toContain("✅");
    });

    it("mixed CJK + markdown formatting", () => {
      const html = rendered("**中文粗体** and `日文コード`").html();
      expect(html).toContain("<strong>中文粗体</strong>");
      expect(html).toContain("<code>日文コード</code>");
    });
  });

  // ─── Edge cases ───
  describe("edge cases", () => {
    it("empty string renders container", () => {
      expect(rendered("").find(".markdown-body").exists()).toBe(true);
    });

    it("single newline does not break paragraphs", () => {
      const html = rendered("line1\nline2").html();
      // Should appear as one paragraph
      expect(html).toContain("line1");
      expect(html).toContain("line2");
    });

    it("text starting with markdown-sensitive chars", () => {
      expectAllWords("-5 degrees is cold", ["-5 degrees is cold"]);
    });

    it("number followed by dot but NOT a list (e.g., version numbers)", () => {
      // "1.0.0" starts with "1." which is ambiguous
      const text = rendered("1.0.0 is a version").text();
      expect(text).toContain("1.0.0");
      expect(text).not.toContain("$1");
    });
  });

  // ─── Integration: mixed content ───
  describe("mixed content", () => {
    it("renders document with headers, lists, code, table, links", () => {
      const md = `## Summary

Here is some **bold** text and \`inline code\`.

- item 1
- item 2

| Key | Value |
|-----|-------|
| foo | bar   |

More text with a [link](https://example.com).

\`\`\`
code block here
\`\`\`

> final quote`;

      const wrapper = rendered(md);
      const html = wrapper.html();
      const text = wrapper.text();

      // Structure
      expect(html).toContain("<h2");
      expect(html).toContain("<ul>");
      expect(html).toContain("<table>");
      expect(html).toContain("<pre>");
      expect(html).toContain("<blockquote>");
      expect(html).toContain("<a href");

      // Content
      for (const w of ["Summary", "bold", "inline code", "item 1", "item 2",
                        "Key", "Value", "foo", "bar", "link", "code block here", "final quote"]) {
        expect(text).toContain(w);
      }

      // No artifacts
      expect(text).not.toContain("$1");
      expect(text).not.toContain("$2");
    });
  });
});
