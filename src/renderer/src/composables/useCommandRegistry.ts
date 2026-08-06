import { reactive } from "vue";

/**
 * 可扩展命令注册系统。
 * 组件在 onMounted 时 register()，返回的注销函数在 onUnmounted 时调用。
 * CommandPalette 通过 getCommands() 获取所有已注册的动态命令。
 */

export interface RegisteredCommand {
  id: string;
  group: string;
  labelKey: string;
  descKey?: string;
  keys?: string;
  icon?: string;
  cliKey?: string;
  /** 条件可见，返回 false 时命令隐藏但注册保留 */
  visible?: () => boolean;
}

/** 模块级响应式 Map，所有组件共享 */
const registry = reactive<Map<string, RegisteredCommand>>(new Map());

export function useCommandRegistry() {
  /** 注册命令，返回注销函数 */
  function register(cmd: RegisteredCommand): () => void {
    // 允许同名覆盖（先到先得，后来的被忽略）
    if (!registry.has(cmd.id)) {
      registry.set(cmd.id, cmd);
    }
    return () => {
      registry.delete(cmd.id);
    };
  }

  /** 获取当前所有已注册命令的快照 */
  function getCommands(): RegisteredCommand[] {
    return [...registry.values()];
  }

  return { register, getCommands, registry };
}
