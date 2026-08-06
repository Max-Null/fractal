import { ref, computed } from "vue";

/**
 * 按会话隔离的日志行存储（工厂函数）。
 * useDebugLog / useStderrLog 共享同一实现，仅 maxLines 不同。
 */
export function createSessionLog(maxLines: number) {
  const store: Record<string, string[]> = {};
  const version = ref(0);
  let currentSessionId = "";

  return function () {
    const lines = computed(() => {
      version.value;
      return [...(store[currentSessionId] || [])];
    });
    const visible = ref(false);

    function setSession(id: string) {
      currentSessionId = id;
      if (!store[id]) store[id] = [];
      version.value++;
    }

    function add(line: string, sid?: string) {
      const targetId = sid || currentSessionId;
      if (!targetId) return;
      if (!store[targetId]) store[targetId] = [];
      const arr = store[targetId];
      arr.push(line);
      if (arr.length > maxLines) {
        store[targetId] = arr.slice(-maxLines);
      }
      version.value++;
    }

    function toggle() { visible.value = !visible.value; }

    function clear() {
      if (!currentSessionId) return;
      store[currentSessionId] = [];
      version.value++;
    }

    function exportLines(sid: string): string[] {
      return [...(store[sid] || [])];
    }

    function importLines(sid: string, linesArr: string[]) {
      store[sid] = linesArr.slice(-maxLines);
      version.value++;
    }

    return { lines, visible, add, toggle, clear, setSession, exportLines, importLines };
  };
}

export const useDebugLog = createSessionLog(200);
