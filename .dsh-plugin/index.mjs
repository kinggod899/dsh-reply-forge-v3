// dsh-reply-forge v3 Node half：宿主侧读写地基。
//
// 分层契约：
//   - 浏览器 half（.dsh-plugin/client.js，构建产物）：UI、就地编辑、
//     localStorage 本机渲染覆盖；通过本文件注册的路由读会话块、写伪造。
//   - 本文件（Node half）：注册 message projection + 路由。真正的改写逻辑在
//     src/patch-event.mjs（在线，纯函数）与 src/session-write.mjs（落盘，与 CLI 共用）。
//
// 相对 v2 的全部增量就在 `inject` 与 `apply` 里：
//   1. 多要一个 `sessions` 服务——在线路径要拿活会话对象；
//   2. 启动时注册 `reply-forge/patch` 的 message projection——这是「改完立即
//      生效、不用重启」的机制本体（见 server/patch.mjs 文件头）；
//   3. 路由拿得到 `sessions`：读路由读投影后内容（与模型所见一致），
//      写路由先试在线、拿不到活会话再退回落盘；
//   4. 给宿主持久化写句柄装「ignorable 标记」shim——**P0 安全闸门**。patch
//      事件对宿主是未知类型，落盘时没有 ignorable 会让宿主下次读这个会话
//      时 fail-closed 拒绝整条日志（会话打不开）。见 server/ignorable.mjs。
//
// 注册必须在这里**同步**做掉：宿主恢复会话时用的是 SessionStore 上已注册的
// projection 列表（`Session.fromRestore(..., this.projections)`）。晚一步注册，
// 带 patch 的会话回放时就看不到伪造——而且不会报错（未知类型的事件被静默跳过），
// 属于最难查的那类问题。
//
// 契约：官方 bundle 插件 Node half（package.json 的 dsh.bundle + dsh.client；
// 产物 build-client.mjs 只处理浏览器 half）。

import { registerRoutes } from './server/routes.mjs'
import { patchProjection } from './server/patch.mjs'
import { installIgnorableShim } from './server/ignorable.mjs'

export const name = 'dsh-reply-forge-v3'

// webServer：路由。sessions：活会话（在线读写）。两者都缺席时插件仍能加载，
// 只是退化成 v2 的纯落盘能力。
export const inject = ['webServer', 'sessions']

export function apply(ctx) {
  // 注册投影。宿主对同一事件类型只允许一个定义，重复注册会抛——用 try 兜住，
  // 免得插件热重载时把整个 apply 打断（路由也就装不上了）。
  try {
    ctx?.sessions?.registerMessageProjection?.(patchProjection)
  } catch {
    // 已经注册过（热重载）或宿主不支持：都不影响落盘路径
  }
  // 装 ignorable shim（P0 安全闸门）。装不上不抛——在线写路由会自己拒绝，
  // 用户改用落盘写入即可，插件其余能力照常。
  try {
    installIgnorableShim(ctx)
  } catch {
    // 极端情况下（ctx 结构异常）也绝不影响插件加载
  }
  try {
    registerRoutes(ctx?.webServer, ctx?.sessions)
  } catch {
    // 宿主服务异常绝不影响插件加载；浏览器 half 不受影响
  }
}
