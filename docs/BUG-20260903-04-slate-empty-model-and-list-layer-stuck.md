# BUG-20260903-04 — 真实环境：列表层"卡住" + 发送被判「不能发送空白消息」

> 关联：REQ-20260903-02（连刷自动化）、BUG-20260903-02（连刷找不到达人+发送失效）、
> BUG-20260903-03（fab 缺失，V0.5.1 已解决注入问题）；
> 来源：2026-09-03 12:43 用户真实环境复测截图（达人页 糖果影视）。

## 现象

1. 连刷跳转到达人主页后，IM 面板落在**会话列表层**，脚本长时间无动作（"卡住"），
   直到用户手动点击会话头像才继续；
2. 用户点击头像进入聊天层后，私信文本被填入（视觉可见），
   但点击发送时抖音 toast 提示**「不能发送空白消息」**；
3. 附带发现：文案渲染为"我们是**，**目前正在寻找…"——`{{brand}}` 为空，
   用户未在设置中填写品牌名称（配置问题，非代码缺陷）。

## 根因

### 根因 1：fillMessage 用 `innerHTML = ''` 清空 Slate 编辑器（发送失败主因）

抖音私信输入框是 Slate.js 编辑器。旧实现先 `input.innerHTML = ''` 再
`execCommand('insertText')`——清空 innerHTML 会摧毁 Slate 的 `[data-slate-node]`
叶节点，模型与 DOM 失去映射后，insertText 只把文本写进 DOM（视觉有字），
Slate 内部模型仍为空；平台发送校验读模型 → 判「空白消息」。
此前 E2E（野生放映厅）成功是侥幸：空编辑器、无草稿时 Slate 可能自行重建节点。
旧兜底分支 `textContent = text` 同样只写 DOM 不写模型，必然触发同一问题。

### 根因 2：openMessageDialog 死等输入框 15s（"卡住"主因）

点「私信」落在会话列表层时，旧实现先 `waitForElement(input, 15000)` 干等，
15s 超时后才尝试点一次会话项。列表层停留期间用户看到的就是"卡住"。

## 修复（V0.5.2）

1. **fillMessage Slate 安全重写**：
   - 不再 innerHTML 清空；改为 `execCommand('selectAll')` 全选既有内容 ->
     `execCommand('insertText', text)` 替换插入，Slate 经原生 beforeinput 同步模型；
   - execCommand 失败时兜底改为合成 paste 事件（DataTransfer 纯文本，
     Slate 的 onPaste 会写入模型），**彻底移除 textContent 兜底**；
   - 填入后 sleep 400ms 等模型同步，并做视觉校验（编辑器仍空才返回 false）。
2. **openMessageDialog 轮询等待**：每 500ms 同时检查输入框与会话列表项，
   会话项一渲染出来就立即点击进入聊天层（总等待预算不变：15s + 点过后追加 12s）。
3. **getMessageInput 优先可见**：页面可能残留多个 im-dialog（隐藏旧面板），
   取第一个 getBoundingClientRect 可见的 Slate 编辑器，避免填入隐藏副本。
4. 失败提示文案修正：发送未确认时不再笼统说"发送按钮未找到"，
   标注三种可能（按钮未找到/被判空白消息/平台拦截）。

## 验证

- `npm run typecheck` 零错误；`npm run build` 产出 v0.5.2（82.2kb）；
- 真实环境端到端（连刷 -> 达人页 -> 填入 -> 发送）需用户更新脚本后复测。

## 遗留 / 用户侧事项

- **用户需在设置中填写品牌信息**（品牌名称/简介/产品等），否则 `{{brand}}` 等
  变量渲染为空，文案出现"我们是，目前正在寻找…"这种残缺句；
- 若 fill 主路径与 paste 兜底均失效，控制台会有
  `execCommand insert failed` / `fill verification failed` 日志，截图反馈即可。

## 状态：已修复（待用户复测确认）
