import { describe, it, expect } from "vitest";
import { formatNum, formatTokenCount, translateError } from "./utils";

describe("formatNum", () => {
  it("returns string for small numbers", () => {
    expect(formatNum(0)).toBe("0");
    expect(formatNum(999)).toBe("999");
  });

  it("adds K suffix for thousands", () => {
    expect(formatNum(1000)).toBe("1.0K");
    expect(formatNum(1500)).toBe("1.5K");
    expect(formatNum(999_999)).toBe("1000.0K");
  });

  it("adds M suffix for millions", () => {
    expect(formatNum(1_000_000)).toBe("1.0M");
    expect(formatNum(2_500_000)).toBe("2.5M");
  });
});

describe("formatTokenCount", () => {
  it("appends ' tok' suffix", () => {
    expect(formatTokenCount(500)).toBe("500 tok");
    expect(formatTokenCount(1500)).toBe("1.5K tok");
  });
});

describe("translateError", () => {
  it("detects Claude CLI not found", () => {
    expect(translateError("Is Claude Code CLI installed?").key).toBe("error.claudeNotFound");
    expect(translateError("program not found").key).toBe("error.claudeNotFound");
  });

  it("detects file read errors", () => {
    const r = translateError("Failed to read 'foo.txt'");
    expect(r.key).toBe("error.fileReadError");
    expect(r.params?.error).toContain("foo.txt");
  });

  it("detects file write / permission errors", () => {
    expect(translateError("Failed to write").key).toBe("error.fileWriteError");
    expect(translateError("Permission denied").key).toBe("error.fileWriteError");
  });

  it("detects spawn / process errors", () => {
    expect(translateError("Failed to spawn process").key).toBe("error.spawnFailed");
    expect(translateError("stdin write error").key).toBe("error.spawnFailed");
  });

  it("detects HTTP / network errors", () => {
    expect(translateError("HTTP error 500").key).toBe("error.httpError");
    expect(translateError("Connection refused").key).toBe("error.httpError");
    expect(translateError("timeout").key).toBe("error.httpError");
  });

  it("detects session not found", () => {
    expect(translateError("Session not found").key).toBe("error.sessionNotFound");
  });

  it("falls back to generic for unrecognized errors", () => {
    expect(translateError("Something weird happened").key).toBe("error.generic");
  });

  it("handles non-string input", () => {
    expect(translateError(null).key).toBe("error.generic");
    expect(translateError(undefined).key).toBe("error.generic");
    expect(translateError(404).key).toBe("error.generic");
  });

  it("case-insensitive matching", () => {
    expect(translateError("FAILED TO READ").key).toBe("error.fileReadError");
    expect(translateError("Http Error").key).toBe("error.httpError");
  });
});
