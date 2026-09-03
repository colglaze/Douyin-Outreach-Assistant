/**
 * Router（文档第 22 章 core/router.ts）。
 * 订阅 PageObserver 事件，向上层提供"进入某类页面"的语义化回调注册。
 */
import { bus, Events } from './eventBus';
import type { PageType } from '../types';

export interface RoutePayload {
  type: PageType;
  url: string;
}

type RouteHandler = (payload: RoutePayload) => void;

export class Router {
  private handlers = new Map<PageType | '*', Set<RouteHandler>>();

  constructor() {
    bus.on<RoutePayload>(Events.PAGE_CHANGED, (p) => this.dispatch(p));
  }

  /** 注册某类页面的回调；type 传 '*' 表示所有页面 */
  on(type: PageType | '*', handler: RouteHandler): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
  }

  private dispatch(payload: RoutePayload): void {
    this.handlers.get(payload.type)?.forEach((h) => h(payload));
    this.handlers.get('*')?.forEach((h) => h(payload));
  }
}
