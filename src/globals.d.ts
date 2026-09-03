/** Tampermonkey 油猴 API 声明 */
declare function GM_xmlhttpRequest(details: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  timeout?: number;
  onload?: (resp: { status: number; responseText: string }) => void;
  onerror?: (err: unknown) => void;
  ontimeout?: () => void;
}): void;

declare function GM_addStyle(css: string): void;
declare function GM_setValue(key: string, value: unknown): void;
declare function GM_getValue(key: string, defaultValue?: unknown): unknown;
