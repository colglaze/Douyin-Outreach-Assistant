/**
 * 达人面板（文档第 8 章）：悬浮工具栏展开后的主交互界面。
 * 展示达人资料 / 模板选择 / AI优化 / 打开私信 / 填入私信 / 状态管理 / 加入达人库 / 防重复提醒。
 *
 * 依赖方向纪律（AGENTS.md 第 5 节）：UI 不直接操作抖音 DOM，
 * 私信相关动作通过回调委托给 main.ts 中的 MessageAdapter。
 */
import type { AppSettings, ContactStatus, MessageTemplate, ProfileGender, WorkGenderSuggestion } from '../types';
import { CONTACT_STATUS_FLOW, CONTACT_STATUS_LABEL } from '../types';
import type { CreatorPageContext } from '../creator/creatorService';
import type { FeedAutoSnapshot, FeedAutoState } from '../feed/feedAutomation';
import type { FeedAutoMode } from '../feed/feedMode';
import { buildVars, getAllTemplates, getTemplateById, render } from '../message/templateEngine';
import { getSettingsSync } from '../storage/settings';
import { formatCount } from '../utils/number';
import { showToast } from './toast';
import { evaluateDatingMatch } from '../creator/datingFilter';
import { AI_PROVIDER_PRESETS, getAiPresetConfig, getAiProviderPresetId } from '../ai/providerPresets';

/** 面板动作回调，由 main.ts 注入（保持 UI 与抖音 DOM 解耦） */
export interface PanelActions {
  onSaveToLibrary: () => Promise<void>;
  onStatusChange: (status: ContactStatus) => Promise<void>;
  onSetGender: (gender: ProfileGender) => Promise<void>;
  onAnalyzeWorks: (transcript: string) => Promise<WorkGenderSuggestion>;
  onOpenMessage: () => Promise<void>;
  onFillMessage: (text: string, templateId: string | null) => Promise<void>;
  onAiPolish: (text: string) => Promise<string>;
  /** REQ-20260902-02：保存设置（配置中心 UI） */
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  onSaveTemplate: (name: string, content: string, id?: string) => Promise<MessageTemplate>;
  onDeleteTemplate: (id: string) => Promise<void>;
  /** REQ-20260903-02：连刷自动化控制 */
  onStartFeedAuto: (mode: FeedAutoMode) => Promise<void>;
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
  private workSuggestion: WorkGenderSuggestion | null = null;
  private workSuggestionFor = '';
  private workTranscript = '';
  private messageDrafts = new Map<string, { templateId: string; text: string }>();

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
    if (this.workSuggestionFor !== ctx.info.secUid) {
      this.workSuggestion = null;
      this.workTranscript = '';
      this.workSuggestionFor = ctx.info.secUid;
    }
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

