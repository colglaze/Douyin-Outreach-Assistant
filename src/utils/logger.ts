/**
 * 日志系统（文档第 24 章）—— 第一版即引入，方便抖音改版时定位问题。
 * 输出格式：[模块名] 消息 附加数据
 */

let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

function fmt(scope: string): string {
  return `[DouyinOutreach][${scope}]`;
}

export const logger = {
  info(scope: string, msg: string, ...data: unknown[]): void {
    console.log(fmt(scope), msg, ...data);
  },
  warn(scope: string, msg: string, ...data: unknown[]): void {
    console.warn(fmt(scope), msg, ...data);
  },
  error(scope: string, msg: string, ...data: unknown[]): void {
    console.error(fmt(scope), msg, ...data);
  },
  debug(scope: string, msg: string, ...data: unknown[]): void {
    if (debugEnabled) console.debug(fmt(scope), msg, ...data);
  },
};
