# BUG-20260903-05 — IM 残留面板导致聊天层与输入层错位

> 关联：BUG-20260903-04、REQ-20260903-02；状态：代码已修复，待用户在登录态复测。

## 现象

1. 连刷跳转到达人主页后，私信面板停留在会话列表层，无法自动进入目标聊天；
2. 聊天窗口中看见文案已填入，但发送时提示“不能发送空消息”。

## 补充根因

抖音会在 DOM 中保留多个 IM StackLayout/dialog。旧逻辑的输入框等待使用逗号选择器的首个匹配节点，且在没有可见节点时回退到隐藏节点；发送按钮和关闭按钮又可能从另一个 dialog 全局查找。因此可能出现：文案写入隐藏 Slate 编辑器，当前可见聊天模型仍为空，平台判定空消息。会话行使用 `offsetParent` 也可能漏掉列表层中实际可见的目标项。

## V0.5.3 修复

- `DouyinAdapter` 统一枚举可见 IM dialog，并以同一 `MessageSurface` 返回 dialog、input、send button；
- 可见性检查覆盖连接状态、尺寸、计算样式、`hidden` 和 `aria-hidden`，不再依赖 `offsetParent`；
- 移除隐藏输入框兜底；打开、填入、发送、关闭复用同一 surface；
- Slate 写入前把 Selection 锚定到目标编辑器，保留非破坏性 `execCommand('insertText')` 与 paste 兜底；
- 会话项改为可见性检查并在聊天输入层存在时不误判列表层；
- 达人页续跑等待真实解析出的 secUid/昵称，而不是任意 h1。

## V0.5.3 最新复测：入口被误关闭

用户反馈最新版本已无法进入私信页面。根因进一步确认：作者页“私信”入口的已有探针证据是普通 `button.click()`；上一版将完整 pointer/mouse 序列也用于该入口，可能在 pointerdown/click 双重处理时触发重复 toggle。同时 fresh 模式关闭旧 dialog 后未等待其消失，轮询可能把旧层误认为新层。

本轮调整：作者页入口恢复普通 `.click()`；完整事件序列仅保留给已取证需要它的会话 wrapper；fresh 清理保留旧 dialog 引用并等待其隐藏/断开后再点击；可见 surface 按 DOM 后出现的活动层优先选择。

## 最新复测：多行文案只填到首句

用户确认聊天窗口可打开，但填入的多行私信只显示“你好 高原奇迹所，”一段，后续正文缺失，脚本未发送。根因：多行模板通过单次 `insertText` 写入，Slate 在首个换行处截断；旧校验只检查非空或前 8 字符，导致半成品被当作成功。

本轮修复：多行文本优先走 `paste`（同时带 text/plain 与 text/html），Slate 的 onPaste 会把换行拆分成块写入模型；填入后做完整规范化比对（忽略零宽字符和换行差异），不完整则回退逐行插入，仍不完整才判失败且不发送。单行仍用已验证的 insertText。
- 会话项和作者页入口统一使用一次完整 pointer/mouse 激活序列，并等待聊天 surface；
- 连刷新作者强制清理旧 surface，避免残留聊天导致跳过当前作者入口；
- 自动发送失败时保留当前聊天窗口和已填文案，提示用户人工发送，不继续关闭窗口或回到 feed；
- 发送按钮等待同一 dialog 内的可用状态，避免点击灰色占位按钮。

状态：作者页/列表层修复已加入，自动发送仍受浏览器 `isTrusted` 限制，需真实页面复测确认。

## V0.5.4 修复：发送成功被误判为失败，连刷一单即停

用户复测确认多行文案填入已完整（V0.5.3 生效），但自动发送后连刷不再继续。

### 根因（代码走查定位）

发送成功的确认逻辑以**填入时的编辑器节点**为判据：`waitForInputClear` 中
`if (!input.isConnected) return false`。而 V0.5.3 起 多行文案走 paste 路径，
Slate 模型为多块结构——**发送成功后 Slate 会清空并整树重渲染，直接替换
contenteditable 节点**，旧节点断开 ≠ 未发送。旧逻辑把"节点被替换"当成
"发送未被接受"返回 false，`outreachOnce` 随即 `fail()` 置 ERROR 并清除
sessionStorage 会话，表现为：填入成功、消息可能实际已发出，但脚本报
"自动发送未被平台接受"，连刷停止、不再回推荐页。

（V0.5.0 E2E 能通过是侥幸：单行 insertText 填入后发送不一定触发整树替换，
节点保持连接，输入框清空被正确读到。）

### 修复

- `MessageAdapter.waitForInputClear`：填入时的节点断开后，改为持续改查
  **当前可见 surface 的编辑器**判空；以最新可见编辑器为空确认发送成功；
- `MessageAdapter.sendMessage`：两轮激活都未确认时，落判前重新探测当前
  surface——最新编辑器为空即确认发送（`editor replaced, latest surface empty`），
  连 surface 都不存在才报"被替换前未确认"；
- `MessageAdapter.sendMessage`：恢复 V0.5.0 真实探针已验证的发送方式——先聚焦
  编辑器，再在同一轮对发送 SVG 和 `inputAction` 宿主派发完整激活序列；
- 推荐页“切下一条”新增真实取证：合成 `ArrowDown` / `WheelEvent` 对 feed 无效；
  改点 `[data-e2e="video-switch-next-arrow"]`（候选选择器集中在 selectors.ts），
  登录态探针确认播放索引 0→1、下一视频进入可视区、作者链接 2→3；
- 发送结果确认：host 与 SVG 同轮激活后统一等待最新可见编辑器判空，避免
  拆成两轮丢失 Slate selection，也避免超时后二次点击导致重复触发。

### 待用户复测

1. 更新到 v0.5.4，推荐页启动连刷；
2. 预期日志链：`message filled` -> `send activation dispatched` ->
   `send confirmed (input cleared)` 或 `send confirmed (editor replaced...)` ->
   `message dialog closed` -> `sent N/M: 昵称` -> `返回推荐页…` ->
   继续下一位，直到达到单会话上限；
3. 若仍停在"自动发送未被平台接受"，控制台会有 `input still has N chars`，
   截图反馈（此时才需要怀疑 isTrusted 拦截）。
