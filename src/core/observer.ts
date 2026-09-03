/**
 * PageObserver（文档第 5.1 章）。
 * 抖音是 SPA：不能只依赖 window.onload，需要同时监听 URL 变化与 DOM 变化。
 * 其他模块不直接监听 DOM，统一由本模块管理并派发事件。
 */
import { bus, Events } from './eventBus';
import type { PageType } from '../types';
import { logger } from '../utils/logger';

const SCOPE = 'PageObserver';

export class PageObserver {
  private lastUrl = location.href;
  private lastPageType: PageType = 'UNKNOWN';
  private mutationObserver: MutationObserver | null = null;
  private urlCheckTimer: number | null = null;
  private domDebounceTimer: number | null = null;

  /** 根据 URL 识别页面类型（文档 5.1：HOME/SEARCH/CREATOR/VIDEO/MESSAGE/UNKNOWN） */
  detectPageType(url: string = location.href): PageType {
    try {
      const path = new URL(url).pathname;
      if (path.startsWith('/user/')) return 'CREATOR';
      if (path.startsWith('/search')) return 'SEARCH';
      if (path.startsWith('/video/') || path.startsWith('/note/')) return 'VIDEO';
      if (path.startsWith('/im')) return 'MESSAGE';
      // BUG-20260903-02：/jingxuan（精选）是打开 / 后的 302 落地页，与推荐 feed
      // 一样属于首页场景，面板应展示连刷视图
      if (path === '/' || path === '' || path === '/jingxuan') return 'HOME';
      return 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  }

  /** 启动监听：URL（pushState/replaceState/popstate/轮询兜底）+ MutationObserver */
  start(): void {
    this.patchHistory();
    window.addEventListener('popstate', this.onUrlMaybeChanged);
    window.addEventListener('hashchange', this.onUrlMaybeChanged);
    // 轮询兜底：部分 SPA 导航不触发任何事件
    this.urlCheckTimer = window.setInterval(this.onUrlMaybeChanged, 800);
    this.observeDOM();

    // 首次派发当前页面
    this.lastPageType = this.detectPageType();
    bus.emit(Events.PAGE_CHANGED, { type: this.lastPageType, url: this.lastUrl });
    logger.info(SCOPE, `started, initial page = ${this.lastPageType}`);
  }

  stop(): void {
    window.removeEventListener('popstate', this.onUrlMaybeChanged);
    window.removeEventListener('hashchange', this.onUrlMaybeChanged);
    if (this.urlCheckTimer !== null) window.clearInterval(this.urlCheckTimer);
    this.mutationObserver?.disconnect();
  }

  /** 劫持 history 以捕获 SPA 路由跳转 */
  private patchHistory(): void {
    const fire = () => this.onUrlMaybeChanged();
    (['pushState', 'replaceState'] as const).forEach((name) => {
      const original = history[name];
      history[name] = function (this: History, ...args: Parameters<History['pushState']>) {
        const ret = original.apply(this, args);
        fire();
        return ret;
      } as History['pushState'];
    });
  }

  private onUrlMaybeChanged = (): void => {
    if (location.href === this.lastUrl) return;
    this.lastUrl = location.href;
    const type = this.detectPageType();
    if (type !== this.lastPageType) {
      logger.info(SCOPE, `page changed: ${this.lastPageType} -> ${type}`);
      this.lastPageType = type;
    }
    // URL 变化即使类型不变（如达人A -> 达人B），也要通知业务层重新解析
    bus.emit(Events.PAGE_CHANGED, { type, url: this.lastUrl });
  };

  private observeDOM(): void {
    this.mutationObserver = new MutationObserver(() => {
      // 防抖 500ms，避免高频 DOM 更新造成性能问题
      if (this.domDebounceTimer !== null) window.clearTimeout(this.domDebounceTimer);
      this.domDebounceTimer = window.setTimeout(() => {
        bus.emit(Events.DOM_CHANGED, null);
      }, 500);
    });
    this.mutationObserver.observe(document.body, { childList: true, subtree: true });
  }
}
