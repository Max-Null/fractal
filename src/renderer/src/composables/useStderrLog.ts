/**
 * CC --verbose LLM 请求详情 stderr 日志。按会话隔离，会话结束时持久化到 DB。
 * 与 useDebugLog 共享同一 createSessionLog 工厂实现。
 */
import { createSessionLog } from "./useDebugLog";

export const useStderrLog = createSessionLog(500);
