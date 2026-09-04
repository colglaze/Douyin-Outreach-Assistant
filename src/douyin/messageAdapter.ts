/**
 * MessageAdapter（文档第 6/12 章）：私信相关 DOM 操作。
 * 职责：打开私信窗口 -> 定位输入框 -> 稳定写入文本。
 * 注意边界（文档第 20 章）：默认只负责“填入”；开启自动发送后由上层执行一次有限发送。
 */
import { DouyinAdapter, type MessageSurface } from './adapter';
import { sleep } from '../utils/dom';
import { logger } from '../utils/logger';

const SCOPE = 'MessageAdapter';

export class MessageAdapter {
  private surface: MessageSurface | null = null;

  constructor(private adapter: DouyinAdapter) {}

  private currentSurface(): MessageSurface | null {
    if (this.surface?.dialog.isConnected && this.surface.input.isConnected
      && this.adapter.isVisible(this.surface.dialog) && this.adapter.isVisible(this.surface.input)
      && this.surface.dialog.contains(this.surface.input)) {
      return this.surface;
    }
    const latest = this.adapter.getMessageSurface();
    this.surface = latest;
    return latest;
  }

  private async waitForDialogGone(dialog: Element, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const stillVisible = this.adapter.isVisible(dialog);
      const current = this.adapter.getMessageSurface();
      if (!stillVisible && current?.dialog !== dialog) return;
      await sleep(200);
    }
  }

  private dispatchActivation(el: HTMLElement): void {
    const r = el.getBoundingClientRect();
    const opts: MouseEventInit = {
      bubbles: true, cancelable: true, view: window,
      clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
    };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, opts) : new MouseEvent(type, opts));
    }
  }

  private async waitForChatSurface(timeoutMs: number): Promise<MessageSurface | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const surface = this.adapter.getMessageSurface();
      if (surface) return surface;
      await sleep(300);
    }
    return null;
  }  /**
   * 点击"私信"按钮打开私信窗口，返回是否成功。
   * 传入 nickname 时，若面板落在会话列表层（BUG-20260903-02），自动点列表中
   * 对应会话项进入聊天层；首轮失败会关闭面板重试一次（实测达人页加载早期
   * IM SDK 未就绪会吞掉首次点击，等待+重试后可恢复）。
   */
  async openMessageDialog(nickname?: string, forceFresh = false): Promise<boolean> {
    const previous = this.surface?.dialog ?? this.adapter.getMessageDialog();
    if (forceFresh && previous) {
      this.surface = null;
      this.closeMessageDialog();
      await this.waitForDialogGone(previous, 2500);
    } else {
      this.surface = null;
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      const btn = this.adapter.getMessageButton();
      if (!btn) {
        logger.error(SCOPE, 'message button not found');
        return false;
      }
      // 作者页入口已有实测 plain click 证据；完整 pointer 序列可能触发重复 toggle。
      btn.click();
      logger.info(SCOPE, `message button clicked (attempt ${attempt})`);

      const deadline = Date.now() + 15000;
      let clickedItem = false;
      while (Date.now() < deadline) {
        const surface = this.adapter.getMessageSurface();
        // 直接聊天层可能在点击入口后立即出现；nickname 只用于列表层兜底，
        // 不能阻止已经可用的 direct-chat 成功返回。
        if (surface) {
          this.surface = surface;
          logger.info(SCOPE, nickname
            ? 'chat input ready (direct conversation opened)'
            : 'chat input ready');
          return true;
        }
        if (nickname && !clickedItem) {
          const item = this.adapter.getImConversationItem(nickname);
          if (item) {
            logger.info(SCOPE, `conversation item found, activating: ${nickname}`);
            this.dispatchActivation(item);
            clickedItem = true;
          }
        }
        if (clickedItem) {
          const chat = await this.waitForChatSurface(2500);
          if (chat) {
            this.surface = chat;
            logger.info(SCOPE, 'chat input ready after conversation activation');
            return true;
          }
          clickedItem = false;
        }
        await sleep(300);
      }

      if (attempt < 2) {
        logger.warn(SCOPE, 'open dialog failed, reset and retry...');
        this.closeMessageDialog();
        await sleep(3000);
      }
    }

    this.surface = null;
    logger.error(SCOPE, 'message input not found after opening dialog');
    return false;
  }

  /**
   * 关闭 IM 面板（BUG-20260903-02）。
   * 实测：发完不关闭时，面板状态会跨页面残留，导致下一个达人点"私信"落在列表层；
   * 每次触达后关闭面板可保证下一位达人从干净的聊天层开始。
   */
  closeMessageDialog(): void {
    const dialog = this.surface?.dialog ?? this.adapter.getMessageDialog();
    if (!dialog) return;
    const close = Array.from(dialog.querySelectorAll<HTMLElement>('[class*="closeImPage"]'))
      .find((el) => this.adapter.isVisible(el));
    if (close) {
      close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      this.surface = null;
      logger.info(SCOPE, 'message dialog closed');
    }
  }

  /**
   * 向私信输入框写入文本。
   * 抖音输入框为 Slate.js contenteditable（React 受控），直接赋值不会触发框架状态更新。
   * BUG-20260903-04：禁止 innerHTML 清空——那会摧毁 Slate 的 [data-slate-node] 叶节点，
   * 模型与 DOM 失去映射后 insertText 只写入 DOM（视觉有字、模型为空），
   * 发送时被平台判「不能发送空白消息」。
   * 正解：selectAll 全选既有内容 -> insertText 替换插入，Slate 经原生 beforeinput 同步模型；
   * 兜底用合成 paste 事件（Slate 的 onPaste 会把纯文本写入模型），
   * 绝不直接写 textContent（必然导致模型为空）。
   */
  /** 规范化编辑器文本：Slate 多行会用节点表示换行，校验时忽略零宽字符和空白差异。 */
  private normalizeEditorText(text: string): string {
    return text.replace(/[​‌‍﻿\s]/g, '');
  }

  /** 选中 Slate 编辑器既有内容，供写入前替换草稿（不破坏叶节点）。 */
  private selectEditorContents(input: HTMLElement): void {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  /** 合成 paste 写入：Slate 的 onPaste 会把多行纯文本拆分进模型（BUG-20260903-04 验证路径）。 */
  private pasteIntoSlate(input: HTMLElement, text: string): void {
    input.focus();
    this.selectEditorContents(input);
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    dt.setData('text/html', text.split(/\r\n|\r|\n/).map((l) => `<div>${l || '<br>'}</div>`).join(''));
    input.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt, bubbles: true, cancelable: true,
    }));
  }

  /** execCommand 兜底写入：多行分段插入，避免换行被 insertText 吞掉；不派发 Enter 键盘事件。 */
  private insertIntoSlate(input: HTMLElement, text: string): boolean {
    input.focus();
    this.selectEditorContents(input);
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    let ok = true;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) {
        ok = document.execCommand('insertText', false, lines[i]) && ok;
      }
      if (i < lines.length - 1) {
        ok = document.execCommand('insertLineBreak', false) && ok;
      }
    }
    return ok;
  }

  /** 校验同一编辑器中是否已有完整文案。 */
  private hasFullText(input: HTMLElement, expected: string): boolean {
    const actual = input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement
      ? input.value
      : input.textContent || '';
    return this.normalizeEditorText(actual) === this.normalizeEditorText(expected);
  }

  async fillMessage(text: string): Promise<boolean> {
    if (!text.trim()) {
      logger.warn(SCOPE, 'refusing to fill empty message');
      return false;
    }
    const surface = this.currentSurface();
    const input = surface?.input;
    if (!surface || !input) {
      logger.error(SCOPE, 'message input not found');
      return false;
    }
    if (!this.adapter.isVisible(input) || !surface.dialog.contains(input)) {
      logger.error(SCOPE, 'message surface became invalid before fill');
      this.surface = null;
      return false;
    }

    input.focus();
    await sleep(50);
    if (document.activeElement !== input) {
      logger.warn(SCOPE, 'message input could not receive focus');
    }

    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const proto = input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // 多行文本必须走 paste（insertText 会在首个换行截断）；单行仍用已验证的 insertText。
      const isMultiline = /\r|\n/.test(text);
      if (isMultiline) {
        this.pasteIntoSlate(input, text);
        await sleep(200);
        if (!this.hasFullText(input, text)) {
          logger.warn(SCOPE, 'paste insert incomplete, fallback to per-line insertText');
          const ok = this.insertIntoSlate(input, text);
          if (!ok) logger.warn(SCOPE, 'per-line insertText also reported failure');
        }
      } else {
        const ok = this.insertIntoSlate(input, text);
        if (!ok) logger.warn(SCOPE, 'single-line insertText reported failure');
      }
    }

    await sleep(500);
    if (!input.isConnected || !this.adapter.isVisible(input) || !surface.dialog.contains(input)) {
      logger.error(SCOPE, 'message input replaced during fill');
      this.surface = null;
      return false;
    }
    if (!this.hasFullText(input, text)) {
      const actual = input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement
        ? input.value
        : input.textContent || '';
      logger.error(SCOPE, `fill verification failed: expected ${text.length} chars, got ${actual.length} chars`);
      return false;
    }
    logger.info(SCOPE, `message filled, length = ${text.length}`);
    return true;
  }

  /**
   * 点击发送按钮发送当前已填入的消息（REQ-20260903-01）。
   * 实测发送按钮可能需要同时触发 svg 与 inputAction 宿主的完整事件序列。
   * 发送成功后输入框会被清空，以此做结果校验（防"点了但没发出去"的静默失败）。
   * 边界：只在"填入成功后"被上层调用，单次派发，不做重试轰炸。
   */
  private messageText(input: HTMLElement): string {
    return (input.textContent || (input as HTMLInputElement).value || '').replace(/[​‌‍﻿\s]/g, '');
  }

  /**
   * 等待输入框清空以确认发送。
   * V0.5.4（BUG-20260903-05）：发送成功后 Slate 常整树重渲染并替换编辑器节点，
   * 旧 input 断开不代表失败——此时改查当前可见 surface 的编辑器判空；
   * 连最新编辑器都找不到才判失败。
   */
  private async waitForInputClear(input: HTMLElement, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let current: HTMLElement | null = input;
    while (Date.now() < deadline) {
      if (!current || !current.isConnected) {
        current = this.adapter.getMessageSurface()?.input ?? null;
      }
      if (current && !this.messageText(current)) return true;
      await sleep(150);
    }
    const last = this.adapter.getMessageSurface()?.input ?? current;
    return !!last && !this.messageText(last);
  }

  async sendMessage(): Promise<boolean> {
    const surface = this.currentSurface();
    const input = surface?.input;
    let btn = surface?.sendButton;
    if (!surface || !input) {
      logger.error(SCOPE, 'send target not found in current message surface');
      return false;
    }
    const text = this.messageText(input);
    if (!text) {
      logger.error(SCOPE, 'refusing to send empty message');
      return false;
    }
    // React/Slate 重新渲染后发送按钮可能才变为红色；在同一 dialog 内等待它就绪。
    const deadline = Date.now() + 3000;
    while ((!btn || !this.adapter.isSendButtonReady(btn)) && Date.now() < deadline) {
      await sleep(250);
      const latest = this.adapter.getMessageSurface();
      if (latest?.dialog === surface.dialog) btn = latest.sendButton;
    }
    if (!btn || !this.adapter.isSendButtonReady(btn)) {
      logger.error(SCOPE, 'send button is not available; synthetic events cannot create trusted click');
      return false;
    }
    const host = (btn.closest('[class*="inputAction"]') as HTMLElement) || btn;
    // V0.5.4：恢复 V0.5.0 真实探针验证成功的激活路径——同一轮同时激活
    // SVG 与 inputAction 宿主，再等待结果。把两者拆成相隔数秒的两轮会丢失
    // Slate 当前 selection，且首轮无效后第二轮也可能仍不触发 React handler。
    input.focus();
    this.dispatchActivation(btn);
    if (host !== btn) this.dispatchActivation(host);
    logger.info(SCOPE, `send activation dispatched on target and host (synthetic=${!new MouseEvent('click').isTrusted})`);
    const sent = await this.waitForInputClear(input, 4500);
    if (sent) {
      logger.info(SCOPE, 'send confirmed (input cleared)');
      return true;
    }
    // V0.5.4：Slate 重渲染可能替换节点——以“当前可见 surface 的编辑器”为准判残留。
    const lastSurface = this.adapter.getMessageSurface();
    const lastInput = lastSurface?.input ?? (input.isConnected ? input : null);
    if (lastSurface && lastInput && !this.messageText(lastInput)) {
      logger.info(SCOPE, 'send confirmed (editor replaced, latest surface empty)');
      return true;
    }
    if (!lastSurface) {
      logger.warn(SCOPE, 'message surface replaced before send confirmation');
      this.surface = null;
      return false;
    }
    const residual = lastInput ? this.messageText(lastInput) : '';
    logger.error(SCOPE, `auto-send not accepted; input still has ${residual.length} chars, please click Send manually`);
    return false;
  }
}
