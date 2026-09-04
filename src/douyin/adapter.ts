/**
 * DouyinAdapter（文档第 6 章）—— 整个项目最重要的模块。
 * 所有抖音相关 DOM 操作全部封装在此，业务代码禁止直接 document.querySelector。
 * 抖音改版时只需修改本文件与 selectors.ts。
 */
import { selectors, type SelectorKey } from './selectors';
import { queryFirst, findByText } from '../utils/dom';
import { parseChineseCount } from '../utils/number';
import { logger } from '../utils/logger';

const SCOPE = 'DouyinAdapter';

/** 当前可见 IM surface；输入框、发送按钮必须来自同一个对话框。 */
export interface MessageSurface {
  dialog: Element;
  input: HTMLElement;
  sendButton: HTMLElement | null;
}

export class DouyinAdapter {
  /** 抖音 DOM 的可见性：不能依赖 offsetParent（SVG/StackLayout 会误判）。 */
  isVisible(el: Element): boolean {
    if (!el.isConnected) return false;
    for (let node: Element | null = el; node; node = node.parentElement) {
      if ((node as HTMLElement).hidden || node.getAttribute('aria-hidden') === 'true') return false;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  private messageDialogs(root: ParentNode = document): Element[] {
    const candidates = Array.from(root.querySelectorAll<Element>(
      (selectors.messageDialog as unknown as string[]).join(','),
    ));
    return candidates.filter((dialog) => this.isVisible(dialog));
  }

  private inputsIn(root: ParentNode): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(
      (selectors.messageInput as unknown as string[]).join(','),
    )).filter((el) => this.isUsableInput(el));
  }

  /** 可交互的聊天编辑器；可见但 disabled 的占位输入框不算已进入聊天层。 */
  private isUsableInput(el: HTMLElement): boolean {
    if (!this.isVisible(el)) return false;
    if ((el as HTMLInputElement | HTMLTextAreaElement).disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    return el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  }
  /** 通用：按选择器键取元素（自动按候选数组降级） */
  protected query<K extends SelectorKey>(
    key: K,
    root: ParentNode = document,
  ): Element | null {
    const el = queryFirst(selectors[key] as unknown as string[], root);
    if (!el) logger.debug(SCOPE, `selector miss: ${key}`);
    return el;
  }

  /** 取元素文本 */
  protected textOf(key: SelectorKey, root: ParentNode = document): string {
    return (this.query(key, root)?.textContent || '').trim();
  }

  // ---------- 达人主页字段 ----------

  getCreatorName(): string {
    return this.textOf('creatorName');
  }

  /** 从 URL 提取 secUid：/user/<secUid> */
  getCreatorSecUid(): string {
    const m = location.pathname.match(/^\/user\/([^/?]+)/);
    return m ? m[1] : '';
  }

  getCreatorUrl(): string {
    return location.href.split('?')[0];
  }

  getAvatar(): string {
    const img = this.query('avatar') as HTMLImageElement | null;
    return img?.src || '';
  }

  getSignature(): string {
    return this.textOf('signature');
  }

  /**
   * 粉丝数：优先专用选择器；兜底在主页统计区文本中找 "粉丝 xx万"。
   */
  getFollowerCount(): number {
    const direct = this.textOf('followerCount');
    if (direct) return parseChineseCount(direct);
    const fallback = this.extractCountByLabel('粉丝');
    if (fallback === null) logger.warn(SCOPE, 'follower count not found');
    return fallback ?? 0;
  }

  getFollowingCount(): number {
    const direct = this.textOf('followingCount');
    if (direct) return parseChineseCount(direct);
    return this.extractCountByLabel('关注') ?? 0;
  }

  getLikesCount(): number {
    const direct = this.textOf('likesCount');
    if (direct) return parseChineseCount(direct);
    return this.extractCountByLabel('获赞') ?? 0;
  }

  /** 在页面文本中查找 "<label> <数字>" 结构（如 "粉丝 18.6万"） */
  private extractCountByLabel(label: string): number | null {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = (node.textContent || '').trim();
      if (t === label || t.startsWith(label)) {
        // 数字通常在相邻兄弟节点或同一文本内
        const parent = node.parentElement;
        const around = `${t} ${parent?.textContent || ''}`;
        const m = around.match(/([\d.,万wW千kK]+)/);
        if (m) return parseChineseCount(m[1]);
      }
    }
    return null;
  }

