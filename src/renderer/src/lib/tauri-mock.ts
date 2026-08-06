/**
 * Mock electronBridge for Playwright E2E testing / 纯浏览器调试。
 * 替代 Electron preload 注入的 window.electronBridge。
 * 由原 tauri-mock.ts 迁移而来，保留 mockInvoke / mockEmit / resetMocks API。
 *
 * Usage: 在浏览器环境（无 preload）下引入本文件后，
 * window.electronBridge 会被 mock 实现覆盖，渲染代码无需改动。
 */

interface MockListener {
  (event: string, handler: (data: unknown) => void): () => void;
}

// Store registered listeners and mock responses
const listeners: Map<string, Array<(data: unknown) => void>> = new Map();
let mockInvokeHandlers: Map<string, (args: Record<string, unknown>) => unknown> = new Map();

/**
 * Register a mock for `invoke(channel, args)`
 */
export function mockInvoke(channel: string, handler: (args: Record<string, unknown>) => unknown) {
  mockInvokeHandlers.set(channel, handler);
}

/**
 * Emit a mock event to all registered listeners
 */
export function mockEmit(channel: string, payload: unknown) {
  const handlers = listeners.get(channel) || [];
  for (const handler of handlers) {
    handler(payload);
  }
}

/**
 * Clear all mocks and listeners (call between tests)
 */
export function resetMocks() {
  listeners.clear();
  mockInvokeHandlers.clear();
}

// ── electronBridge mock 实现 ──

export async function invoke(channel: string, args?: Record<string, unknown>): Promise<unknown> {
  const handler = mockInvokeHandlers.get(channel);
  if (handler) {
    return handler(args || {});
  }
  console.warn(`[electron-mock] Unmocked invoke: ${channel}`, args);
  return "mocked-ok";
}

export function on(channel: string, handler: (data: unknown) => void): () => void {
  if (!listeners.has(channel)) {
    listeners.set(channel, []);
  }
  listeners.get(channel)!.push(handler);

  // Return unlisten function
  return () => {
    const handlers = listeners.get(channel) || [];
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
  };
}

// Default mocks for channels that have no registered handler
if (typeof window !== "undefined") {
  mockInvokeHandlers.set("settings:loadProviderConfigs", () => ({}));
  mockInvokeHandlers.set("settings:loadUiSettings", () => "{}");
  mockInvokeHandlers.set("fs:getWorkspaceRoot", () => "");
  mockInvokeHandlers.set("git:status", () => ({ branch: "", staged: [], modified: [], untracked: [] }));
}

// Browser 环境下挂载 window.electronBridge
if (typeof window !== "undefined") {
  (window as unknown as { electronBridge: unknown }).electronBridge = { invoke, on };
  // Debug hooks for Playwright tests
  (window as unknown as Record<string, unknown>).__ccgui_mock = {
    listeners,
    mockInvokeHandlers,
    _emit: mockEmit,
    _invoke: invoke,
    _on: on,
  };
  console.log("[electron-mock] Loaded. electronBridge mocked for browser testing.");
}
