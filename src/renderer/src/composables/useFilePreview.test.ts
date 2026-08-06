import { describe, it, expect, vi, beforeEach } from "vitest";
import { isImageFile, mimeType } from "./useFilePreview";

// ── Mock tauri-bridge（useFilePreview composable 内部依赖 readFileBase64）──
const { mockReadFileBase64 } = vi.hoisted(() => ({
  mockReadFileBase64: vi.fn(),
}));

vi.mock("@/lib/electron-bridge", () => ({
  readFileBase64: mockReadFileBase64,
}));

describe("isImageFile", () => {
  it("recognizes common image extensions", () => {
    expect(isImageFile("photo.png")).toBe(true);
    expect(isImageFile("photo.jpg")).toBe(true);
    expect(isImageFile("photo.jpeg")).toBe(true);
    expect(isImageFile("photo.gif")).toBe(true);
    expect(isImageFile("photo.webp")).toBe(true);
    expect(isImageFile("photo.svg")).toBe(true);
    expect(isImageFile("photo.bmp")).toBe(true);
    expect(isImageFile("photo.ico")).toBe(true);
  });

  it("rejects non-image files", () => {
    expect(isImageFile("doc.pdf")).toBe(false);
    expect(isImageFile("script.ts")).toBe(false);
    expect(isImageFile("readme.md")).toBe(false);
    expect(isImageFile("data.json")).toBe(false);
  });

  it("case insensitive", () => {
    expect(isImageFile("PHOTO.PNG")).toBe(true);
    expect(isImageFile("Photo.Jpg")).toBe(true);
  });

  it("handles no extension", () => {
    expect(isImageFile("README")).toBe(false);
    expect(isImageFile("Makefile")).toBe(false);
  });
});

describe("mimeType", () => {
  it("returns correct MIME types", () => {
    expect(mimeType("a.png")).toBe("image/png");
    expect(mimeType("a.jpg")).toBe("image/jpeg");
    expect(mimeType("a.jpeg")).toBe("image/jpeg");
    expect(mimeType("a.gif")).toBe("image/gif");
    expect(mimeType("a.webp")).toBe("image/webp");
    expect(mimeType("a.svg")).toBe("image/svg+xml");
    expect(mimeType("a.bmp")).toBe("image/bmp");
    expect(mimeType("a.ico")).toBe("image/x-icon");
  });

  it("defaults to image/png for unknown extensions", () => {
    expect(mimeType("a.txt")).toBe("image/png");
    expect(mimeType("README")).toBe("image/png");
  });
});

// ── Composable tests ──
import { useFilePreview } from "./useFilePreview";

describe("useFilePreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getThumbnail returns null for non-image files", async () => {
    const { getThumbnail } = useFilePreview();
    const result = await getThumbnail("/path/to/readme.md", "readme.md");
    expect(result).toBeNull();
    expect(mockReadFileBase64).not.toHaveBeenCalled();
  });

  it("getThumbnail fetches base64 for image and returns data URI", async () => {
    mockReadFileBase64.mockResolvedValueOnce("abc123");
    const { getThumbnail } = useFilePreview();
    const result = await getThumbnail("/path/to/photo.png", "photo.png");
    expect(result).toBe("data:image/png;base64,abc123");
    expect(mockReadFileBase64).toHaveBeenCalledWith("/path/to/photo.png");
  });

  it("getThumbnail caches result and does not re-fetch", async () => {
    mockReadFileBase64.mockResolvedValueOnce("xyz");
    const { getThumbnail } = useFilePreview();

    const r1 = await getThumbnail("/path/to/img.jpg", "img.jpg");
    expect(r1).toBe("data:image/jpeg;base64,xyz");
    expect(mockReadFileBase64).toHaveBeenCalledTimes(1);

    // Second call: cached, no re-fetch
    const r2 = await getThumbnail("/path/to/img.jpg", "img.jpg");
    expect(r2).toBe("data:image/jpeg;base64,xyz");
    expect(mockReadFileBase64).toHaveBeenCalledTimes(1);
  });

  it("getThumbnail returns null on fetch error", async () => {
    mockReadFileBase64.mockRejectedValueOnce("access denied");
    const { getThumbnail } = useFilePreview();
    const result = await getThumbnail("/path/to/broken.png", "broken.png");
    expect(result).toBeNull();
  });
});
