import { ref } from "vue"

/** 浮动 tip 定位和显隐——FilePreviewPanel 内多套选取 tip 共用 */
export function useSelectionTip() {
  const tipVisible = ref(false)
  const tipPos = ref({ left: "0px", top: "0px" })
  const tipFullText = ref("")    // 完整选区文本（发送用）
  const tipSummary = ref("")     // 截断摘要（tip 展示用）

  function showTip(text: string, anchorRect: DOMRect) {
    tipFullText.value = text
    tipSummary.value = text.slice(0, 80)
    // 定位在选区末尾（光标位置）附近，不超出视口
    const TIP_W = 360, TIP_H = 120, GAP = 8
    // 水平：优先放选区右侧末尾，空间不够则放左侧
    let left = anchorRect.right + GAP
    if (left + TIP_W > window.innerWidth - GAP) {
      left = anchorRect.left - TIP_W - GAP
      if (left < GAP) left = GAP
    }
    // 垂直：优先选区下方，不够则上方
    let top = anchorRect.bottom + GAP
    if (top + TIP_H > window.innerHeight) {
      top = anchorRect.top - TIP_H - GAP
      if (top < GAP) top = GAP
    }
    tipPos.value = {
      left: `${left}px`,
      top: `${top}px`,
    }
    tipVisible.value = true
  }

  function hideTip() { tipVisible.value = false }

  return { tipVisible, tipPos, tipFullText, tipSummary, showTip, hideTip }
}
