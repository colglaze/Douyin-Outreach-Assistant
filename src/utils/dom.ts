/**
 * DOM 工具函数。SPA 页面元素异步渲染，统一通过 waitForElement 等待。
 */

/** 轮询等待元素出现，超时返回 null */
export function waitForElement<T extends Element = Element>(
  selector: string,
  timeoutMs = 5000,
  root: ParentNode = document,
): Promise<T | null> {
  return new Promise((resolve) => {
    const found = root.querySelector<T>(selector);
    if (found) return resolve(found);

    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      const el = root.querySelector<T>(selector);
      if (el) {
        clearTimeout(timer);
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/** 依次尝试多个候选选择器，返回第一个命中的元素（配合 selectors.ts 的降级策略） */
export function queryFirst<T extends Element = Element>(
  candidates: string[],
  root: ParentNode = document,
): T | null {
  for (const sel of candidates) {
    const el = root.querySelector<T>(sel);
    if (el) return el;
  }
  return null;
}

/** 在元素集合中按文本内容查找（如查找包含“私信”的按钮） */
export function findByText<T extends HTMLElement = HTMLElement>(
  selector: string,
  text: string,
  root: ParentNode = document,
): T | null {
  const els = root.querySelectorAll<T>(selector);
  for (const el of Array.from(els)) {
    if ((el.textContent || '').trim().includes(text)) return el;
  }
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 生成带前缀的唯一 ID */
export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
