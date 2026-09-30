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

## 8. 交友模式扩展（REQ-20260929-01）

- `CreatorInfo` 增加明确性别及粉丝数是否成功识别；`AppSettings` 增加模式、目标性别、粉丝范围和交友文案。
- `douyin/adapter.ts` 只读取主页明确性别标识；`creator/` 的纯筛选函数决定是否匹配；`feed/` 在打开 IM 前应用筛选。
- 复用现有 sessionStorage 连刷会话、IndexedDB 设置与消息记录，不新增后端或存储表。

## 9. 作品线索识别（REQ-20260929-02）

- `douyin/adapter.ts` 从 `[data-e2e="user-post-list"]` 提取作品标题和封面；`ui/` 通过 `main.ts` 动作读取，不碰抖音 DOM。
- `creator/workGenderClues.ts` 对明确第一人称自述做纯文本判断；`ai/workCoverReader.ts` 可选地向用户配置的图像模型请求封面可见文字。
- 合并结果只在面板展示；确认沿用已有 `onSetGender` 本地标记，自动连刷不直接使用未确认的作品建议。
# REQ-20260929-03 实施补充

- `AppSettings` 增加本地自定义模板列表、商务/交友连刷来源模式及交友模板 ID；旧商务自定义文案通过加载迁移保持优先级。
- `message/templateEngine.ts` 负责模板查找、增删改与连刷文案来源解析；`ui/panel.ts` 只负责编辑草稿与交互，`feed/feedAutomation.ts` 使用统一解析结果。
- 草稿仅在当前页面内按达人 ID 缓存，不等同于持久模板；内置模板只读。更新模板时持久化原始编辑文本，变量在面向达人填入或连刷发送时展开。
# REQ-20260929-04 实施补充

- `ai/providerPresets.ts` 保存可验证的端点、默认模型和已知图像能力；UI 切换提供商时填入端点/模型并清空旧 Key。
- 不扩展 `AppSettings`：现有 `aiEndpoint`、`aiModel`、`aiApiKey` 可表示所有兼容提供商；从端点和模型推导当前快捷选项。
- `workCoverReader.ts` 在已知文字模型上跳过图像请求；未知自定义模型维持原有调用方式并让调用失败安全降级。
# REQ-20260929-05 实施补充

- 连刷模式为本次运行选择，并随 `sessionStorage` 会话保存；旧会话缺少模式字段时按限量恢复。无需增加持久设置字段。
- `FeedAutomation` 的条数结束和交友访问 50 主页结束仅在限量模式触发；持续模式仍在故障、连续失败或手动停止时退出。
- 访问总数与最近访问链接分开存储，链接集合最多 1000 条；长期运行的同标签页会话不会因链接表无限增长而耗尽存储。
- 在打开、填入与发送之间检查运行态与自动发送开关，手动停止不触发下一次发送。
