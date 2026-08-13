import type { Component } from "vue";
import { Cat, Dog, Rabbit, PawPrint, Turtle, Fish, Bird, Flower2, Rocket, Star, Rainbow, Clover } from "lucide-vue-next";
/** 头像图标候选（id = ui.avatar 存储值；icon = lucide 组件），设置页与消息区共用，避免常量重复维护 */
export const AVATAR_ICONS = [
  { id: "cat", icon: Cat },
  { id: "dog", icon: Dog },
  { id: "rabbit", icon: Rabbit },
  { id: "pawprint", icon: PawPrint },
  { id: "turtle", icon: Turtle },
  { id: "fish", icon: Fish },
  { id: "bird", icon: Bird },
  { id: "flower2", icon: Flower2 },
  { id: "rocket", icon: Rocket },
  { id: "star", icon: Star },
  { id: "rainbow", icon: Rainbow },
  { id: "clover", icon: Clover },
] as const;
/** id → 组件 快速查找表（ui.avatar 存 id，MessageBubble 据此解析为 lucide 组件；旧 emoji 字符查不到返回 undefined） */
export const avatarIconMap: Record<string, Component> = Object.fromEntries(
  AVATAR_ICONS.map((x) => [x.id, x.icon]),
);
