import { ref, computed, onUnmounted, type Ref, type InjectionKey } from "vue"

export interface PanelLayout {
  previewWidth: Ref<number>
  filesWidth: Ref<number>
  previewDragging: Ref<boolean>
  filesDragging: Ref<boolean>
  startResize: (col: "preview" | "files", e: MouseEvent) => void
  setupObserver: () => void
}

export const PANEL_LAYOUT_KEY: InjectionKey<PanelLayout> = Symbol("panelLayout")

export function usePanelLayout(options: {
  containerRef: Ref<HTMLElement | null>
  sidebarOpen: Ref<boolean>
}): PanelLayout {
  const previewWidth = ref(350)
  const filesWidth = ref(280)
  const previewDragging = ref(false)
  const filesDragging = ref(false)

  const MAIN_MIN = 300
  const RAIL_WIDTH = 40

  const sidebarWidth = computed(() => (options.sidebarOpen.value ? 260 : 0))

  /** 右侧面板可用的总宽度上限（保护 Main 最小宽度） */
  function availableForRight(containerW: number): number {
    return containerW - RAIL_WIDTH - sidebarWidth.value - MAIN_MIN
  }

  /** 窗口缩放时等比收缩右侧面板，防止溢出 */
  function clampRightPanels() {
    const container = options.containerRef.value
    if (!container) return
    const available = availableForRight(container.clientWidth)
    const totalRight = previewWidth.value + filesWidth.value
    if (totalRight > available && available > 0) {
      const ratio = available / totalRight
      previewWidth.value = Math.max(280, Math.floor(previewWidth.value * ratio))
      filesWidth.value = Math.max(200, Math.floor(filesWidth.value * ratio))
    }
  }

  let resizeOverlay: HTMLDivElement | null = null

  function startResize(col: "preview" | "files", e: MouseEvent) {
    e.preventDefault()
    const widthRef = col === "preview" ? previewWidth : filesWidth
    const draggingRef = col === "preview" ? previewDragging : filesDragging
    const minW = col === "preview" ? 280 : 200
    const maxW = col === "preview" ? 700 : 600

    draggingRef.value = true
    const startX = e.clientX
    const startW = widthRef.value
    // 动态上限：取固定上限和容器 50% 的较小值，小屏自动收窄
    const container = options.containerRef.value
    const pctMax = container ? Math.floor(container.clientWidth * 0.5) : maxW
    const effectiveMax = Math.min(maxW, pctMax)

    // 透明遮罩：防止 iframe（HTML 预览）吞掉拖拽期间的 mousemove 事件
    resizeOverlay = document.createElement("div")
    resizeOverlay.style.cssText = "position:fixed;inset:0;z-index:9999;cursor:col-resize;"
    document.body.appendChild(resizeOverlay)
    resizeOverlay.addEventListener("mousemove", onMove)
    resizeOverlay.addEventListener("mouseup", onUp)
    // ponytail: 兜底——用户松开鼠标但 mouseup 没触发到 overlay（比如失焦），用全局 mouseup 清理
    document.addEventListener("mouseup", onUp, { once: true })

    function onMove(ev: MouseEvent) {
      const desired = startW - (ev.clientX - startX)
      let clamped = Math.min(effectiveMax, Math.max(minW, desired))
      // 保护 Main 最小宽度：当前列 + 另一列 不能超出可用空间
      const container = options.containerRef.value
      if (container) {
        const otherCol = col === "preview" ? filesWidth.value : previewWidth.value
        const available = availableForRight(container.clientWidth) - otherCol
        clamped = Math.min(clamped, Math.max(minW, available))
      }
      widthRef.value = clamped
    }

    function onUp() {
      draggingRef.value = false
      if (resizeOverlay) {
        resizeOverlay.removeEventListener("mousemove", onMove)
        resizeOverlay.removeEventListener("mouseup", onUp)
        resizeOverlay.remove()
        resizeOverlay = null
      }
      document.removeEventListener("mouseup", onUp)
    }
  }

  // ResizeObserver：窗口缩放时自动收缩右侧面板
  let observer: ResizeObserver | null = null
  function setupObserver() {
    if (!options.containerRef.value) return
    observer = new ResizeObserver(() => clampRightPanels())
    observer.observe(options.containerRef.value)
  }

  onUnmounted(() => {
    observer?.disconnect()
    // 拖拽中途组件卸载：清理遮罩
    if (resizeOverlay) {
      resizeOverlay.remove()
      resizeOverlay = null
    }
  })

  return {
    previewWidth,
    filesWidth,
    previewDragging,
    filesDragging,
    startResize,
    setupObserver,
  }
}
