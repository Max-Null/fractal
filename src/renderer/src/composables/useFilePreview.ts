import { ref } from "vue";
import { readFileBase64 } from "@/lib/electron-bridge";

// ── Pure utility exports (reusable without composable) ──

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"];

export function isImageFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return IMAGE_EXTS.includes(ext);
}

export function mimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    bmp: "image/bmp", ico: "image/x-icon",
  };
  return map[ext] || "image/png";
}

// ── Composable (reactive thumbnail cache) ──

export function useFilePreview() {
  const thumbnails = ref<Record<string, string>>({});

  async function getThumbnail(path: string, filename: string): Promise<string | null> {
    if (thumbnails.value[path]) return thumbnails.value[path];
    if (!isImageFile(filename)) return null;

    try {
      const b64 = await readFileBase64(path);
      const uri = `data:${mimeType(filename)};base64,${b64}`;
      thumbnails.value[path] = uri;
      return uri;
    } catch {
      return null;
    }
  }

  return { getThumbnail, thumbnails };
}
