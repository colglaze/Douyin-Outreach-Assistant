/**
 * 事件总线（文档第 22 章 core/eventBus.ts）。
 * 各模块之间不直接互相引用 DOM，统一通过事件通信。
 */

type Handler<T = unknown> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<string, Set<Handler>>();

  /** 订阅事件，返回取消订阅函数 */
  on<T>(event: string, handler: Handler<T>): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler as Handler);
    return () => this.off(event, handler as Handler);
  }

  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit<T>(event: string, payload?: T): void {
    this.handlers.get(event)?.forEach((h) => {
      try {
        h(payload);
      } catch (e) {
        console.error(`[DouyinOutreach][EventBus] handler error on "${event}"`, e);
      }
    });
  }
}

/** 全局单例 */
export const bus = new EventBus();

/** 全局事件名常量，避免字符串散落 */
export const Events = {
  /** 页面（路由）变化，payload: { type: PageType, url: string } */
  PAGE_CHANGED: 'page:changed',
  /** DOM 发生显著变化（防抖后），payload: null */
  DOM_CHANGED: 'dom:changed',
} as const;
