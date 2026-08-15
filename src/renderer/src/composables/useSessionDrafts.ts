import { ref } from "vue";
import type { AttachedFile } from "@/stores/chat";

/**
 * 草稿跟随会话：跨组件共享的会话草稿存储。
 * ChatPanel 读写（切会话/发送时保存恢复）、SessionSidebar 读 hasDraft 显示「草稿」标记、
 * InputBar 润色跨会话写回（润色期间切会话，结果写入发起会话草稿而非当前输入框）。
 *
 * 设计要点：
 * - 模块级单例（非工厂）：跨组件共享同一 Map——ChatPanel 写入的草稿，SessionSidebar 立即可见。
 * - Map 非响应式 → draftVersion ref 每次写操作自增，消费方 watch 它触发刷新。
 * - 无会话草稿槽（DRAFT_KEY_NONE）：首页（无 activeSessionId）输入的草稿存这里，
 *   新建会话时 migrateNoneDraft 迁移到新会话（2026-08-15 用户确认：切历史会话再新建，首页草稿应带到新会话）。
 */
export interface TextSnippetLike { content: string; label: string }

export interface SessionDraft {
  text: string;
  files: AttachedFile[];
  snippet: TextSnippetLike | null;
}

/** 无会话（首页）草稿槽位 key——特殊值不与真实会话 id 冲突（会话 id 是 UUID） */
const DRAFT_KEY_NONE = "__draft_none__";

const draftsBySession = new Map<string, SessionDraft>();
/** 润色结果待合并（sid → 润色文本）：InputBar 润色跨会话写回与 ChatPanel captureDraft 的时序协调（军师 P2-2）。
 * 竞态：润色完成写 saveDraft(A) 后，切会话的 watch 可能随后 captureDraft(A)（读 InputBar 旧文本）覆盖润色结果。
 * 解决：InputBar 写回走 setPolishResult 存 pending，captureDraft 的 saveDraft 消费 pending——无论顺序，草稿最终是润色文本。
 * pending 是瞬态协调状态，**不持久化**（应用重启后无意义，清空即可）。 */
const pendingPolish = new Map<string, string>();
/** 各会话的润色进行中状态（sid → true）：切会话后润色按钮应跟随会话——A 润色中切到 B，B 按钮恢复正常；
 * 切回 A 若仍在润色则继续显示处理中（2026-08-15 用户反馈）。与 pendingPolish 同为瞬态，不持久化。 */
const polishingBySession = new Map<string, boolean>();
const draftVersion = ref(0);

// ── 持久化（2026-08-15 用户确认：草稿跟随会话需 localStorage 落盘，重启应用不丢失）──
// 单 key 存整个草稿 Map（草稿量小）；每次写操作后 persist；模块加载时恢复。
// 参考 settings store 模式：STORAGE_KEY + try/catch JSON.parse + 兜底。
const STORAGE_KEY = "oc-gui.session-drafts.v1";

/** 校验反序列化的草稿结构合法（防御损坏数据/旧版本字段） */
function isValidDraft(v: unknown): v is SessionDraft {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  if (typeof d.text !== "string") return false;
  if (!Array.isArray(d.files)) return false;
  return d.snippet === null || (typeof d.snippet === "object" && d.snippet !== null);
}

/** 从 localStorage 恢复草稿（模块加载时调用一次；损坏数据静默忽略） */
function loadFromStorage(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return;
    for (const [k, v] of Object.entries(parsed)) {
      if (isValidDraft(v)) draftsBySession.set(k, v);
    }
  } catch { /* localStorage 不可用/数据损坏 → 空草稿起步 */ }
}
loadFromStorage();

