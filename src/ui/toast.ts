/**
 * Toast 轻提示（文档第 22 章 ui/toast.ts）。
 */

type ToastType = 'info' | 'success' | 'warn' | 'error';

const COLORS: Record<ToastType, string> = {
  info: '#333',
  success: '#0a8a3a',
  warn: '#b26a00',
  error: '#c02c2c',
};

export function showToast(message: string, type: ToastType = 'info', durationMs = 2600): void {
  const el = document.createElement('div');
  el.textContent = message;
  el.style.cssText = [
    'position:fixed',
    'top:64px',
    'left:50%',
    'transform:translateX(-50%)',
    `background:${COLORS[type]}`,
    'color:#fff',
    'padding:8px 16px',
    'border-radius:8px',
    'font-size:13px',
    'z-index:9999999',
    'box-shadow:0 4px 12px rgba(0,0,0,.25)',
    'transition:opacity .3s',
    'pointer-events:none',
  ].join(';');
  document.body.appendChild(el);
  window.setTimeout(() => {
    el.style.opacity = '0';
    window.setTimeout(() => el.remove(), 350);
  }, durationMs);
}
