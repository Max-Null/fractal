// 注入到 HTML 预览 iframe 的选择器脚本（原 FilePreviewPanel SFC 内常量，2026-08-12 提取为模块）。
// 提取原因一：可单测；原因二：修复刷新后状态重置 bug——刷新会重建 blob 导致 iframe 整体重新加载，
// 脚本初始值必须与父窗口当前检查模式一致，否则关闭检查模式后点刷新，__inspectEnabled 又被硬编码
// true 重置（点击被拦截、页面交互失效，而 UI 按钮仍显示「已关闭」）。
// \x3C 转义：vue SFC 编译器扫描 <script> 块时把字面闭合标签当块结束，独立 .ts 文件保留同款转义保持一致
export function buildInspectorScript(enabled: boolean): string {
  return `\x3Cscript\x3E
// 检查模式开关：父窗口 postMessage 切换（关闭=页面可交互，动态元素可操作——2026-08-12）
window.__inspectEnabled=${enabled};
window.addEventListener('message',function(ev){
if(ev.data&&ev.data.type==='set-inspect-enabled'){window.__inspectEnabled=!!ev.data.enabled;if(!window.__inspectEnabled){__o.style.display='none';}}
});
var __o=document.createElement('div');
__o.style.cssText='position:fixed;pointer-events:none;z-index:99999;border:2px solid #3b82f6;background:rgba(59,130,246,0.08);display:none;border-radius:2px;';
document.body.appendChild(__o);
var __last=null;
document.addEventListener('mouseover',function(e){
if(!window.__inspectEnabled){__o.style.display='none';return;}
var el=e.target;
if(el===__o||el===document.body||el===document.documentElement)return;
if(el===__last)return;
__last=el;
var r=el.getBoundingClientRect();
__o.style.display='block';__o.style.left=r.left+'px';__o.style.top=r.top+'px';
__o.style.width=r.width+'px';__o.style.height=r.height+'px';
});
document.addEventListener('click',function(e){
// 检查模式关闭时拦截 <a> 链接点击：阻止 iframe 内部导航导致 blob 预览白屏（2026-08-12）；
// 锚点(#)放行（同文档滚动不重新加载），其余链接上报父窗口——绝对 URL 走系统浏览器、相对路径打开相邻文件
if(!window.__inspectEnabled){
var link=e.target.closest('a[href]');
if(link){
var href=link.getAttribute('href');
if(href.charAt(0)==='#')return;
e.preventDefault();e.stopPropagation();
window.parent.postMessage({type:'link-click',href:href},'*');
return;
}
return;
}
e.preventDefault();e.stopPropagation();
__last=null;__o.style.display='none';
var el=e.target,a={};
for(var i=0;i<el.attributes.length;i++){
var at=el.attributes[i];
if(at.name==='class'||at.name==='id'||at.name==='style')continue;
a[at.name]=at.value;
}
var r=el.getBoundingClientRect();
window.parent.postMessage({type:'dom-selected',info:{
tag:el.tagName.toLowerCase(),
id:el.id||'',
classes:Array.from(el.classList).join(' '),
text:(el.textContent||'').trim().slice(0,300),
attrs:a,
left:r.left,top:r.top,bottom:r.bottom
}},'*');
});
\x3C\/script\x3E`;
}

/** 非导航协议（javascript/data/vbscript）：点击应忽略——既不导航也不解析为文件路径。
 * 常见于占位链接 javascript:void(0)，若落入相对路径分支会被拼成无效本地路径（2026-08-12 审查修复） */
export function isIgnorableHref(href: string): boolean {
  return /^(javascript|data|vbscript):/i.test(href);
}

/** 相对链接 href 基于源文件目录解析为本地绝对路径（含 ../ 归一化；去掉 query/hash；Windows 分隔符）。
 * 协议相对 URL（//cdn）与空值返回 ""，调用方忽略。注入脚本把链接点击上报父窗口后，由父窗口调用此函数定位目标文件 */
export function resolveLinkTarget(baseDir: string, href: string): string {
  const clean = href.split(/[?#]/)[0].replace(/\\/g, "/");
  if (!clean || clean.startsWith("//")) return "";
  const segs = [
    ...baseDir.replace(/\\/g, "/").split("/").filter(Boolean),
    ...clean.split("/").filter((s) => s && s !== "."),
  ];
  const out: string[] = [];
  for (const s of segs) {
    if (s === "..") { if (out.length) out.pop(); }
    else out.push(s);
  }
  return out.join("\\");
}
