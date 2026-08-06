import { ref } from "vue";

/** 轻量事件总线：触发命令面板打开 */
const trigger = ref(0);

/** 聊天相关命令：由 ChatPanel 消费，AppShell 发出 */
const chatCommand = ref<{ action: string; ts: number }>({ action: "", ts: 0 });

/** 全局命令：任意组件发出，AppShell 消费 */
const globalCommand = ref<{ action: string; ts: number }>({ action: "", ts: 0 });

export function useCommandPaletteBus() {
  function open() {
    trigger.value++;
  }
  return { trigger, open };
}

/** 发送聊天相关命令到 ChatPanel */
export function emitChatCommand(action: string) {
  chatCommand.value = { action, ts: Date.now() };
}

/** ChatPanel 监听并消费聊天命令 */
export function useChatCommandBus() {
  return { chatCommand };
}

/** 任意组件发出全局命令，AppShell 消费 */
export function emitGlobalCommand(action: string) {
  globalCommand.value = { action, ts: Date.now() };
}

/** AppShell 监听全局命令 */
export function useGlobalCommandBus() {
  return { globalCommand };
}
