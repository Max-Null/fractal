import { ref, watch } from "vue";
import { getAvatarPath } from "@/lib/electron-bridge";
import { useSettingsStore } from "@/stores/settings";

/** 图片头像 file:// URL（异步取 getAvatarPath 后拼接）；空 = 未设置/路径获取失败 → 回退 emoji 文字/图标头像 */
export function useAvatarImageUrl() {
  const settings = useSettingsStore();
  const avatarImageUrl = ref("");
  watch(
    () => settings.avatarImage,
    async () => {
      if (!settings.avatarImage) { avatarImageUrl.value = ""; return; }
      try {
        // 文件名白名单校验（军师审查 2026-08-13）：avatarImage 只能由后端 avatar:pick 写成 avatar.{png|jpg|jpeg|webp}，
        // 防止 settings.json 被 JSON 编辑器/agent 手改注入 ../../ 路径遍历加载 userData 任意文件
        if (!/^avatar\.(png|jpg|jpeg|webp)$/.test(settings.avatarImage)) { avatarImageUrl.value = ""; return; }
        // Windows 路径 → file:/// URL：反斜杠转正斜杠 + encodeURI 编码空格/中文（冒号/斜杠保留，供 file 协议解析）
        const dir = await getAvatarPath();
        avatarImageUrl.value = "file:///" + encodeURI(dir.replace(/\\/g, "/") + "/" + settings.avatarImage);
      } catch {
        // 路径 IPC 失败（开发/测试环境）→ 回退 emoji，不显示破图
        avatarImageUrl.value = "";
      }
    },
    { immediate: true },
  );
  return { avatarImageUrl };
}
