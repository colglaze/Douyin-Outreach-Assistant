/**
 * 达人面板（文档第 8 章）：悬浮工具栏展开后的主交互界面。
 * 展示达人资料 / 模板选择 / AI优化 / 打开私信 / 填入私信 / 状态管理 / 加入达人库 / 防重复提醒。
 *
 * 依赖方向纪律（AGENTS.md 第 5 节）：UI 不直接操作抖音 DOM，
 * 私信相关动作通过回调委托给 main.ts 中的 MessageAdapter。
 */
import type { AppSettings, ContactStatus, MessageTemplate } from '../types';
import { CONTACT_STATUS_FLOW, CONTACT_STATUS_LABEL } from '../types';
import type { CreatorPageContext } from '../creator/creatorService';
import type { FeedAutoSnapshot, FeedAutoState } from '../feed/feedAutomation';
import { BUILTIN_TEMPLATES, buildVars, render } from '../message/templateEngine';
import { getSettingsSync } from '../storage/settings';
import { formatCount } from '../utils/number';
import { showToast } from './toast';

/** 面板动作回调，由 main.ts 注入（保持 UI 与抖音 DOM 解耦） */
export interface PanelActions {
  onSaveToLibrary: () => Promise<void>;
  onStatusChange: (status: ContactStatus) => Promise<void>;
  onOpenMessage: () => Promise<void>;
  onFillMessage: (text: string, templateId: string | null) => Promise<void>;
  onAiPolish: (text: string) => Promise<string>;
  /** REQ-20260902-02：保存设置（配置中心 UI） */
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  /** REQ-20260903-02：连刷自动化控制 */
  onStartFeedAuto: () => Promise<void>;
  onStopFeedAuto: () => void;
  getFeedAutoSnapshot: () => FeedAutoSnapshot;
}

type PanelView = 'main' | 'settings' | 'feed';

const FEED_STATE_LABEL: Record<FeedAutoState, string> = {
  IDLE: '未启动',
  RUNNING: '连刷中',
  STOPPED: '已停止',
  DONE: '已完成',
  ERROR: '出错',
};

