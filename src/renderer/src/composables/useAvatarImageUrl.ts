import { ref, watch } from "vue";
import { useSettingsStore } from "@/stores/settings";

/** 图片头像 avatar:// URL；空 = 未设置/非法值 → 回退 emoji/图标头像 */
export function useAvatarImageUrl() {
  const settings = useSettingsStore();
  const avatarImageUrl = ref("");
  watch(
    () => [settings.avatarImage, settings.avatarRevision] as const,
    () => {
      if (!settings.avatarImage) { avatarImageUrl.value = ""; return; }
      // 文件名白名单校验（军师审查 2026-08-13）：防路径遍历
      if (!/^avatar\.(png|jpg|jpeg|webp)$/.test(settings.avatarImage)) { avatarImageUrl.value = ""; return; }
      // avatar:// 协议（主进程注册，仅暴露 <userData>/avatar，替代 file:// 绕过 webSecurity 拦截）；
      // ?v= 版本号做 cache-busting：换文件后文件名不变但版本号变，强制 Chromium 重新加载
      avatarImageUrl.value = `avatar:///${settings.avatarImage}?v=${settings.avatarRevision}`;
    },
    { immediate: true },
  );
  return { avatarImageUrl };
}
