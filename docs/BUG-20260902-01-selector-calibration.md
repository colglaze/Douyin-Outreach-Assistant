# BUG-20260902-01 — 选择器与真实抖音页面不匹配（校准记录）

> 关联来源：REQ-20260902-01（MVP 功能 1/6）；关联方案：DEV-20260902-01 第 7 节已知风险。

## 现象

V0.1~V0.3 代码中的 `douyin/selectors.ts` 初版选择器基于对抖音旧版结构的推断，
在 2026-09-02 真实页面探测（Chrome 152 + CDP，匿名态，达人页 `/user/MS4wLjABAAAAFAR2jg6oYO_ScG_HWEl5simuM_YwaJh3fq8xohO3Qjw`）中**几乎全部未命中**。

## 探测结论（真实 DOM 取证）

| 字段 | 推断选择器（旧） | 真实结构（新，已实测命中） |
|------|------------------|---------------------------|
| 昵称 | `[data-e2e="user-name"]` ❌ | 页面唯一 `h1`（在 `[data-e2e="user-info"]` 内）✅ |
| 粉丝 | `[data-e2e="user-followers-count"]` ❌ | `[data-e2e="user-info-fans"]`，文本"粉丝113.2万" ✅ |
| 关注 | `[data-e2e="user-following-count"]` ❌ | `[data-e2e="user-info-follow"]`，文本"关注40" ✅ |
| 获赞 | `[data-e2e="user-likes-count"]` ❌ | `[data-e2e="user-info-like"]`，文本"获赞1105.1万" ✅ |
| 简介 | `[data-e2e="user-signature"]` ❌ | `[data-e2e="user-info"] p + div`（抖音号 <p> 的兄弟 div）✅ |
| 头像 | `[data-e2e="user-avatar"] img` ❌ | `[class*="avatar"] img` ✅ |
| 私信按钮 | `[data-e2e="user-message-btn"]` ❌ | `<button class="semi-button semi-button-secondary j85duc">私信</button>`，无 data-e2e，按文本匹配 ✅ |

达人页真实存在的 data-e2e 全集：
`user-detail / user-info / user-info-follow / user-info-fans / user-info-like / user-info-follow-btn / user-tab-count / user-work-tab / user-like-tab / user-post-list / douyin-navigation / searchbar-input / im-entry` 等。

## 根因

初版选择器为未经验证的合理推断（Phase 5 之前的预期内风险，见 DEV 第 7 节）。

## 修复

- `selectors.ts` 按上表右侧全部重写，并保留降级链；
- 排雷：`semi-button-secondary` 同时被"分享主页"使用，已从私信按钮候选中移除，避免误点；
- `parseChineseCount` 对"粉丝113.2万"这类粘连文本验证可正确解析为 1132000。

## 遗留（已解决 ✅，2026-09-02 登录态复测）

- **私信对话框** `messageDialog`：扫码登录后实测，`[data-e2e="im-dialog"]` 命中 ✅。
  注意其行为细节：点击"私信"后对话框可能先落在**会话列表层**（StackLayout list），
  聊天层异步加载，输入框最长 10s+ 才出现 → `messageAdapter.openMessageDialog` 等待已调至 12s。
- **私信输入框** `messageInput`：实测为 im-dialog 内的 **Slate.js 编辑器**：
  `<div class="zone-container editor-kit-container messageEditorinputArea"
        data-slate-editor="true" contenteditable="true" data-placeholder="发送消息">`
  已按此重写候选链（`[data-e2e="im-dialog"] div[data-slate-editor]` 优先）。
- **写入链路实测通过**：`execCommand('insertText')` 可被 Slate 的 beforeinput 正常接收，
  测试文案成功写入并已清空，未发送任何消息 ✅。
- **达人解析复测通过**：昵称/粉丝113.2万/关注40/获赞1105.1万/简介 全部与页面一致 ✅。

## 重要产品发现（已同步 PRD 风险项）

抖音私信限制：**"对方回复或关注你之前，只能发送一条文字消息"**。
这意味着第一条触达话术的质量极其关键，AI 个性化润色的价值被进一步放大；
同时"防重复联系"功能从"礼貌"升级为"刚需"——重复发等于浪费唯一的一次机会。

## 状态：已关闭（Phase 5 DoD 通过）

## 验证方式（可复用）

探测脚本：`.workbuddy/tmp/probe-*.mjs`（playwright-core 经 CDP 连接
`chrome.exe --remote-debugging-port=9222`，需 `NO_PROXY=127.0.0.1` 绕过沙箱代理）。