export class OutreachPanel {
  private el: HTMLDivElement;
  private visible = false;
  private view: PanelView = 'main';
  /** 进入设置视图前的内容视图（main/feed），供「← 返回」恢复 */
  private lastContentView: 'main' | 'feed' = 'main';
  private ctx: CreatorPageContext | null = null;
  private actions: PanelActions | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'doa-panel';
    this.el.style.cssText = [
      'position:fixed',
      'right:16px',
      'top:12%',
      'width:320px',
      'max-height:76vh',
      'overflow-y:auto',
      'z-index:9999998',
      'background:#fff',
      'border-radius:14px',
      'box-shadow:0 8px 30px rgba(0,0,0,.22)',
      'font-size:13px',
      'color:#222',
      'display:none',
      'font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
    ].join(';');
    document.body.appendChild(this.el);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
    if (this.visible) {
      // 不重置视图：路由层（HOME->连刷视图 / CREATOR->主视图）已设置当前视图，
      // 强制重置会把推荐页的连刷视图刷成空占位（实测缺陷）
      this.renderContent();
    }
  }

  hide(): void {
    this.visible = false;
    this.el.style.display = 'none';
  }

  /** 自愈（BUG-20260903-03）：抖音 SPA 重绘若移除外部挂载节点，重新挂回 body */
  ensureMounted(): void {
    if (!this.el.isConnected && document.body) {
      document.body.appendChild(this.el);
    }
  }

  /** 更新当前达人上下文并重绘（若面板处于打开状态） */
  showForCreator(ctx: CreatorPageContext, actions: PanelActions): void {
    this.ctx = ctx;
    this.actions = actions;
    if (this.view === 'feed') this.view = 'main'; // 从推荐页跳到达人页，切回主视图
    if (this.visible) this.renderContent();
  }

  /** 推荐页（REQ-20260903-02）：面板进入连刷视图 */
  showFeedHome(actions: PanelActions): void {
    this.ctx = null;
    this.actions = actions;
    if (this.view === 'main') this.view = 'feed';
    if (this.visible) this.renderContent();
  }

  /** 连刷状态变化时刷新（仅当正处于连刷视图） */
  refreshFeed(): void {
    if (this.visible && this.view === 'feed') this.renderContent();
  }

  /** 非达人页：面板内容置空 */
  clear(): void {
    this.ctx = null;
    if (this.visible) this.renderContent();
  }

  // ---------- 渲染 ----------

  private renderContent(): void {
    // 记录内容视图，供设置视图「← 返回」恢复
    if (this.view !== 'settings') this.lastContentView = this.view as 'main' | 'feed';

    // 设置视图（REQ-20260902-02 / REQ-20260903-01）：不依赖达人上下文，任何页面可配置
    if (this.view === 'settings') {
      this.renderSettings();
      return;
    }

    // 推荐页连刷视图（REQ-20260903-02）
    if (this.view === 'feed') {
      this.renderFeedHome();
      return;
    }

    if (!this.ctx) {
      this.el.innerHTML = this.wrap(`
        <div style="color:#999;text-align:center;padding:24px 0;">
          打开一个抖音达人主页（/user/*）后，<br/>这里会显示达人资料与私信工具。
        </div>`);
      return;
    }

    const { info, existing, alreadyContacted } = this.ctx;
    const status: ContactStatus = existing?.status || 'NEW';
    const settings = getSettingsSync();

    const dupWarning = alreadyContacted && existing ? `
      <div style="background:#fff7e6;border:1px solid #ffd591;border-radius:8px;padding:8px 10px;margin-bottom:10px;color:#ad6800;">
        ⚠ 该达人已经联系过<br/>
        <span style="font-size:12px;">
          上次联系：${existing.lastContactAt ? new Date(existing.lastContactAt).toLocaleDateString() : '—'}
          　当前状态：${CONTACT_STATUS_LABEL[existing.status]}
        </span>
      </div>` : '';

    const templateOptions = BUILTIN_TEMPLATES.map(
      (t) => `<option value="${t.id}" ${t.id === settings.defaultTemplateId ? 'selected' : ''}>${t.name}</option>`,
    ).join('');

    const statusRadios = CONTACT_STATUS_FLOW.map((s) => `
      <label style="display:inline-flex;align-items:center;margin:2px 8px 2px 0;cursor:pointer;font-size:12px;">
        <input type="radio" name="doa-status" value="${s}" ${s === status ? 'checked' : ''}
          ${existing ? '' : 'disabled'} style="margin-right:3px;"/>
        ${CONTACT_STATUS_LABEL[s]}
      </label>`).join('');

    this.el.innerHTML = this.wrap(`
      ${dupWarning}
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        ${info.avatar ? `<img src="${info.avatar}" style="width:44px;height:44px;border-radius:50%;object-fit:cover;"/>` : ''}
        <div>
          <div style="font-weight:700;font-size:15px;" id="doa-nickname">${escapeHtml(info.nickname)}</div>
          <div style="color:#888;font-size:12px;">粉丝 ${formatCount(info.followers)}</div>
        </div>
      </div>
      ${info.tags.length ? `<div style="margin-bottom:8px;">${info.tags.map((t) =>
        `<span style="background:#f0f0f5;border-radius:10px;padding:2px 8px;margin-right:4px;font-size:11px;color:#666;">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      ${info.signature ? `<div style="color:#777;font-size:12px;margin-bottom:10px;line-height:1.5;">${escapeHtml(info.signature.slice(0, 80))}</div>` : ''}

      <div style="border-top:1px solid #f0f0f0;margin:10px 0;"></div>

      <div style="margin-bottom:8px;">
        <div style="color:#999;font-size:12px;margin-bottom:4px;">私信模板</div>
        <select id="doa-template" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:8px;">
          ${templateOptions}
        </select>
      </div>
      <textarea id="doa-message" rows="6"
        style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #ddd;border-radius:8px;resize:vertical;line-height:1.5;"></textarea>
      <div style="display:flex;gap:8px;margin:8px 0;">
        <button id="doa-ai" style="${this.btnStyle('#f5f5f5', '#333')}">AI优化</button>
        <button id="doa-open-msg" style="${this.btnStyle('#f5f5f5', '#333')}">打开私信</button>
        <button id="doa-fill" style="${this.btnStyle('#fe2c55', '#fff')}">填入私信</button>
      </div>

      <div style="border-top:1px solid #f0f0f0;margin:10px 0;"></div>

      <div style="color:#999;font-size:12px;margin-bottom:4px;">状态${existing ? '' : '（加入达人库后可修改）'}</div>
      <div style="margin-bottom:10px;">${statusRadios}</div>

      <button id="doa-save" style="${this.btnStyle(existing ? '#f0f0f5' : '#161823', existing ? '#999' : '#fff')};width:100%;">
        ${existing ? '✓ 已在达人库' : '加入达人库'}
      </button>
    `);

    this.bindEvents(info);
    this.applyTemplate();
  }

  private wrap(inner: string): string {
    // 主视图头部为 ⚙ 设置入口；设置视图头部为 ← 返回（REQ-20260902-02）
    const headerLeft = this.view === 'settings'
      ? '<span id="doa-back" style="cursor:pointer;color:#666;font-size:13px;">← 返回</span>'
      : '<span id="doa-settings" style="cursor:pointer;color:#999;font-size:14px;" title="设置">⚙</span>';
    return `
      <div style="padding:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          ${headerLeft}
          <span style="font-weight:700;">达人商务助手</span>
          <span id="doa-close" style="cursor:pointer;color:#bbb;font-size:16px;line-height:1;">✕</span>
        </div>
        ${inner}
      </div>`;
  }

  private btnStyle(bg: string, color: string): string {
    return `flex:1;background:${bg};color:${color};border:none;border-radius:8px;padding:7px 0;cursor:pointer;font-size:13px;`;
  }

  // ---------- 事件 ----------

  /** 头部按钮（关闭/设置/返回）在所有视图通用 */
  private bindHeaderEvents(): void {
    this.el.querySelector('#doa-close')?.addEventListener('click', () => this.hide());
    this.el.querySelector('#doa-settings')?.addEventListener('click', () => {
      this.view = 'settings';
      this.renderContent();
    });
    this.el.querySelector('#doa-back')?.addEventListener('click', () => {
      this.view = this.lastContentView;
      this.renderContent();
    });
  }

  private bindEvents(info: CreatorPageContext['info']): void {
    const $ = <T extends HTMLElement>(id: string) => this.el.querySelector<T>(`#${id}`);

    this.bindHeaderEvents();
    $('doa-template')?.addEventListener('change', () => this.applyTemplate());

    $('doa-save')?.addEventListener('click', async () => {
      if (!this.actions || this.ctx?.existing) return;
      await this.actions.onSaveToLibrary();
    });

    this.el.querySelectorAll<HTMLInputElement>('input[name="doa-status"]').forEach((radio) => {
      radio.addEventListener('change', async () => {
        if (this.actions && radio.checked) {
          await this.actions.onStatusChange(radio.value as ContactStatus);
        }
      });
    });

    $('doa-open-msg')?.addEventListener('click', async () => {
      await this.actions?.onOpenMessage();
    });

    $('doa-fill')?.addEventListener('click', async () => {
      const text = $<HTMLTextAreaElement>('doa-message')?.value.trim();
      if (!text) {
        showToast('私信内容为空', 'warn');
        return;
      }
      const templateId = $<HTMLSelectElement>('doa-template')?.value || null;
      await this.actions?.onFillMessage(text, templateId);
    });

    $('doa-ai')?.addEventListener('click', async () => {
      const textarea = $<HTMLTextAreaElement>('doa-message');
      const text = textarea?.value.trim();
      if (!text || !this.actions) {
        showToast('请先选择模板生成内容', 'warn');
        return;
      }
      const btn = $('doa-ai') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'AI生成中…';
      try {
        const polished = await this.actions.onAiPolish(text);
        if (textarea) textarea.value = polished;
      } finally {
        btn.disabled = false;
        btn.textContent = 'AI优化';
      }
    });
  }

  /** 根据当前选中的模板渲染变量并填入文本框 */
  private applyTemplate(): void {
    if (!this.ctx) return;
    const select = this.el.querySelector<HTMLSelectElement>('#doa-template');
    const textarea = this.el.querySelector<HTMLTextAreaElement>('#doa-message');
    const tpl: MessageTemplate | undefined = BUILTIN_TEMPLATES.find((t) => t.id === select?.value);
    if (!tpl || !textarea) return;
    textarea.value = render(tpl.content, buildVars(this.ctx.info, getSettingsSync()));
  }

  // ---------- 推荐页连刷视图（REQ-20260903-02） ----------

  private renderFeedHome(): void {
    const snap = this.actions?.getFeedAutoSnapshot();
    const state: FeedAutoState = snap?.state ?? 'IDLE';
    const running = state === 'RUNNING';
    const settings = getSettingsSync();

    const stateColor: Record<FeedAutoState, string> = {
      IDLE: '#666', RUNNING: '#237804', STOPPED: '#ad6800', DONE: '#237804', ERROR: '#cf1322',
    };

    this.el.innerHTML = this.wrap(`
      <div style="background:#f6ffed;border:1px solid #b7eb8f;border-radius:8px;padding:10px;margin-bottom:10px;">
        <div style="font-size:12px;color:#666;margin-bottom:6px;">推荐页连刷自动化</div>
        <div style="margin-bottom:6px;">
          状态：<b style="color:${stateColor[state]};">${FEED_STATE_LABEL[state]}</b>
          　已发送：<b>${snap?.sent ?? 0}/${snap?.limit ?? settings.autoBatchLimit}</b>
          　已访问：${snap?.visited ?? 0}
        </div>
        <div style="font-size:12px;color:#555;line-height:1.5;word-break:break-all;">
          ${escapeHtml(snap?.message ?? '未启动')}
        </div>
      </div>

      <div style="font-size:12px;color:#999;line-height:1.6;margin-bottom:10px;">
        流程：采集推荐页达人 -> 进入主页 -> 跳过已联系 -> 填入自定义私信 -> 自动发送 -> 返回继续。<br/>
        ${settings.autoSendEnabled
          ? (settings.customMessage.trim() ? '文案：使用设置中的自定义私信内容' : '文案：自定义内容为空，将使用默认模板')
          : '<b style="color:#cf1322;">需先在 ⚙ 设置中开启「消息自动发送」才能启动</b>'}
      </div>

      <button id="doa-feed-toggle" style="${this.btnStyle(running ? '#f0f0f5' : '#fe2c55', running ? '#333' : '#fff')};width:100%;">
        ${running ? '■ 停止连刷' : '▶ 开始连刷'}
      </button>
    `);

    this.bindHeaderEvents();
    this.el.querySelector('#doa-feed-toggle')?.addEventListener('click', async () => {
      if (!this.actions) return;
      if (this.actions.getFeedAutoSnapshot().state === 'RUNNING') {
        this.actions.onStopFeedAuto();
      } else {
        await this.actions.onStartFeedAuto();
      }
    });
  }

  // ---------- 设置视图（REQ-20260902-02 + REQ-20260903-01 自动发送开关） ----------

  private settingsInputStyle(): string {
    return 'width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ddd;border-radius:8px;margin-bottom:8px;font-size:12px;';
  }

  private sectionTitle(text: string, first = false): string {
    return `<div style="color:#999;font-size:12px;margin:${first ? '0' : '12px'} 0 6px;">${text}</div>`;
  }

  private renderSettings(): void {
    const s = getSettingsSync();
    const tplOptions = BUILTIN_TEMPLATES.map(
      (t) => `<option value="${t.id}" ${t.id === s.defaultTemplateId ? 'selected' : ''}>${t.name}</option>`,
    ).join('');

    this.el.innerHTML = this.wrap(`
      ${this.sectionTitle('品牌信息', true)}
      <input id="doa-set-brand" placeholder="品牌名称" value="${escapeHtml(s.brand)}" style="${this.settingsInputStyle()}"/>
      <textarea id="doa-set-brandIntro" placeholder="品牌简介" rows="2" style="${this.settingsInputStyle()}">${escapeHtml(s.brandIntro)}</textarea>
      <input id="doa-set-product" placeholder="产品名称" value="${escapeHtml(s.product)}" style="${this.settingsInputStyle()}"/>
      <input id="doa-set-contact" placeholder="默认联系人" value="${escapeHtml(s.contact)}" style="${this.settingsInputStyle()}"/>
      <input id="doa-set-wechat" placeholder="微信号" value="${escapeHtml(s.wechat)}" style="${this.settingsInputStyle()}"/>
      <input id="doa-set-category" placeholder="默认达人类型" value="${escapeHtml(s.category)}" style="${this.settingsInputStyle()}"/>

      ${this.sectionTitle('默认模板')}
      <select id="doa-set-template" style="${this.settingsInputStyle()}">${tplOptions}</select>

      ${this.sectionTitle('AI 润色')}
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;cursor:pointer;">
        <input type="checkbox" id="doa-set-ai" ${s.aiEnabled ? 'checked' : ''}/> 启用 AI 润色（未配置 Key 时自动降级为原文）
      </label>
      <input id="doa-set-aiEndpoint" placeholder="接口地址（OpenAI 兼容）" value="${escapeHtml(s.aiEndpoint)}" style="${this.settingsInputStyle()}"/>
      <input id="doa-set-aiApiKey" type="password" placeholder="API Key（仅存本地浏览器）" value="${escapeHtml(s.aiApiKey)}" style="${this.settingsInputStyle()}"/>
      <input id="doa-set-aiModel" placeholder="模型" value="${escapeHtml(s.aiModel)}" style="${this.settingsInputStyle()}"/>
      <input id="doa-set-aiTone" placeholder="语气" value="${escapeHtml(s.aiTone)}" style="${this.settingsInputStyle()}"/>

      ${this.sectionTitle('消息自动发送')}
      <label style="display:flex;align-items:flex-start;gap:6px;margin-bottom:8px;font-size:12px;cursor:pointer;line-height:1.5;">
        <input type="checkbox" id="doa-set-autoSend" ${s.autoSendEnabled ? 'checked' : ''} style="margin-top:2px;"/>
        <span>填入私信后自动点击一次发送（全局生效，改动即时保存）<br/>
        <span style="color:#ad6800;">连刷自动化依赖此开关</span></span>
      </label>

      ${this.sectionTitle('连刷自动化')}
      <textarea id="doa-set-customMessage" placeholder="自定义私信内容（支持 {{nickname}} {{brand}} {{wechat}} 等变量；留空则使用默认模板）" rows="4" style="${this.settingsInputStyle()}">${escapeHtml(s.customMessage)}</textarea>
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;">
        单会话发送上限
        <input id="doa-set-batchLimit" type="number" min="1" max="100" value="${s.autoBatchLimit}" style="width:64px;padding:4px;border:1px solid #ddd;border-radius:6px;"/>
        条
      </label>

      <button id="doa-set-save" style="${this.btnStyle('#fe2c55', '#fff')};width:100%;margin-top:8px;">保存设置</button>
    `);

    this.bindHeaderEvents();

    const $ = <T extends HTMLElement>(id: string) => this.el.querySelector<T>(`#${id}`);

    // 自动发送开关：改动即时保存（REQ-20260903-01），无需点保存按钮
    $('doa-set-autoSend')?.addEventListener('change', async (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      await this.actions?.onSaveSettings({ autoSendEnabled: checked });
    });

    $('doa-set-save')?.addEventListener('click', async () => {
      if (!this.actions) return;
      await this.actions.onSaveSettings({
        brand: $<HTMLInputElement>('doa-set-brand')?.value.trim() ?? '',
        brandIntro: $<HTMLTextAreaElement>('doa-set-brandIntro')?.value.trim() ?? '',
        product: $<HTMLInputElement>('doa-set-product')?.value.trim() ?? '',
        contact: $<HTMLInputElement>('doa-set-contact')?.value.trim() ?? '',
        wechat: $<HTMLInputElement>('doa-set-wechat')?.value.trim() ?? '',
        category: $<HTMLInputElement>('doa-set-category')?.value.trim() ?? '',
        defaultTemplateId: $<HTMLSelectElement>('doa-set-template')?.value ?? 'business_001',
        aiEnabled: $<HTMLInputElement>('doa-set-ai')?.checked ?? false,
        aiEndpoint: $<HTMLInputElement>('doa-set-aiEndpoint')?.value.trim() ?? '',
        aiApiKey: $<HTMLInputElement>('doa-set-aiApiKey')?.value.trim() ?? '',
        aiModel: $<HTMLInputElement>('doa-set-aiModel')?.value.trim() ?? '',
        aiTone: $<HTMLInputElement>('doa-set-aiTone')?.value.trim() ?? '',
        customMessage: $<HTMLTextAreaElement>('doa-set-customMessage')?.value ?? '',
        autoBatchLimit: Math.max(1, Number($<HTMLInputElement>('doa-set-batchLimit')?.value) || 10),
      });
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}
