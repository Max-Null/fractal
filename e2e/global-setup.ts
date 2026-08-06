// e2e 全局设置：注入 OC_GUI_E2E=1 豁免单实例锁（e2e 实例与运行中的正式 app 共存）
export default function globalSetup(): void {
  process.env.OC_GUI_E2E = '1'
}
