// avatar:// 自定义协议：替代 file:// 加载本地头像（file:// 被 webSecurity 拦截，
// 报 Not allowed to load local resource；且不开全局 webSecurity:false，仅暴露 <userData>/avatar 目录）
import { app, protocol } from 'electron'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

/** 头像图片 MIME 映射（白名单扩展名 → Content-Type） */
const AVATAR_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

/** 注册 avatar:// 特权 scheme（必须在 app ready 前调用，且仅一次——放主进程模块顶层保证） */
export function registerAvatarScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'avatar',
      // standard：URL 按标准解析（<img> 才能正确识别路径）；secure：视为安全来源；
      // bypassCSP：绕过 CSP img-src 限制；supportFetchAPI：支持 fetch/自定义 header
      privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true },
    },
  ])
}

/** 安装 avatar:// 协议 handler（app ready 后调用）；仅暴露 <userData>/avatar 目录 */
export function handleAvatarProtocol(): void {
  protocol.handle('avatar', async (request) => {
    let raw: string
    try {
      raw = decodeURIComponent(request.url.replace(/^avatar:\/\//, '').replace(/[?#].*$/, ''))
    } catch {
      // 非法转义（如 %zz）→ 404（不抛异常，避免 handler 崩溃该请求）
      return new Response('not found', { status: 404 })
    }
    // 去首尾斜杠：兼容 avatar:///avatar.png（空 authority 前导斜杠）与 avatar://avatar.png/（standard host 尾斜杠）；
    // 中间含 / 的路径（如 evil/avatar.png）保留，白名单 ^avatar\. 会拦截 → 严格防路径遍历
    const filename = raw.replace(/^\/+/, '').replace(/\/+$/, '')
    // 文件名白名单校验（防路径遍历，主进程侧与 renderer 侧双保险）
    const m = filename.match(/^avatar\.(png|jpg|jpeg|webp)$/)
    if (!m) return new Response('forbidden', { status: 403 })
    const filePath = join(app.getPath('userData'), 'avatar', filename)
    try {
      const data = await readFile(filePath)
      return new Response(data, { headers: { 'Content-Type': AVATAR_MIME[m[1]] } })
    } catch {
      // 文件不存在（未上传头像等）→ 404
      return new Response('not found', { status: 404 })
    }
  })
}
