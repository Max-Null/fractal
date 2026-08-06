import { ref } from "vue";

const STORAGE_FAVORITES = "sb-favorite-skills";
const STORAGE_RECENT = "sb-recent-commands";
const MAX_RECENT = 10;

// ── 收藏的 skill（跨组件共享）──
const favorites = ref<Set<string>>(loadFavorites());

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_FAVORITES);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveFavorites() {
  localStorage.setItem(STORAGE_FAVORITES, JSON.stringify([...favorites.value]));
}

function toggleFavorite(name: string) {
  if (favorites.value.has(name)) {
    favorites.value.delete(name);
  } else {
    favorites.value.add(name);
  }
  favorites.value = new Set(favorites.value); // 触发响应式更新
  saveFavorites();
}

function isFavorite(name: string): boolean {
  return favorites.value.has(name);
}

// ── 最近使用的斜杠命令 ──
const recentCommands = ref<string[]>(loadRecent());

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_RECENT);
    if (!raw) return [];
    // 清理旧数据：去前导 /、去空、去重
    const cleaned = JSON.parse(raw)
      .map((c: string) => c.startsWith("/") ? c.slice(1) : c)
      .filter((c: string) => c.length > 0);
    const seen = new Set<string>();
    const unique = cleaned.filter((c: string) => !seen.has(c) && seen.add(c));
    // 写回清理后的数据
    if (unique.length !== cleaned.length) {
      localStorage.setItem(STORAGE_RECENT, JSON.stringify(unique));
    }
    return unique;
  } catch {
    return [];
  }
}

function saveRecent() {
  localStorage.setItem(STORAGE_RECENT, JSON.stringify(recentCommands.value));
}

/** 记录一次斜杠命令使用，自动去除前导 / */
function recordCommand(cmd: string) {
  const name = cmd.startsWith("/") ? cmd.slice(1) : cmd;
  // 去掉已有的重复项
  recentCommands.value = recentCommands.value.filter(c => c !== name);
  // 加到最前面
  recentCommands.value.unshift(name);
  // 截断
  if (recentCommands.value.length > MAX_RECENT) {
    recentCommands.value = recentCommands.value.slice(0, MAX_RECENT);
  }
  saveRecent();
}

export function useSlashCommands() {
  return { favorites, recentCommands, toggleFavorite, isFavorite, recordCommand };
}
