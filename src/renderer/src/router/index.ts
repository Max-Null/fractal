import { createRouter, createWebHashHistory } from "vue-router";

// 用 hash 模式：prod 打包后以 file:// 协议加载，history 模式无法匹配路径（dev 的 http 下才正常）
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      redirect: "/chat",
    },
    {
      path: "/chat",
      name: "chat",
      component: () => import("@/components/chat/ChatPanel.vue"),
    },
    {
      path: "/settings",
      name: "settings",
      component: () => import("@/components/settings/SettingsPanel.vue"),
    },
  ],
});

export default router;
