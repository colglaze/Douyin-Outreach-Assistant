/**
 * 悬浮按钮（文档第 8 章）：页面右侧悬浮入口，点击展开/收起达人面板。
 * BUG-20260903-03：按钮本体带版本角标（截图即可确认实际运行版本）、
 * 防重复注入去重、ensureMounted 自愈重挂载。
 */

export class FloatingButton {
  private el: HTMLDivElement;
  private onToggle: () => void;
  private version: string;

  constructor(onToggle: () => void, version: string) {
    this.onToggle = onToggle;
    this.version = version;
    // 防重复注入：同一页面只保留一个悬浮按钮（重复注入时旧节点会让用户看到旧版本角标）
    document.getElementById('doa-fab')?.remove();
    this.el = this.render();
    document.body.appendChild(this.el);
  }

  private render(): HTMLDivElement {
    const el = document.createElement('div');
    el.id = 'doa-fab';
    el.title = `抖音达人商务助手 v${this.version}（点击展开/收起面板）`;
    el.style.cssText = [
      'position:fixed',
      'right:16px',
      'top:45%',
      'z-index:9999998',
      'background:linear-gradient(135deg,#fe2c55,#ff6b9d)',
      'color:#fff',
      'padding:10px 12px',
      'border-radius:12px',
      'font-size:13px',
      'font-weight:600',
      'cursor:pointer',
      'box-shadow:0 4px 14px rgba(254,44,85,.4)',
      'user-select:none',
      'writing-mode:vertical-lr',
      'letter-spacing:2px',
    ].join(';');

    const label = document.createElement('span');
    label.textContent = '达人助手';
    el.appendChild(label);

    // 版本角标：用户截图即可确认 Tampermonkey 中实际运行的脚本版本
    const badge = document.createElement('span');
    badge.textContent = `v${this.version}`;
    badge.style.cssText = [
      'position:absolute',
      'left:-6px',
      'bottom:-6px',
      'writing-mode:horizontal-tb',
      'letter-spacing:0',
      'font-size:9px',
      'font-weight:400',
      'line-height:1.4',
      'padding:0 4px',
      'border-radius:6px',
      'background:rgba(0,0,0,.75)',
      'color:#fff',
      'pointer-events:none',
    ].join(';');
    el.appendChild(badge);

    el.addEventListener('click', () => this.onToggle());
    return el;
  }

  /** 自愈：抖音 SPA 重绘若移除外部挂载节点，重新挂回 body */
  ensureMounted(): void {
    if (!this.el.isConnected && document.body) {
      document.body.appendChild(this.el);
    }
  }

  setVisible(visible: boolean): void {
    this.el.style.display = visible ? 'block' : 'none';
  }
}
