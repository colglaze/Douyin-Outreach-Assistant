# DEV-20260902-01 — 技术方案：模块架构与阶段实施

> 关联：REQ-20260902-01、PRD.md。

## 1. 技术选型

TypeScript + Tampermonkey + IndexedDB（MVP）。esbuild 打包为单文件 `.user.js`。
选择 TS 而非纯 JS 的原因：DOM 适配器、达人模型、消息模型、事件系统需要类型约束降低后期维护成本。

## 2. 分层与依赖方向

```
ui/ (floatingButton, panel, toast)
  ↓ 只能用
creator/ message/ ai/ (业务服务)
  ↓ 只能用
douyin/ (selectors, adapter, creatorParser, messageAdapter)  ← 唯一触碰抖音 DOM 的层
  ↓ 只能用
core/ (eventBus, observer, router)  storage/ (indexedDb, settings)  utils/
```

## 3. 模块职责

| 模块 | 职责 | 关键接口 |
|------|------|----------|
| core/observer | SPA 页面监听（MutationObserver + URL 劫持 + 轮询兜底） | `detectPageType()` / `start()`，派发 `page:changed`、`dom:changed` |
| core/router | 语义化路由回调 | `on(type, handler)` |
| douyin/selectors | 选择器唯一出处，每项为候选数组降级 | 常量对象 |
| douyin/adapter | 达人字段读取、私信按钮/输入框定位 | `getCreatorName()` / `getFollowerCount()` / `getMessageButton()` / `getMessageInput()` |
| douyin/creatorParser | 解析当前达人主页为 `CreatorInfo` | `parse(): CreatorInfo \| null` |
| douyin/messageAdapter | 打开私信窗口、React 兼容写入文本 | `openMessageDialog()` / `fillMessage(text)` |
| storage/indexedDb | IndexedDB Promise 封装，3 个 store：creators/messages/settings | `put/get/getAll/del/byIndex` |
| creator/repository | 达人 CRUD，以 secUid 去重 | `exists(secUid)` / `getBySecUid()` / `save()` / `updateStatus()` |
| creator/service | 业务编排：同步页面达人、防重复判断 | `syncFromPage(info)` |
| message/templateEngine | `{{var}}` 变量替换 + 内置模板 | `render(content, vars)` |
| message/service | 私信记录 + 状态联动 | `recordOutreach(creatorId, content, templateId)` |
| ai/prompt | 润色 Prompt 构造（100字内/口语化/不编造） | `buildPolishMessages()` |
| ai/service | OpenAI 兼容接口调用（GM_xmlhttpRequest），失败静默降级 | `polish(text, creator)` |
| ui/panel | 悬浮面板全部交互 | `showForCreator(ctx)` / `hide()` |

## 4. 数据结构（src/types.ts）

- `CreatorInfo`：secUid / nickname / avatar / followers / following / likes / signature / url / tags
- `Creator`：CreatorInfo + id / status / note / lastContactAt / createdAt / updatedAt
- `OutreachMessage`：id / creatorId / type / content / templateId / createdAt / status
- `AppSettings`：brand / product / contact / wechat / category / ai* / debug

## 5. 私信执行流程（核心链路）

```
进入 /user/* → PageObserver 派发 → CreatorParser.parse()
→ creatorService.syncFromPage（查库：已联系？→ 防重复提醒）
→ 模板变量替换 → (可选) AI 润色 → 用户检查
→ 打开私信 → fillMessage → 用户人工发送
→ messageService.recordOutreach（status=CONTACTED）
```

## 6. 阶段划分与 DoD

| 阶段 | 内容 | DoD |
|------|------|-----|
| Phase 0 | 文档体系 | AGENTS.md / PRD / REQ / DEV / PROG 就位 |
| Phase 1 | 工程骨架 | tsc --noEmit 通过；esbuild 产出带油猴头的 user.js |
| Phase 2 | 核心链路（V0.1） | 达人页识别昵称/粉丝；悬浮按钮；打开私信并写入测试文字 |
| Phase 3 | V0.2 | IndexedDB 达人库 CRUD；模板变量替换；状态机流转 |
| Phase 4 | V0.3 | AI 润色（含降级）；防重复提醒；联系记录落库 |
| Phase 5 | 人工验证 | 在抖音网页版真实页面跑通第 5 节完整链路 |

## 7. 已知风险

- 抖音 DOM 选择器失效 → 所有选择器集中在 selectors.ts，候选数组降级 + logger 告警。
- 私信输入框 React 受控 → 原生 setter + input 事件 / execCommand 双路径写入。
- AI Key 暴露 → MVP 仅存本地 settings，正式版走 AI Gateway。