    const initialTemplateId = settings.outreachMode === 'DATING'
      ? (settings.datingMessageMode === 'TEMPLATE' ? settings.datingTemplateId : '')
      : (settings.businessMessageMode === 'TEMPLATE' ? settings.defaultTemplateId : '');
    const draftKey = `${info.secUid}:${settings.outreachMode}`;
    let draft = this.messageDrafts.get(draftKey);
    if (!draft) {
      const source = initialTemplateId
        ? getTemplateById(initialTemplateId, settings.customTemplates)?.content || ''
        : settings.outreachMode === 'DATING' ? settings.datingMessage : settings.customMessage;
      draft = { templateId: initialTemplateId, text: render(source, buildVars(info, settings)) };
      this.messageDrafts.set(draftKey, draft);
    }
    const templateOptions = getAllTemplates(settings).map(
      (t) => `<option value="${escapeHtml(t.id)}" ${t.id === draft.templateId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`,
    ).join('');
    const activeCustom = settings.customTemplates.find((t) => t.id === draft.templateId);
    const match = evaluateDatingMatch(info, settings, existing?.gender, existing?.genderConfirmed);
    const gender = existing?.genderConfirmed ? existing.gender : info.gender;
    const genderLabel = gender === 'MALE' ? '男' : gender === 'FEMALE' ? '女' : '未显示';

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
          <div style="color:#888;font-size:12px;">粉丝 ${info.followersKnown ? formatCount(info.followers) : '未识别'} · 性别 ${genderLabel}${existing?.genderConfirmed ? '（人工标记）' : ''}</div>
        </div>
      </div>
      ${info.tags.length ? `<div style="margin-bottom:8px;">${info.tags.map((t) =>
        `<span style="background:#f0f0f5;border-radius:10px;padding:2px 8px;margin-right:4px;font-size:11px;color:#666;">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      ${info.signature ? `<div style="color:#777;font-size:12px;margin-bottom:10px;line-height:1.5;">${escapeHtml(info.signature.slice(0, 80))}</div>` : ''}
      ${settings.outreachMode === 'DATING' ? `<div style="border-radius:8px;background:${match.matches ? '#f6ffed' : '#fff7e6'};padding:8px;margin-bottom:8px;font-size:12px;">交友筛选：${escapeHtml(match.reason)}。手动私信请自行确认资料和文案。</div>` : ''}
      ${settings.outreachMode === 'DATING' ? `<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;">本地标记性别
        <select id="doa-confirm-gender" style="flex:1;padding:4px;border:1px solid #ddd;border-radius:6px;">
          <option value="UNKNOWN" ${gender === 'UNKNOWN' ? 'selected' : ''}>未标记</option>
          <option value="MALE" ${gender === 'MALE' ? 'selected' : ''}>男</option>
          <option value="FEMALE" ${gender === 'FEMALE' ? 'selected' : ''}>女</option>
        </select><button id="doa-save-gender" style="padding:5px 8px;border:0;border-radius:6px;cursor:pointer;">保存</button>
      </div>` : ''}
      ${settings.outreachMode === 'DATING' ? `<div style="border:1px solid #eee;border-radius:8px;padding:8px;margin-bottom:10px;font-size:12px;">
        <div style="font-weight:600;margin-bottom:5px;">作品性别线索</div>
        <div style="color:#888;line-height:1.5;margin-bottom:5px;">读取最近作品文案；AI 已配置时将最多 3 张封面网址发送至配置的 AI 接口读取可见文字（可能计费）。音频无法自动采集，可粘贴台词或字幕。</div>
        <textarea id="doa-work-transcript" rows="2" placeholder="可选：粘贴作品中的台词/字幕" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ddd;border-radius:6px;">${escapeHtml(this.workTranscript)}</textarea>
        <button id="doa-analyze-works" style="${this.btnStyle('#f0f0f5', '#333')};width:100%;margin-top:5px;">识别作品线索</button>
        <div id="doa-work-result">${this.renderWorkSuggestion()}</div>
      </div>` : ''}

      <div style="border-top:1px solid #f0f0f0;margin:10px 0;"></div>

      <div style="margin-bottom:8px;">
        <div style="color:#999;font-size:12px;margin-bottom:4px;">私信内容：自由编写或选模板后修改</div>
        <select id="doa-template" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:8px;">
          <option value="" ${!draft.templateId ? 'selected' : ''}>自由编辑</option>
          ${templateOptions}
        </select>
      </div>
      <textarea id="doa-message" rows="6"
        placeholder="在这里写完整私信；也可用 {{nickname}} 等变量填写模板"
        style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #ddd;border-radius:8px;resize:vertical;line-height:1.5;">${escapeHtml(draft.text)}</textarea>
      <div style="color:#999;font-size:11px;margin:4px 0 8px;">切换模板会替换编辑框；编辑内容只保存为当前页草稿，点下方按钮才会存为模板。</div>
      <div style="display:flex;gap:5px;margin-bottom:6px;">
        <input id="doa-template-name" maxlength="80" placeholder="模板名称" value="${escapeHtml(activeCustom?.name || '')}" style="flex:1;min-width:0;padding:6px;border:1px solid #ddd;border-radius:6px;"/>
        <button id="doa-save-new-template" style="padding:6px;border:0;border-radius:6px;cursor:pointer;">存为新模板</button>
      </div>
      <div style="display:flex;gap:5px;margin-bottom:8px;">
        <button id="doa-update-template" ${activeCustom ? '' : 'disabled'} style="${this.btnStyle('#f0f0f5', '#333')}">更新所选模板</button>
        <button id="doa-delete-template" ${activeCustom ? '' : 'disabled'} style="${this.btnStyle('#fff1f0', '#cf1322')}">删除所选模板</button>
      </div>
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
          <span style="font-weight:700;">达人私信助手</span>
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
    $('doa-message')?.addEventListener('input', () => this.rememberDraft());
    $('doa-save-new-template')?.addEventListener('click', async () => {
      if (!this.actions) return;
      try {
        const template = await this.actions.onSaveTemplate(
          $<HTMLInputElement>('doa-template-name')?.value || '',
          $<HTMLTextAreaElement>('doa-message')?.value || '',
        );
        this.rememberDraft(template.id);
        this.renderContent();
      } catch (error) {
        showToast(String(error), 'warn');
      }
    });
    $('doa-update-template')?.addEventListener('click', async () => {
      const id = $<HTMLSelectElement>('doa-template')?.value;
      if (!id || !getSettingsSync().customTemplates.some((t) => t.id === id) || !this.actions) return;
      try {
        await this.actions.onSaveTemplate(
          $<HTMLInputElement>('doa-template-name')?.value || '',
          $<HTMLTextAreaElement>('doa-message')?.value || '',
          id,
        );
        this.rememberDraft();
        this.renderContent();
      } catch (error) {
        showToast(String(error), 'warn');
      }
    });
    $('doa-delete-template')?.addEventListener('click', async () => {
      const id = $<HTMLSelectElement>('doa-template')?.value;
      if (!id || !getSettingsSync().customTemplates.some((t) => t.id === id) || !this.actions) return;
      if (!window.confirm('删除这个自定义模板？当前编辑内容会保留。')) return;
      try {
        await this.actions.onDeleteTemplate(id);
        this.rememberDraft('');
        this.renderContent();
      } catch (error) {
        showToast(String(error), 'warn');
      }
    });

    $('doa-save')?.addEventListener('click', async () => {
      if (!this.actions || this.ctx?.existing) return;
      await this.actions.onSaveToLibrary();
    });

    $('doa-save-gender')?.addEventListener('click', async () => {
      const gender = $<HTMLSelectElement>('doa-confirm-gender')?.value as ProfileGender | undefined;
      if (gender) await this.actions?.onSetGender(gender);
    });

    $('doa-analyze-works')?.addEventListener('click', async () => {
      if (!this.actions) return;
      const btn = $<HTMLButtonElement>('doa-analyze-works');
      const secUid = this.ctx?.info.secUid;
      this.workTranscript = $<HTMLTextAreaElement>('doa-work-transcript')?.value.trim().slice(0, 1000) ?? '';
      if (btn) { btn.disabled = true; btn.textContent = '识别中…'; }
      try {
        const suggestion = await this.actions.onAnalyzeWorks(this.workTranscript);
        if (this.ctx?.info.secUid !== secUid) return;
        this.workSuggestion = suggestion;
        const result = $('doa-work-result');
        if (result) result.innerHTML = this.renderWorkSuggestion();
      } catch (error) {
        showToast(`作品识别失败：${String(error)}`, 'warn');
      } finally {
        if (btn?.isConnected) { btn.disabled = false; btn.textContent = '识别作品线索'; }
      }
    });
    $('doa-work-result')?.addEventListener('click', (event) => {
      if (!(event.target instanceof HTMLElement) || event.target.id !== 'doa-use-suggestion') return;
      const gender = this.workSuggestion?.gender;
      if (!gender || gender === 'UNKNOWN') return;
      const select = $<HTMLSelectElement>('doa-confirm-gender');
      if (select) select.value = gender;
      showToast('已填入建议，请核对后点击上方「保存」', 'success');
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
      const source = $<HTMLTextAreaElement>('doa-message')?.value || '';
      const text = render(source, buildVars(info, getSettingsSync())).trim();
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
        showToast('请先填写私信内容', 'warn');
        return;
      }
      const btn = $('doa-ai') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'AI生成中…';
      try {
        const polished = await this.actions.onAiPolish(text);
        if (textarea) {
          textarea.value = polished;
          this.rememberDraft();
        }
      } finally {
        btn.disabled = false;
        btn.textContent = 'AI优化';
      }
    });
  }

  private renderWorkSuggestion(): string {
    const result = this.workSuggestion;
    if (!result) return '';
    const label = result.gender === 'MALE' ? '男' : result.gender === 'FEMALE' ? '女' : '无法确定';
    const sourceLabel = { CAPTION: '作品文案', TRANSCRIPT: '台词/字幕', COVER: '封面文字' };
    const evidence = result.evidence.map((item) => `<li>${sourceLabel[item.source]}：${escapeHtml(item.text)}</li>`).join('');
    return `<div style="margin-top:8px;line-height:1.5;">
      <div>建议：<b>${label}</b>（需人工核对后在上方保存）</div>
      ${result.gender !== 'UNKNOWN' ? '<button id="doa-use-suggestion" style="padding:4px 8px;margin:4px 0;border:0;border-radius:6px;cursor:pointer;">将建议填入标记</button>' : ''}
      <div style="color:#888;">已查看 ${result.worksChecked} 条作品文案、${result.coversChecked} 张封面${result.transcriptUsed ? '，及粘贴的台词/字幕' : ''}；未自动分析声音。</div>
      ${evidence ? `<ul style="padding-left:18px;margin:5px 0;">${evidence}</ul>` : '<div style="color:#888;">没有发现明确的第一人称性别自述。</div>'}
      ${result.warning ? `<div style="color:#ad6800;">${escapeHtml(result.warning)}</div>` : ''}
    </div>`;
  }

  private rememberDraft(templateId?: string): void {
    if (!this.ctx) return;
    const selected = this.el.querySelector<HTMLSelectElement>('#doa-template');
    const textarea = this.el.querySelector<HTMLTextAreaElement>('#doa-message');
    if (!selected || !textarea) return;
    const draftKey = `${this.ctx.info.secUid}:${getSettingsSync().outreachMode}`;
    this.messageDrafts.set(draftKey, { templateId: templateId ?? selected.value, text: textarea.value });
  }

  /** 仅在用户切换模板时覆盖文本；切回自由编辑保留现有文本。 */
  private applyTemplate(): void {
    if (!this.ctx) return;
    const select = this.el.querySelector<HTMLSelectElement>('#doa-template');
    const textarea = this.el.querySelector<HTMLTextAreaElement>('#doa-message');
    if (!select || !textarea) return;
    const settings = getSettingsSync();
    const tpl = getTemplateById(select.value, settings.customTemplates);
    if (tpl) textarea.value = render(tpl.content, buildVars(this.ctx.info, settings));
    const name = this.el.querySelector<HTMLInputElement>('#doa-template-name');
    if (name) name.value = settings.customTemplates.find((t) => t.id === select.value)?.name || '';
    const custom = settings.customTemplates.some((t) => t.id === select.value);
    for (const id of ['doa-update-template', 'doa-delete-template']) {
      const button = this.el.querySelector<HTMLButtonElement>(`#${id}`);
      if (button) button.disabled = !custom;
    }
    this.rememberDraft();
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
          　已发送：<b>${snap?.sent ?? 0}/${snap?.limit ?? (snap?.mode === 'CONTINUOUS' ? '∞' : settings.autoBatchLimit)}</b>
          　已访问：${snap?.visited ?? 0}　已跳过：${snap?.skipped ?? 0}
        </div>
        <div style="font-size:12px;color:#555;line-height:1.5;word-break:break-all;">
          ${escapeHtml(snap?.message ?? '未启动')}
        </div>
      </div>

      <div style="font-size:12px;color:#999;line-height:1.6;margin-bottom:10px;">
        ${settings.outreachMode === 'DATING'
          ? `交友模式：${settings.targetGender === 'ANY' ? '性别不限' : settings.targetGender === 'MALE' ? '男' : '女'}，粉丝 ${settings.minFollowers}–${settings.maxFollowers || '不限'}；资料不明则跳过。<br/>文案：使用交友私信内容。`
          : '商务模式：跳过已联系达人，使用自定义私信或默认模板。'}<br/>
        ${settings.autoSendEnabled
          ? '推荐页手动启动后将按当前模式筛选并自动发送；持续模式没有条数上限'
          : '<b style="color:#cf1322;">需先在 ⚙ 设置中开启「消息自动发送」才能启动</b>'}
      </div>

      ${running ? `<button id="doa-feed-stop" style="${this.btnStyle('#f0f0f5', '#333')};width:100%;">■ 停止${snap?.mode === 'CONTINUOUS' ? '持续' : '限量'}连刷</button>` : `
        <div style="display:flex;gap:8px;">
          <button id="doa-feed-start-limited" style="${this.btnStyle('#fe2c55', '#fff')}">▶ 限量连刷</button>
          <button id="doa-feed-start-continuous" style="${this.btnStyle('#161823', '#fff')}">∞ 持续连刷</button>
        </div>
        <div style="font-size:11px;color:#999;margin-top:7px;">持续模式由你点击开始和停止；错误、页面异常或关闭标签页仍会结束。</div>
      `}
    `);

    this.bindHeaderEvents();
    this.el.querySelector('#doa-feed-stop')?.addEventListener('click', () => this.actions?.onStopFeedAuto());
    this.el.querySelector('#doa-feed-start-limited')?.addEventListener('click', () => this.actions?.onStartFeedAuto('LIMITED'));
    this.el.querySelector('#doa-feed-start-continuous')?.addEventListener('click', () => this.actions?.onStartFeedAuto('CONTINUOUS'));
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
    const aiPresetId = getAiProviderPresetId(s.aiEndpoint, s.aiModel);
    const allTemplates = getAllTemplates(s);
    const tplOptions = allTemplates.map(
      (t) => `<option value="${escapeHtml(t.id)}" ${t.id === s.defaultTemplateId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`,
    ).join('');
    const datingTplOptions = allTemplates.map(
      (t) => `<option value="${escapeHtml(t.id)}" ${t.id === s.datingTemplateId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`,
    ).join('');

    this.el.innerHTML = this.wrap(`
      ${this.sectionTitle('使用模式', true)}
      <select id="doa-set-mode" style="${this.settingsInputStyle()}">
        <option value="BUSINESS" ${s.outreachMode === 'BUSINESS' ? 'selected' : ''}>商务触达</option>
        <option value="DATING" ${s.outreachMode === 'DATING' ? 'selected' : ''}>交友</option>
      </select>
      ${this.sectionTitle('交友筛选')}
      <select id="doa-set-gender" style="${this.settingsInputStyle()}">
        <option value="ANY" ${s.targetGender === 'ANY' ? 'selected' : ''}>性别不限</option>
        <option value="MALE" ${s.targetGender === 'MALE' ? 'selected' : ''}>男</option>
        <option value="FEMALE" ${s.targetGender === 'FEMALE' ? 'selected' : ''}>女</option>
      </select>
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:8px;">
        粉丝 <input id="doa-set-minFollowers" type="number" min="0" step="1" value="${s.minFollowers}" style="width:78px;padding:4px;border:1px solid #ddd;border-radius:6px;"/> 至
        <input id="doa-set-maxFollowers" type="number" min="0" step="1" value="${s.maxFollowers}" style="width:78px;padding:4px;border:1px solid #ddd;border-radius:6px;"/>
      </div>
      <div style="color:#999;font-size:11px;margin-bottom:8px;">上限填 0 表示不限；性别未明确显示时不会定向发送。</div>
      <div style="font-size:12px;margin-bottom:5px;">交友连刷文案来源</div>
      <select id="doa-set-datingMessageMode" style="${this.settingsInputStyle()}">
        <option value="CUSTOM" ${s.datingMessageMode === 'CUSTOM' ? 'selected' : ''}>自由文案</option>
        <option value="TEMPLATE" ${s.datingMessageMode === 'TEMPLATE' ? 'selected' : ''}>使用模板</option>
      </select>
      <textarea id="doa-set-datingMessage" placeholder="交友自由文案（支持 {{nickname}} 等变量）" rows="4" style="${this.settingsInputStyle()}">${escapeHtml(s.datingMessage)}</textarea>
      <select id="doa-set-datingTemplate" style="${this.settingsInputStyle()}">${datingTplOptions}</select>
      ${this.sectionTitle('品牌信息')}
      <input id="doa-set-brand" placeholder="品牌名称" value="${escapeHtml(s.brand)}" style="${this.settingsInputStyle()}"/>
      <textarea id="doa-set-brandIntro" placeholder="品牌简介" rows="2" style="${this.settingsInputStyle()}">${escapeHtml(s.brandIntro)}</textarea>
      <input id="doa-set-product" placeholder="产品名称" value="${escapeHtml(s.product)}" style="${this.settingsInputStyle()}"/>
      <input id="doa-set-contact" placeholder="默认联系人" value="${escapeHtml(s.contact)}" style="${this.settingsInputStyle()}"/>
      <input id="doa-set-wechat" placeholder="微信号" value="${escapeHtml(s.wechat)}" style="${this.settingsInputStyle()}"/>
      <input id="doa-set-category" placeholder="默认达人类型" value="${escapeHtml(s.category)}" style="${this.settingsInputStyle()}"/>

      ${this.sectionTitle('商务默认模板')}
      <select id="doa-set-template" style="${this.settingsInputStyle()}">${tplOptions}</select>

      ${this.sectionTitle('AI 润色')}
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;cursor:pointer;">
        <input type="checkbox" id="doa-set-ai" ${s.aiEnabled ? 'checked' : ''}/> 启用 AI 润色（未配置 Key 时自动降级为原文）
      </label>
      <select id="doa-set-aiProvider" style="${this.settingsInputStyle()}">
        ${AI_PROVIDER_PRESETS.map((p) => `<option value="${p.id}" ${aiPresetId === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
        <option value="custom" ${aiPresetId === 'custom' ? 'selected' : ''}>自定义兼容接口</option>
      </select>
      <div style="color:#999;font-size:11px;margin-bottom:8px;">切换提供商会清空旧 Key；LongCat-2.0 用于文字润色，封面识别需支持图像的模型。</div>
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
      <div style="font-size:12px;margin-bottom:5px;">商务连刷文案来源</div>
      <select id="doa-set-businessMessageMode" style="${this.settingsInputStyle()}">
        <option value="CUSTOM" ${s.businessMessageMode === 'CUSTOM' ? 'selected' : ''}>自由文案</option>
        <option value="TEMPLATE" ${s.businessMessageMode === 'TEMPLATE' ? 'selected' : ''}>使用上方商务默认模板</option>
      </select>
      <textarea id="doa-set-customMessage" placeholder="商务自由文案（支持 {{nickname}} {{brand}} {{wechat}} 等变量）" rows="4" style="${this.settingsInputStyle()}">${escapeHtml(s.customMessage)}</textarea>
      <div style="color:#999;font-size:11px;margin-bottom:8px;">先选择来源，再保存设置；模板可在达人主页编辑器中管理。</div>
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;">
        单会话发送上限
        <input id="doa-set-batchLimit" type="number" min="1" max="100" value="${s.autoBatchLimit}" style="width:64px;padding:4px;border:1px solid #ddd;border-radius:6px;"/>
        条
      </label>

      <button id="doa-set-save" style="${this.btnStyle('#fe2c55', '#fff')};width:100%;margin-top:8px;">保存设置</button>
    `);

    this.bindHeaderEvents();

    const $ = <T extends HTMLElement>(id: string) => this.el.querySelector<T>(`#${id}`);

    $('doa-set-aiProvider')?.addEventListener('change', () => {
      const id = $<HTMLSelectElement>('doa-set-aiProvider')?.value;
      const config = getAiPresetConfig(id || '');
      if (!config) return;
      const endpoint = $<HTMLInputElement>('doa-set-aiEndpoint');
      const model = $<HTMLInputElement>('doa-set-aiModel');
      const apiKey = $<HTMLInputElement>('doa-set-aiApiKey');
      if (endpoint) endpoint.value = config.aiEndpoint;
      if (model) model.value = config.aiModel;
      if (apiKey) apiKey.value = config.aiApiKey;
      showToast('已填写接口和模型；请填入该提供商的 API Key 后保存', 'success');
    });
    $('doa-set-aiEndpoint')?.addEventListener('input', () => {
      const currentEndpoint = $<HTMLInputElement>('doa-set-aiEndpoint')?.value.trim() || '';
      const currentModel = $<HTMLInputElement>('doa-set-aiModel')?.value.trim() || '';
      const provider = $<HTMLSelectElement>('doa-set-aiProvider');
      if (provider) provider.value = getAiProviderPresetId(currentEndpoint, currentModel);
      if (currentEndpoint !== s.aiEndpoint) {
        const apiKey = $<HTMLInputElement>('doa-set-aiApiKey');
        if (apiKey) apiKey.value = '';
      }
    });
    $('doa-set-aiModel')?.addEventListener('input', () => {
      const currentEndpoint = $<HTMLInputElement>('doa-set-aiEndpoint')?.value.trim() || '';
      const currentModel = $<HTMLInputElement>('doa-set-aiModel')?.value.trim() || '';
      const provider = $<HTMLSelectElement>('doa-set-aiProvider');
      if (provider) provider.value = getAiProviderPresetId(currentEndpoint, currentModel);
    });

    // 自动发送开关：改动即时保存（REQ-20260903-01），无需点保存按钮
    $('doa-set-autoSend')?.addEventListener('change', async (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      await this.actions?.onSaveSettings({ autoSendEnabled: checked });
    });

    $('doa-set-save')?.addEventListener('click', async () => {
      if (!this.actions) return;
      const minFollowers = Number($<HTMLInputElement>('doa-set-minFollowers')?.value);
      const maxFollowers = Number($<HTMLInputElement>('doa-set-maxFollowers')?.value);
      if (!Number.isSafeInteger(minFollowers) || minFollowers < 0 || !Number.isSafeInteger(maxFollowers) || maxFollowers < 0 ||
        (maxFollowers > 0 && maxFollowers < minFollowers)) {
        showToast('请填写有效粉丝范围（上限需不小于下限）', 'warn');
        return;
      }
      const datingMessage = $<HTMLTextAreaElement>('doa-set-datingMessage')?.value.trim() ?? '';
      const outreachMode = $<HTMLSelectElement>('doa-set-mode')?.value as AppSettings['outreachMode'];
      const datingMessageMode = $<HTMLSelectElement>('doa-set-datingMessageMode')?.value as AppSettings['datingMessageMode'];
      const businessMessageMode = $<HTMLSelectElement>('doa-set-businessMessageMode')?.value as AppSettings['businessMessageMode'];
      const datingTemplateId = $<HTMLSelectElement>('doa-set-datingTemplate')?.value || 'dating_001';
      const defaultTemplateId = $<HTMLSelectElement>('doa-set-template')?.value || 'business_001';
      const customMessage = $<HTMLTextAreaElement>('doa-set-customMessage')?.value ?? '';
      const source = outreachMode === 'DATING'
        ? datingMessageMode === 'CUSTOM' ? datingMessage : getTemplateById(datingTemplateId, s.customTemplates)?.content
        : businessMessageMode === 'CUSTOM' ? customMessage : getTemplateById(defaultTemplateId, s.customTemplates)?.content;
      if (!source?.trim()) {
        showToast('所选连刷文案为空，请填写内容或选择有效模板', 'warn');
        return;
      }
      await this.actions.onSaveSettings({
        outreachMode,
        targetGender: $<HTMLSelectElement>('doa-set-gender')?.value as AppSettings['targetGender'],
        minFollowers,
        maxFollowers,
        datingMessage,
        datingMessageMode,
        datingTemplateId,
        brand: $<HTMLInputElement>('doa-set-brand')?.value.trim() ?? '',
        brandIntro: $<HTMLTextAreaElement>('doa-set-brandIntro')?.value.trim() ?? '',
        product: $<HTMLInputElement>('doa-set-product')?.value.trim() ?? '',
        contact: $<HTMLInputElement>('doa-set-contact')?.value.trim() ?? '',
        wechat: $<HTMLInputElement>('doa-set-wechat')?.value.trim() ?? '',
        category: $<HTMLInputElement>('doa-set-category')?.value.trim() ?? '',
        defaultTemplateId,
        businessMessageMode,
        aiEnabled: $<HTMLInputElement>('doa-set-ai')?.checked ?? false,
        aiEndpoint: $<HTMLInputElement>('doa-set-aiEndpoint')?.value.trim() ?? '',
        aiApiKey: $<HTMLInputElement>('doa-set-aiApiKey')?.value.trim() ?? '',
        aiModel: $<HTMLInputElement>('doa-set-aiModel')?.value.trim() ?? '',
        aiTone: $<HTMLInputElement>('doa-set-aiTone')?.value.trim() ?? '',
        customMessage,
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
