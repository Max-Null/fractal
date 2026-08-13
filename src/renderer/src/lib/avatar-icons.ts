import type { Component } from "vue";
import { Bot, Cpu, CircuitBoard, Atom, Orbit, Satellite, Rocket, Telescope, Radar, BrainCircuit, Hexagon, Sparkles, Radio, Zap, Binary, Terminal, SatelliteDish, ScanFace, Aperture, Crosshair, Signal, Antenna, Gauge, Globe } from "lucide-vue-next";
/** 头像图标候选（id = ui.avatar 存储值；icon = lucide 组件），设置页与消息区共用，避免常量重复维护 */
export const AVATAR_ICONS = [
  { id: "bot", icon: Bot },
  { id: "cpu", icon: Cpu },
  { id: "circuit", icon: CircuitBoard },
  { id: "atom", icon: Atom },
  { id: "orbit", icon: Orbit },
  { id: "satellite", icon: Satellite },
  { id: "rocket", icon: Rocket },
  { id: "telescope", icon: Telescope },
  { id: "radar", icon: Radar },
  { id: "brain", icon: BrainCircuit },
  { id: "hexagon", icon: Hexagon },
  { id: "sparkles", icon: Sparkles },
  { id: "radio", icon: Radio },
  { id: "zap", icon: Zap },
  { id: "binary", icon: Binary },
  { id: "terminal", icon: Terminal },
  { id: "dish", icon: SatelliteDish },
  { id: "scanface", icon: ScanFace },
  { id: "aperture", icon: Aperture },
  { id: "crosshair", icon: Crosshair },
  { id: "signal", icon: Signal },
  { id: "antenna", icon: Antenna },
  { id: "gauge", icon: Gauge },
  { id: "globe", icon: Globe },
] as const;
/** id → 组件 快速查找表（ui.avatar 存 id，MessageBubble 据此解析为 lucide 组件；旧 emoji 字符查不到返回 undefined） */
export const avatarIconMap: Record<string, Component> = Object.fromEntries(
  AVATAR_ICONS.map((x) => [x.id, x.icon]),
);
