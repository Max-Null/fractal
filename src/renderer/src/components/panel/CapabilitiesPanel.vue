<script setup lang="ts">
// 生态面板（原「技能」tab）：Agent / 插件 / 技能 / MCP 四类清单
// 数据源 = serve 原生端点（oc-sdk capabilities.list——运行时真实数据，非解析配置文件；
// 端点失败主进程返回空数组，此处再兜底一次，保证面板永不崩）
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { listCapabilities, type CapabilityBundle, type CapabilityMcp } from "@/lib/electron-bridge";

const { t } = useI18n();
const bundle = ref<CapabilityBundle | null>(null);
const loading = ref(true);

// 仅展示自定义 agent：serve /agent 会返回 7 个内置 native agent（build/plan/explore 等），
// 对小白用户是噪音——内置能力无需在生态清单里罗列，分组计数也以过滤后为准
const visibleAgents = computed(() => (bundle.value?.agents ?? []).filter((a) => !a.native));

async function load() {
  loading.value = true;
  try {
    bundle.value = await listCapabilities();
  } catch {
    bundle.value = { agents: [], skills: [], plugins: [], mcp: [] };
  } finally {
    loading.value = false;
  }
}
onMounted(load);

// MCP 状态徽标色：connected 绿 / disabled 灰 / failed 红 / needsAuth 琥珀 / 其他灰
function mcpStatusClass(status: string): string {
  switch (status) {
    case "connected":
      return "mcp-status--connected";
    case "disabled":
      return "mcp-status--disabled";
    case "failed":
      return "mcp-status--failed";
    case "needsAuth":
      return "mcp-status--auth";
    default:
      return "mcp-status--unknown";
  }
}
function mcpStatusText(status: string): string {
  switch (status) {
    case "connected":
      return t("panel.mcpConnected");
    case "disabled":
      return t("panel.mcpDisabled");
    case "failed":
      return t("panel.mcpFailed");
    case "needsAuth":
      return t("panel.mcpNeedsAuth");
    case "needsClientRegistration":
      return t("panel.mcpNeedsClientRegistration");
    default:
      return t("panel.mcpUnknown");
  }
}
function mcpTypeText(m: CapabilityMcp): string {
  return m.type === "local" ? t("panel.mcpLocal") : m.type === "remote" ? t("panel.mcpRemote") : "";
}
</script>

<template>
  <div class="capabilities-panel">
    <div v-if="loading" class="pitem-empty">{{ t("panel.loading") }}</div>

    <template v-else>
      <!-- 技能组（用户高频关注，排最前） -->
      <div class="pgroup">{{ t("panel.skillGroup") }} · {{ bundle?.skills.length ?? 0 }}</div>
      <div v-if="bundle && bundle.skills.length">
        <div v-for="s in bundle.skills" :key="s.name" class="pitem">
          <span class="pitem-ico pitem-ico--skill">🔍</span>
          <div class="pitem-info">
            <div class="pitem-name">{{ s.name }}</div>
            <div class="pitem-sub">{{ s.description || "—" }}</div>
          </div>
        </div>
      </div>
      <div v-else class="pitem-empty">{{ t("panel.noCapabilities") }}</div>

      <!-- Agent 组（仅自定义 agent，native 内置已过滤） -->
      <div class="pgroup">{{ t("panel.agentGroup") }} · {{ visibleAgents.length }}</div>
      <div v-if="visibleAgents.length">
        <div v-for="a in visibleAgents" :key="a.name" class="pitem">
          <span class="pitem-ico pitem-ico--agent">✦</span>
          <div class="pitem-info">
            <div class="pitem-name">{{ a.name }}</div>
            <div class="pitem-sub">{{ a.description || "—" }}</div>
          </div>
        </div>
      </div>
      <div v-else class="pitem-empty">{{ t("panel.noCapabilities") }}</div>

      <!-- 插件组 -->
      <div class="pgroup">{{ t("panel.pluginGroup") }} · {{ bundle?.plugins.length ?? 0 }}</div>
      <div v-if="bundle && bundle.plugins.length">
        <div v-for="p in bundle.plugins" :key="p.name" class="pitem">
          <span class="pitem-ico pitem-ico--plugin">⇄</span>
          <div class="pitem-info">
            <div class="pitem-name">{{ p.name }}</div>
            <div class="pitem-sub">{{ p.source }}</div>
          </div>
        </div>
      </div>
      <div v-else class="pitem-empty">{{ t("panel.noCapabilities") }}</div>

      <!-- MCP 组 -->
      <div class="pgroup">{{ t("panel.mcpGroup") }} · {{ bundle?.mcp.length ?? 0 }}</div>
      <div v-if="bundle && bundle.mcp.length">
        <div v-for="m in bundle.mcp" :key="m.name" class="pitem">
          <span class="pitem-ico pitem-ico--mcp">🔌</span>
          <div class="pitem-info">
            <div class="pitem-name">
              {{ m.name }}
              <span class="mcp-status" :class="mcpStatusClass(m.status)">{{ mcpStatusText(m.status) }}</span>
            </div>
            <div class="pitem-sub" :title="m.target">
              <span v-if="mcpTypeText(m)" class="mcp-type">{{ mcpTypeText(m) }}</span>{{ m.target || "—" }}
            </div>
          </div>
        </div>
      </div>
      <div v-else class="pitem-empty">{{ t("panel.noCapabilities") }}</div>
    </template>
  </div>
