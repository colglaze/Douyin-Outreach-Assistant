# BUG-20260903-02：连刷自动化找不到达人 + 发送按钮失效（真实环境根因取证）

- 状态：已修复（V0.5.0，真实环境端到端验证通过）
- 发现：2026-09-03 用户反馈"没用啊，你自己跑一遍看看"，真实登录环境 5 轮实跑 + 8 个探针定位
- 影响：连刷自动化完全不可用（找不到达人 / 私信打不开 / 发送点了没反应）

## 根因链（按发现顺序）

### 1. 推荐页 URL 与落地页不是同一个

- 打开 `https://www.douyin.com/` 会 **302 到 `/jingxuan`（精选）**；`/?recommend=1` 直接访问同样被重定向。
- 推荐 feed 只能通过**侧栏「推荐」锚点 SPA 进入**（`a[href*="recommend=1"]`，实测无刷新、脚本状态保留）。
- 旧代码 `isFeedPage()` 只认 `/`，落地页上直接拒绝启动。

### 2. 精选页无法采集作者

- `/jingxuan` 的视频卡片是 `<div class="...videoCardContainer" href="//www.douyin.com/video/<id>" target="_blank">` —— **div 假链接**，`a[href*="/video/"]` 一个都查不到。
- 页面上唯一的 `a[href*="/user/"]` 是自己的 `/user/self`。
- 推荐 feed（SPA 进入后）才有真实作者锚点（`a[href*="/user/MS4w..."]`）。

### 3. 站内跳 /user/ 达人主页一定是整页刷新

- 实测 4 种跳法（真实锚点去 target 点击 / 合成新锚点 / 劫持侧栏 SPA 锚点改 href / 视频浮层内昵称链接）：
  - 真实作者锚点：被 SPA 拦截改开**视频浮层**（URL 不变）；
  - 劫持侧栏锚点：路由写死，不跳；
  - 合成锚点 / 浮层昵称链接：跳到 /user/ 但 **window 标记丢失 = 整页刷新**。
- 结论：到达人页没有纯 SPA 路径，脚本内存状态必丢。
- **解法**：连刷会话持久化到 sessionStorage（`doa.feedSession.v1`），整页跳转后由 `main.ts -> FeedAutomation.resume()` 按页面类型续跑；停止/完成/出错清除会话，30 分钟过期，关标签页销毁（红线 v2 补充条款）。

### 4. 推荐页有新手引导浮层

- 首次 SPA 进推荐会弹「滚动鼠标…查看更多推荐视频 [我知道了]」，吞掉 feed 上的点击。进入后必须 `dismissFeedGuide()`。

### 5. IM 面板的两层 StackLayout 与 SDK 冷启动

- `[data-e2e="im-dialog"]` 关闭时仍残留 DOM，list/chat 两层常驻（`data-stack-layer`），`offsetParent` 判可见不可靠。
- 达人页加载早期 IM SDK 未就绪，点「私信」会被吞或落在**会话列表层**（聊天输入框不存在）。
- **解法**：达人页解析后等 4s 再操作；`openMessageDialog(nickname)` 15s 等输入框 → 列表层则点会话项（`ConversationItemwrapper` 行容器）再等 12s → 仍失败则关面板 3s 后整轮重试一次。
- 每次触达后 `closeMessageDialog()` 复位面板，避免下一位达人落到残留的列表层。

### 6. 发送按钮：svg 无 offsetParent + 忽略合成 .click()

- 真实发送按钮是 `svg.messageMsgInputpublishBtn`（填入文本后追加 `publishRedBtn`，class 含 `e2e-send-msg-btn`），无文本无 aria。
- **坑 1**：`offsetParent` 对 svg 恒为 `undefined`，可见性过滤把它误杀 → 表现为"发送按钮未找到"。必须用 `getBoundingClientRect().width > 0`。
- **坑 2**：该按钮**忽略合成 `.click()`**（点了文本还在输入框）。必须派发完整指针序列
  `pointerdown/mousedown/pointerup/mouseup/click`（打在 svg 与其 `inputAction` 宿主上）才触发发送。
- **坑 3**：SVGElement 没有 `.click()` 方法，`closeImPage` 直接调用抛 `TypeError: close.click is not a function`。统一 `dispatchEvent(new MouseEvent('click', ...))`。
- **结果校验**：发送成功后 Slate 输入框会被清空，以此确认发送（忽略零宽字符占位），防静默失败。

## 验证（V0.5.0 真实环境，chrome-profile 登录态，上限 1）

```
feed automation started
navigateTo: /user/MS4w...（整页跳转）
resume on /user/...: sent=0, visited=1        <- sessionStorage 续跑
creator detected {nickname: 野生放映厅, followers: 1377000}
message button clicked (attempt 1)
message filled, length = 27                    <- 自定义文案 {{nickname}} 渲染
send button event sequence dispatched
send confirmed (input cleared)                 <- 真实发出
message dialog closed
creator saved / outreach recorded / marked as SENT
sent 1/1: 野生放映厅 -> feed automation done, sent=1
```

## 修复清单

| 文件 | 改动 |
| --- | --- |
| `feed/feedAutomation.ts` | 重写为 sessionStorage 续跑架构（stepOnFeed/stepOnCreator/resume） |
| `douyin/adapter.ts` | +getRecommendNavLink/dismissFeedGuide/navigateTo/getImConversationItem；getSendButton 可见性改 getBoundingClientRect |
| `douyin/messageAdapter.ts` | openMessageDialog 列表层兜底+整轮重试；+closeMessageDialog；sendMessage 完整指针序列+发送确认 |
| `douyin/selectors.ts` | sendButton 校准（e2e-send-msg-btn/publishBtn）；+recommendNavLink |
| `core/observer.ts` | `/jingxuan` 识别为 HOME |
| `main.ts` | 启动时 `feedAuto.resume()`；v0.5.0 |

## 遗留

- 抖音平台限制：对方回复/关注前只能发 1 条文字（面板有提示）。重复触达同一人会被平台拦截，
  发送确认机制会把它判为失败并计入连续失败，属预期行为。
- 推荐 feed 连刷切换新视频后作者链接更新频率未充分验证（本次上限 1 未走到）。