  // ---------- 私信操作 ----------

  /** 查找"私信"按钮：必须是可见且确实包含目标文本的按钮。 */
  getMessageButton(): HTMLElement | null {
    const candidates = [
      ...Array.from(document.querySelectorAll<HTMLElement>(
        (selectors.messageButton as unknown as string[]).join(','),
      )),
      ...Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]')),
    ];
    return candidates.find((el) => this.isVisible(el) && (el.textContent || '').trim().includes('私信')) ?? null;
  }

  /** 当前可见 IM 对话框；优先含聊天输入框、且更靠后的活动层。 */
  getMessageDialog(): Element | null {
    const dialogs = this.messageDialogs();
    return [...dialogs].reverse().find((dialog) => this.inputsIn(dialog).length > 0)
      ?? dialogs[dialogs.length - 1]
      ?? null;
  }

  /**
   * 获取同一个 IM surface 中的对话框、输入框和发送按钮。
   * 抖音会在 DOM 中保留多个 StackLayout/dialog，所有消息操作必须使用同一层，
   * 不能分别从全局 DOM 查询，否则会出现“视觉有字但实际发送空消息”。
   */
  getMessageSurface(root: ParentNode = document): MessageSurface | null {
    const dialogs = this.messageDialogs(root);
    for (const dialog of [...dialogs].reverse()) {
      const input = this.inputsIn(dialog)[0];
      if (input) {
        return { dialog, input, sendButton: this.getSendButtonIn(dialog) };
      }
    }
    return null;
  }

  /** 当前可见聊天输入框；没有可见输入框时返回 null，不回退到隐藏副本。 */
  getMessageInput(): HTMLElement | null {
    return this.getMessageSurface()?.input ?? null;
  }

  /** 发送按钮必须处于可用状态；灰色占位图标不能触发自动发送。 */
  isSendButtonReady(el: HTMLElement): boolean {
    if (!this.isVisible(el)) return false;
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return false;
    const cls = el.getAttribute('class') || '';
    return !cls.includes('publishBtn') || cls.includes('publishRedBtn') || cls.includes('e2e-send-msg-btn');
  }

  /** 在指定 IM surface 内查找可见发送按钮。 */
  private getSendButtonIn(root: ParentNode): HTMLElement | null {
    const candidates = Array.from(root.querySelectorAll<HTMLElement>(
      (selectors.sendButton as unknown as string[]).join(','),
    )).filter((el) => this.isVisible(el));
    // 发送图标通常同时存在灰色 publishBtn 与可发送的 publishRedBtn，
    // 优先返回后者，避免在按钮尚未 ready 时提前触发事件。
    return candidates.sort((a, b) => {
      const aReady = /publishRedBtn|send-msg-btn/.test(a.getAttribute('class') || '');
      const bReady = /publishRedBtn|send-msg-btn/.test(b.getAttribute('class') || '');
      return Number(bReady) - Number(aReady);
    })[0]
      ?? Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"]'))
        .find((el) => this.isVisible(el) && (el.textContent || '').trim().includes('发送'))
      ?? null;
  }

  /**
   * 查找私信"发送"按钮（REQ-20260903-01，2026-09-03 取证校准）。
   * 优先从当前可见 IM surface 返回，避免按钮与输入框来自不同残留面板。
   */
  getSendButton(): HTMLElement | null {
    return this.getMessageSurface()?.sendButton ?? null;
  }

  /**
   * IM 面板会话列表层中按昵称定位会话项（BUG-20260903-02）。
   * 场景：面板 SDK 未就绪时点"私信"可能落在列表层而不是目标聊天层，
   * 需要点列表中对应会话项进入聊天层。
   * 实测结构：会话行容器为 div[class*="ConversationItemwrapper"]，
   * 点击行容器（而非内部文本节点）才能可靠触发进入聊天层。
   */
  /** 查找当前可见列表层中的目标会话项；不能由聊天 surface 的首个 dialog 决定。 */
  getImConversationItem(nickname: string): HTMLElement | null {
    const normalized = nickname.trim();
    if (!normalized) return null;
    for (const dialog of this.messageDialogs()) {
      const wrappers = Array.from(dialog.querySelectorAll<HTMLElement>(
        '[class*="ConversationItemwrapper"], [class*="conversationItem"]',
      )).filter((el) => this.isVisible(el));
      const wrapper = wrappers.find((el) => {
        const text = (el.textContent || '').trim();
        return text === normalized || text.startsWith(`${normalized} `) || text.startsWith(`${normalized}\n`);
      });
      if (wrapper) return wrapper;

      // 仅在该层没有可用聊天输入框时使用文本兜底，避免把聊天标题/消息正文当作列表项。
      if (this.inputsIn(dialog).length > 0) continue;
      const match = Array.from(dialog.querySelectorAll<HTMLElement>('*'))
        .filter((el) => {
          if (!this.isVisible(el)) return false;
          const text = (el.textContent || '').trim();
          return text === normalized || text.startsWith(`${normalized} `) || text.startsWith(`${normalized}\n`);
        })
        .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
      const item = wrapper && this.isVisible(wrapper) ? wrapper : match;
      if (item) return item;
    }
    return null;
  }

  /**
   * 推荐页 feed 中的达人主页链接（REQ-20260903-02）。
   * 选择器集中在 selectors.feedAuthorLinks，这里只做去重与排除自己的过滤。
   */
  getFeedAuthorLinks(): HTMLAnchorElement[] {
    const sel = (selectors.feedAuthorLinks as unknown as string[])[0];
    const seen = new Set<string>();
    return Array.from(document.querySelectorAll<HTMLAnchorElement>(sel)).filter((a) => {
      const url = a.href.split('?')[0];
      if (url.includes('/user/self') || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
  }

  // ---------- 推荐 feed 导航（BUG-20260903-02 实测补充） ----------

  /**
   * 侧栏「推荐」导航锚点。
   * 实测：打开 / 会 302 到 /jingxuan（精选），推荐 feed 只能点该锚点 SPA 进入（无刷新）。
   */
  getRecommendNavLink(): HTMLAnchorElement | null {
    return this.query('recommendNavLink') as HTMLAnchorElement | null;
  }

  /**
   * 关闭推荐 feed 的新手引导浮层（"滚动鼠标…查看更多推荐视频 [我知道了]"）。
   * 浮层会遮挡/吞掉 feed 上的点击，进入推荐后必须调用一次；不存在则静默跳过。
   */
  dismissFeedGuide(): void {
    const btn =
      findByText('button', '我知道了') ||
      findByText('span', '我知道了') ||
      findByText('div', '我知道了');
    if (btn && btn.offsetParent) {
      btn.click();
      logger.info(SCOPE, 'feed guide overlay dismissed');
    }
  }

  /**
   * 切换推荐 feed 的下一条视频（V0.5.4 真实页面取证）。
   * 合成 ArrowDown/WheelEvent 不会被抖音轮播接收；`video-switch-next-arrow`
   * 控件接受完整 pointer/mouse 激活序列。返回 false 时由业务层计为空轮次。
   */
  activateNextFeedVideo(): boolean {
    const btn = this.query('feedNextButton') as HTMLElement | null;
    if (!btn || !this.isVisible(btn) || btn.classList.contains('disabled')) {
      logger.warn(SCOPE, 'feed next-video control not available');
      return false;
    }
    const rect = btn.getBoundingClientRect();
    const options: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      clientX: rect.x + rect.width / 2,
      clientY: rect.y + rect.height / 2,
    };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      btn.dispatchEvent(type.startsWith('pointer')
        ? new PointerEvent(type, options)
        : new MouseEvent(type, options));
    }
    logger.info(SCOPE, 'feed next-video control activated');
    return true;
  }

  /**
   * 站内整页跳转。
   * 实测（BUG-20260903-02）：抖音跳 /user/ 达人主页一定是整页刷新（SPA 不接管），
   * 合成锚点点击是最稳定的触发方式；调用方需自行持久化状态（sessionStorage 续跑）。
   */
  navigateTo(url: string): void {
    const a = document.createElement('a');
    a.href = url;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    logger.info(SCOPE, `navigateTo: ${url.slice(0, 60)}`);
  }
}
