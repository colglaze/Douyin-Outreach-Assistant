# BUG-20260903-03 — 用户复测：主页悬浮按钮仍不显示（V0.5.1 诊断加固）

> 关联：BUG-20260903-01（fab 缺失，V0.4.0 已做 fab-first + 错误横幅）、
> REQ-20260903-02；来源：2026-09-03 用户截图复测反馈。

## 现象

用户更新脚本后在抖音主页截图反馈：页面正常渲染，但右侧悬浮按钮（达人助手）
完全没有出现，**也没有看到 V0.4.0 兜底的红色初始化失败横幅**。

## 排查

- 本地 dist（V0.5.0）构建时间 12:14，用户截图 12:17，时间接近但无法证明
  Tampermonkey 中实际运行的就是新版本——**无横幅说明 bootstrap 要么没执行、
  要么脚本根本没被注入**；
- 代码走查确认 V0.5.0 渲染链路本身无缺陷：fab 在 bootstrap 最前面渲染，
  无前置 await 依赖，`z-index:9999998` + `position:fixed` 无被遮挡风险；
- 推断剩余候选根因（按概率排序）：
  1. **Tampermonkey 中脚本未更新/未启用**（旧缓存或导入后未保存）；
  2. **脚本未被注入**（例如在抖音 Windows 桌面客户端中打开——客户端不是
     浏览器，Tampermonkey 无法注入；或 TM 被暂停/域名被排除）；
  3. 模块求值阶段异常导致整个 IIFE 静默死亡（概率低，模块顶层均为声明）；
  4. `document.body` 等待逻辑边界：脚本若在 DOMContentLoaded 之后、
     body 就绪前注入，旧实现只监听 DOMContentLoaded 会永久挂起。

## 修复（V0.5.1，诊断加固）

1. **版本角标**：悬浮按钮左下角常驻 `v0.5.1` 角标 + hover tooltip——
   用户截图即可确认 Tampermonkey 中实际运行的版本，直接区分根因 1/2 与其他；
2. **存活日志**：模块顶层第一行即输出
   `[DouyinOutreach][Main] userscript alive v0.5.1`，控制台过滤即可确认注入与否；
3. **全局错误兜底**：`error` / `unhandledrejection` 钩子记录日志，
   且仅当 `#doa-fab` 不存在时弹红色横幅（避免抖音自身脚本报错误报刷屏）；
4. **body 等待加固**：`ensureBody()` 改为 MutationObserver + 5 秒超时兜底，
   不再只依赖 DOMContentLoaded；
5. **自愈重挂载**：2 秒巡检 `fab/panel.ensureMounted()`，抖音 SPA 重绘
   移除外部节点时自动重新挂载；
6. **防重复注入**：构造时移除已存在的 `#doa-fab` 旧节点。

## 验证

- `npm run typecheck`（tsc --noEmit）零错误；
- `npm run build` 产出 dist/douyin-outreach.user.js（80.5kb，@version 0.5.1），
  存活日志/角标/ensureMounted 均已确认打入产物。

## 二次复测（2026-09-03 12:32 用户截图）

新证据：Chrome 浏览器访问 douyin.com（地址栏显示 `douyin.com/?recommend=1`，
Chrome 会隐藏 `www.` 前缀，@match `https://www.douyin.com/*` 不受影响）；
Tampermonkey 弹窗显示脚本**已启用且匹配当前页**；控制台过滤 `DouyinOutreach`
**零输出**——连 V0.3 起就有的 started 日志都没有。

结论：**脚本被 TM 判定为匹配且启用，但完全没有被执行**，问题出在注入层而非脚本代码。
最大嫌疑：Chrome MV3 版 Tampermonkey 的用户脚本权限未开——
Chrome 139+ 要求 `chrome://extensions` 开启「开发者模式」，
或在 Tampermonkey 扩展详情页开启「允许用户脚本（Allow user scripts）」，
否则 TM 显示脚本启用但实际不注入。次要嫌疑：TM 中脚本内容不完整/非最新
（需在编辑器中确认 @version 行为 0.5.1）。

## 用户侧验证清单（回复用户）

1. 确认在**浏览器**（Chrome/Edge）中访问 www.douyin.com，
   而非抖音 Windows 桌面客户端（客户端无法运行 Tampermonkey）；
2. F12 控制台过滤 `DouyinOutreach`：
   - 无任何日志 = 脚本未注入 → 检查 TM 是否启用、脚本是否更新到 0.5.1、
     页面是否刷新；
   - 有 alive 日志但无按钮 = 截控制台 + 页面反馈，继续排查；
3. 看到按钮后核对角标是否为 `v0.5.1`；若是旧版本号 = TM 中脚本未更新。

## 状态：已加固（待用户按清单复测定位根因）