/** 持久化整个草稿 Map 到 localStorage（写操作后调用；存储满等异常静默——草稿是临时输入态，丢失可接受） */
function persist(): void {
  try {
    const obj: Record<string, SessionDraft> = {};
    for (const [k, v] of draftsBySession) obj[k] = v;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch { /* ignore */ }
}

/** 空草稿（restore 无草稿时清空输入态用） */
function emptyDraft(): SessionDraft {
  return { text: "", files: [], snippet: null };
}

/** 归一化会话 key：无会话 → NONE 槽 */
function keyOf(sid: string | null | undefined): string {
  return sid ? sid : DRAFT_KEY_NONE;
}

/** 保存某会话草稿（含无会话槽）。若该会话有待合并润色结果（setPolishResult），用润色文本替代 text */
function saveDraft(sid: string | null | undefined, draft: SessionDraft): void {
  const k = keyOf(sid);
  const polishText = pendingPolish.get(k);
  if (polishText !== undefined) {
    pendingPolish.delete(k);
    draft = { ...draft, text: polishText };
  }
  draftsBySession.set(k, {
    text: draft.text,
    files: [...draft.files],
    snippet: draft.snippet ? { ...draft.snippet } : null,
  });
  draftVersion.value++;
  persist();
}

/** 记录润色结果到指定会话（InputBar 润色跨会话写回用；最终由 saveDraft 消费合并） */
function setPolishResult(sid: string | null | undefined, text: string): void {
  pendingPolish.set(keyOf(sid), text);
  draftVersion.value++;
}

/** 该会话是否有待合并润色结果（restoreDraft 消费 pending 前判断——避免无条件 saveDraft 制造空草稿条目） */
function hasPendingPolish(sid: string | null | undefined): boolean {
  return pendingPolish.has(keyOf(sid));
}

/** 设置某会话润色进行中状态（InputBar 发起/结束时调用） */
function setPolishState(sid: string | null | undefined, active: boolean): void {
  const k = keyOf(sid);
  if (active) polishingBySession.set(k, true);
  else polishingBySession.delete(k);
  draftVersion.value++;
}

/** 某会话是否正在润色（InputBar 按钮状态；无会话槽归 NONE） */
function isPolishing(sid: string | null | undefined): boolean {
  return polishingBySession.get(keyOf(sid)) ?? false;
}

/** 删除草稿（会话删除时清理；也支持清空 NONE 槽）——同时丢弃待合并润色结果 */
function clearDraft(sid: string | null | undefined): void {
  const k = keyOf(sid);
  draftsBySession.delete(k);
  pendingPolish.delete(k);
  draftVersion.value++;
  persist();
}

/** 读取某会话草稿；无草稿返回空草稿（不写入，避免读取产生脏条目）。返回深拷贝，外部修改不影响存储 */
function getDraft(sid: string | null | undefined): SessionDraft {
  const d = draftsBySession.get(keyOf(sid));
  if (!d) return emptyDraft();
  return {
    text: d.text,
    files: [...d.files],
    snippet: d.snippet ? { ...d.snippet } : null,
  };
}

/** 是否有草稿（列表标记用；无会话槽也算） */
function hasDraft(sid: string | null | undefined): boolean {
  const d = draftsBySession.get(keyOf(sid));
  if (!d) return false;
  // 空草稿不算（发送清空后不显示标记）
  return d.text !== "" || d.files.length > 0 || d.snippet !== null;
}

/**
 * 把无会话（首页）草稿迁移到指定会话并清空 NONE 槽。
 * 场景：首页输入草稿 → 切历史会话 → 新建会话（2026-08-15 用户反馈 v1 丢失）。
 * 返回是否发生迁移（无 NONE 草稿则 false，调用方无需处理）。
 */
function migrateNoneDraft(sid: string): boolean {
  const noneDraft = draftsBySession.get(DRAFT_KEY_NONE);
  if (!noneDraft) return false;
  // 目标会话已有草稿时以目标为准，丢弃 NONE 槽（避免覆盖用户当前编辑）
  if (!draftsBySession.has(sid)) {
    // 深拷贝（与 saveDraft 风格一致——军师 P3，2026-08-15 审查发现引用赋值存在潜在共享）
    draftsBySession.set(sid, {
      text: noneDraft.text,
      files: [...noneDraft.files],
      snippet: noneDraft.snippet ? { ...noneDraft.snippet } : null,
    });
  }
  draftsBySession.delete(DRAFT_KEY_NONE);
  draftVersion.value++;
  persist();
  return true;
}

/** 版本号：写操作自增，消费方（SessionSidebar 列表标记）watch 刷新 */
function version(): number {
  return draftVersion.value;
}

/** 版本号 ref（响应式源）：消费方 computed 依赖它实现「非响应式 Map 上的响应式重算」 */
function versionRef() {
  return draftVersion;
}

export function useSessionDrafts() {
  return {
    saveDraft,
    getDraft,
    hasDraft,
    clearDraft,
    setPolishResult,
    hasPendingPolish,
    setPolishState,
    isPolishing,
    migrateNoneDraft,
    version,
    versionRef,
    /** 测试辅助：清空全部草稿 + localStorage（避免单测间状态污染；生产不调用） */
    _resetForTest: () => {
      draftsBySession.clear();
      pendingPolish.clear();
      polishingBySession.clear();
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      draftVersion.value++;
    },
    /** 测试辅助：模拟应用重启后的模块重新加载（清 Map 后从 localStorage 恢复）；生产不调用 */
    _reloadFromStorageForTest: () => {
      draftsBySession.clear();
      pendingPolish.clear();
      polishingBySession.clear();
      loadFromStorage();
      draftVersion.value++;
    },
  };
}