</template>

<style scoped>
/* ── 生态面板：对齐旧技能面板骨架（pgroup/pitem 体系）── */
.capabilities-panel {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 14px;
  min-height: 0;
}

/* 分组标题 */
.pgroup {
  font-size: 10.5px;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  text-transform: uppercase;
  padding: 6px 2px 0;
}

/* 条目 */
.pitem {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-dim);
  background: var(--bg-elevated);
}
.pitem-ico {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  flex-shrink: 0;
}
.pitem-ico--agent { background: var(--accent-glow); color: var(--accent); }
/* violet 无现成柔和变量，用 color-mix 按主题色生成 */
.pitem-ico--plugin { background: color-mix(in srgb, var(--violet) 14%, transparent); color: var(--violet); }
.pitem-ico--skill { background: var(--amber-glow); color: var(--amber); }
.pitem-ico--mcp { background: var(--accent-glow); color: var(--accent); }
.pitem-info {
  flex: 1;
  min-width: 0;
}
.pitem-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-bright);
}
.pitem-sub {
  font-size: 10.5px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* MCP 状态徽标：彩色小圆点 + 状态文字（颜色语义见 mcpStatusClass） */
.mcp-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 9.5px;
  font-weight: 400;
  padding: 1px 7px;
  border-radius: 999px;
}
.mcp-status::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.mcp-status--connected { background: color-mix(in srgb, #10b981 12%, transparent); color: #10b981; }
.mcp-status--connected::before { background: #10b981; }
.mcp-status--disabled { background: var(--bg-active); color: var(--text-muted); }
.mcp-status--disabled::before { background: var(--text-muted); }
.mcp-status--failed { background: color-mix(in srgb, #ef4444 12%, transparent); color: #ef4444; }
.mcp-status--failed::before { background: #ef4444; }
.mcp-status--auth { background: var(--amber-glow); color: var(--amber); }
.mcp-status--auth::before { background: var(--amber); }
.mcp-status--unknown { background: var(--bg-active); color: var(--text-muted); }
.mcp-status--unknown::before { background: var(--text-muted); }

/* type 小标签（本地/远程） */
.mcp-type {
  font-size: 9px;
  padding: 0 5px;
  margin-right: 5px;
  border-radius: 4px;
  background: var(--bg-active);
  color: var(--text-muted);
}

/* 空态/加载态行 */
.pitem-empty {
  padding: 12px;
  border-radius: var(--radius-md);
  border: 1px dashed var(--border-dim);
  color: var(--text-muted);
  font-size: 11px;
  text-align: center;
}
</style>
