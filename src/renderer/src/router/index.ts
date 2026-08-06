import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  history: createWebHistory(),
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
