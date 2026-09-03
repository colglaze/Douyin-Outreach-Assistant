/**
 * FeedAutomation（REQ-20260903-02 + BUG-20260903-02 架构修订）：推荐页连刷自动化。
 *
 * 实测架构约束（2026-09-03 探针取证，见 docs/BUG-20260903-02）：
 * - 打开 https://www.douyin.com/ 会 302 到 /jingxuan（精选）；推荐 feed 只能点侧栏
 *   「推荐」锚点 SPA 进入（/?recommend=1，无刷新，脚本状态保留）；
 * - 精选页卡片是 <div href> 不是真锚点，无法采集作者；只有推荐 feed 有真实 a[href*="/user/"]；
 * - 站内跳 /user/ 达人主页一定是整页刷新（SPA 标记实测丢失），脚本内存状态必然丢失。
 *
 * 因此连刷会话持久化在 sessionStorage（同标签页有效，关标签页即销毁，
 * 符合红线"不跨浏览器会话自动恢复"）：每次整页跳转前保存会话，
 * 页面重新加载后由 main.ts 调 resume() 按当前页面类型续跑。
 *
 * 流程：推荐页采集作者链接 -> 整页跳达人主页 ->（续跑）解析 -> 跳过已联系 ->
 *       填自定义私信 -> 自动发送 -> 记录 -> 整页跳回推荐 ->（续跑）继续采集。
 *
 * 边界（AGENTS.md 第 6 节 v3）：
 * - 必须由用户在面板手动启动，随时可停止（停止即清除会话，不再续跑）；
 * - 需要"消息自动发送"开关（autoSendEnabled）已开启，否则拒绝启动；
 * - 跳过已联系达人；单会话发送上限（autoBatchLimit，默认 10）；
 * - 连续失败 2 次即停止；会话 30 分钟过期；
 * - 不提供定时/无人值守启动；不跨浏览器会话恢复。
 */
import { DouyinAdapter } from '../douyin/adapter';
import { MessageAdapter } from '../douyin/messageAdapter';
import { CreatorParser } from '../douyin/creatorParser';
import { CreatorService, type CreatorPageContext } from '../creator/creatorService';
import { MessageService } from '../message/messageService';
import type { CreatorInfo } from '../types';
import { getSettingsSync } from '../storage/settings';
import { buildVars, getTemplateById, render } from '../message/templateEngine';
import { sleep } from '../utils/dom';
import { logger } from '../utils/logger';

const SCOPE = 'FeedAutomation';

export type FeedAutoState = 'IDLE' | 'RUNNING' | 'STOPPED' | 'DONE' | 'ERROR';

export interface FeedAutoSnapshot {
  state: FeedAutoState;
  sent: number;
  limit: number;
  visited: number;
  /** 当前状态说明或最近错误信息（用于面板展示与 toast） */
  message: string;
}

interface FeedAutomationDeps {
  adapter: DouyinAdapter;
  messageAdapter: MessageAdapter;
  parser: CreatorParser;
  creatorService: CreatorService;
  messageService: MessageService;
  /** 状态变化回调（main.ts 注入：刷新面板 + 终态 toast） */
  onChange: (snap: FeedAutoSnapshot) => void;
}

/** sessionStorage 中的连刷会话（仅 RUNNING 态会被持久化） */
interface FeedSession {
  v: 1;
  sent: number;
  fails: number;
  visited: string[];
  message: string;
  startedAt: number;
}

const SESSION_KEY = 'doa.feedSession.v1';
const SESSION_TTL = 30 * 60 * 1000; // 30 分钟过期，避免陈旧会话意外续跑
const MAX_CONSECUTIVE_FAILS = 2;
const MAX_EMPTY_SCROLL_ROUNDS = 8;

export class FeedAutomation {
  private state: FeedAutoState = 'IDLE';
  private sent = 0;
  private consecutiveFails = 0;
  private visited = new Set<string>();
  private message = '未启动';

  constructor(private deps: FeedAutomationDeps) {
    // 构造时先从 sessionStorage 恢复计数（页面刚刷新、resume 前面板即可显示正确状态）
    const s = this.loadSession();
    if (s) {
      this.state = 'RUNNING';
      this.sent = s.sent;
      this.consecutiveFails = s.fails;
      this.visited = new Set(s.visited);
      this.message = s.message;
    }
  }

  snapshot(): FeedAutoSnapshot {
    return {
      state: this.state,
      sent: this.sent,
      limit: getSettingsSync().autoBatchLimit || 10,
      visited: this.visited.size,
      message: this.message,
    };
  }

  /** 手动停止：清除会话（整页跳转后也不再续跑）并立即进入终态 */
  stop(): void {
    if (this.state !== 'RUNNING') return;
    this.clearSession();
    this.state = 'STOPPED';
    this.setMessage(`已手动停止（本次发送 ${this.sent} 条）`);
    logger.info(SCOPE, `stopped by user, sent=${this.sent}`);
  }

  /** 手动启动（面板按钮）。必须在推荐页或精选落地页上启动 */
  async start(): Promise<void> {
    if (this.state === 'RUNNING') return;
    if (!getSettingsSync().autoSendEnabled) {
      this.fail('需要先在设置中开启「消息自动发送」开关');
      return;
    }
    if (!this.isRecommendPage() && location.pathname !== '/jingxuan') {
      this.fail('请先回到抖音推荐页（首页）再启动');
      return;
    }
    this.state = 'RUNNING';
    this.sent = 0;
    this.consecutiveFails = 0;
    this.visited.clear();
    this.setMessage('连刷中…');
    this.saveSession();
    logger.info(SCOPE, 'feed automation started');
    await this.stepOnFeed();
  }

  /**
   * 整页刷新后的续跑入口（main.ts 在每次脚本启动时调用）。
   * 无有效会话则直接返回；有会话则按当前页面类型执行对应步骤。
   */
  async resume(): Promise<void> {
    if (this.state !== 'RUNNING') return; // 构造时已从会话恢复；无会话即 IDLE
    logger.info(SCOPE, `resume on ${location.pathname}: sent=${this.sent}, visited=${this.visited.size}`);
    this.deps.onChange(this.snapshot());
    // 等页面主体内容加载（整页刷新后 DOM 异步渲染）
    await sleep(2500);
    if (this.state !== 'RUNNING') return; // 等待期间被用户停止
    if (location.pathname.startsWith('/user/')) {
      await this.stepOnCreator();
    } else {
      await this.stepOnFeed();
    }
  }

  // ---------- 步骤 1：推荐 feed 页（采集 -> 跳达人页） ----------

  private async stepOnFeed(): Promise<void> {
    if (this.state !== 'RUNNING') return;

    // 精选落地页 -> SPA 点侧栏「推荐」（实测无刷新，会话内存保留）
    if (location.pathname === '/jingxuan') {
      this.setMessage('进入推荐 feed…');
      const nav = this.deps.adapter.getRecommendNavLink();
      if (!nav) { this.fail('找不到侧栏「推荐」导航入口'); return; }
      nav.removeAttribute('target');
      nav.click();
      const ok = await this.waitFor(() => this.isRecommendPage(), 8000);
      if (!ok) { this.fail('无法进入推荐 feed'); return; }
      await sleep(2500); // feed 内容异步渲染
    }

    // 其它页面（理论上不会到这里）：整页回首页，302 到精选后由 resume 续跑
    if (!this.isRecommendPage()) {
      this.setMessage('返回推荐页…');
      this.saveSession();
      this.deps.adapter.navigateTo('https://www.douyin.com/');
      return;
    }

    // 新手引导浮层会吞掉 feed 上的点击，先关掉
    this.deps.adapter.dismissFeedGuide();
    await sleep(500);

    // 采集未访问过的作者链接；没有则连刷切换下一条，最多 N 轮
    for (let round = 0; round < MAX_EMPTY_SCROLL_ROUNDS; round++) {
      if (this.state !== 'RUNNING') return;
      const links = this.deps.adapter.getFeedAuthorLinks()
        .filter((a) => !this.visited.has(a.href.split('?')[0]));
      if (links.length > 0) {
        const url = links[0].href.split('?')[0];
        this.visited.add(url);
        this.setMessage(`进入达人主页（本次已访问 ${this.visited.size} 个）`);
        this.saveSession();
        await sleep(300);
        this.deps.adapter.navigateTo(url); // 整页跳转，后续由 resume -> stepOnCreator 续跑
        return;
      }
      this.setMessage(`未发现新达人，切换下一条（${round + 1}/${MAX_EMPTY_SCROLL_ROUNDS}）`);
      this.scrollFeed();
      await sleep(2500);
    }
    this.fail('多次切换后仍无新达人链接（可能未登录、被弹窗遮挡或 feed 未加载）');
  }

  // ---------- 步骤 2：达人主页（解析 -> 私信 -> 回 feed） ----------

  private async stepOnCreator(): Promise<void> {
    if (this.state !== 'RUNNING') return;
    const limit = getSettingsSync().autoBatchLimit || 10;

    this.setMessage('达人页加载中…');
    const expectedSecUid = this.deps.adapter.getCreatorSecUid();
    const ready = await this.waitFor(() => {
      if (!location.pathname.startsWith('/user/')) return false;
      if (expectedSecUid && this.deps.adapter.getCreatorSecUid() !== expectedSecUid) return false;
      const parsed = this.deps.parser.parse();
      return !!parsed && (!expectedSecUid || parsed.secUid === expectedSecUid);
    }, 15000);
    if (!ready) {
      this.markFail('达人页内容加载超时或达人身份不匹配');
      await this.backToFeedOrStop();
      return;
    }
    // 整页刷新后的旧任务不能继续操作另一个达人页面。
    if (expectedSecUid && this.deps.adapter.getCreatorSecUid() !== expectedSecUid) {
      this.markFail('达人页面已切换，取消当前操作');
      return;
    }
    // 实测（BUG-20260903-02）：达人页 IM SDK 冷启动较慢，过早点"私信"会被吞掉，
    // 这里等页面与 SDK 充分就绪（探针验证 9s 后点击可稳定打开聊天层）
    await sleep(4000);

    const info = this.deps.parser.parse();
    if (!info) {
      this.markFail('达人资料解析失败');
      await this.backToFeedOrStop();
      return;
    }

    const ctx = await this.deps.creatorService.syncFromPage(info);
    if (ctx.alreadyContacted) {
      this.setMessage(`跳过已联系：${info.nickname}`);
      logger.info(SCOPE, `skip already contacted: ${info.nickname}`);
      await this.backToFeedOrStop();
      return;
    }

    // 等达人操作区真正挂载，避免页面虽已解析但私信按钮仍未完成渲染。
    const messageReady = await this.waitFor(() => !!this.deps.adapter.getMessageButton(), 10000);
    if (!messageReady) {
      this.markFail(`达人页私信入口加载超时：${info.nickname}`);
      await this.backToFeedOrStop();
      return;
    }

    const done = await this.outreachOnce(ctx, info, limit);
    if (this.state !== 'RUNNING') return; // 连续失败已置 ERROR
    if (!done) {
      await this.backToFeedOrStop();
      return;
    }
    await this.backToFeed();
  }

  /** 单个达人的私信触达；返回 true 表示发送成功并已记录 */
  private async outreachOnce(
    ctx: CreatorPageContext,
    info: CreatorInfo,
    limit: number,
  ): Promise<boolean> {
    const { messageAdapter, creatorService, messageService } = this.deps;

    const opened = await messageAdapter.openMessageDialog(info.nickname, true);
    if (!opened) {
      this.markFail(`私信窗口打不开（可能未登录）：${info.nickname}`);
      return false;
    }
    await sleep(400);

    const settings = getSettingsSync();
    const vars = buildVars(info, settings);
    const content = settings.customMessage.trim()
      ? render(settings.customMessage, vars)
      : render(getTemplateById(settings.defaultTemplateId)?.content || '', vars);
    logger.info(SCOPE, `rendered message length = ${content.length}`);

    const filled = await messageAdapter.fillMessage(content);
    if (!filled) {
      messageAdapter.closeMessageDialog(); // 复位面板，避免影响下一位达人
      this.markFail(`私信填入失败：${info.nickname}`);
      return false;
    }
    await sleep(600);

    const sentOk = await messageAdapter.sendMessage();
    if (!sentOk) {
      // 不关闭聊天层：自动点击可能被浏览器以 isTrusted=false 拒绝，
      // 保留已填文案让用户人工点击发送，避免回 feed 后无法补发。
      this.fail(`自动发送未被平台接受，请在当前聊天窗口手动点击发送：${info.nickname}`);
      return false;
    }
    messageAdapter.closeMessageDialog(); // 发完即关，保证下一位达人从干净聊天层开始

    // 发送成功后入库 + 记录（状态 SENT）
    let cur = ctx;
    if (!cur.existing) {
      await creatorService.saveToLibrary(info);
      cur = await creatorService.syncFromPage(info);
    }
    const msg = await messageService.recordOutreach(cur.existing!.id, content, null);
    await messageService.markSent(msg.id);

    this.sent++;
    this.consecutiveFails = 0;
    this.setMessage(`已发送 ${this.sent}/${limit}：${info.nickname}`);
    logger.info(SCOPE, `sent ${this.sent}/${limit}: ${info.nickname}`);
    await sleep(2000); // 发送后稍作停顿再返回
    return true;
  }

  // ---------- 工具 ----------

  /** 推荐 feed 页判定：SPA 进入后为 /?recommend=1（pathname 即 /） */
  private isRecommendPage(): boolean {
    return location.pathname === '/' || location.pathname === '';
  }

  /** 推荐页连刷切换下一条（下箭头 + 滚轮） */
  private scrollFeed(): void {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }),
    );
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 1200, bubbles: true }));
  }

  /** 达到上限则收官，否则整页跳回首页（302 到精选后由 resume 续跑） */
  private async backToFeed(): Promise<void> {
    if (this.state !== 'RUNNING') return;
    const limit = getSettingsSync().autoBatchLimit || 10;
    if (this.sent >= limit) {
      this.finishDone();
      return;
    }
    this.setMessage('返回推荐页…');
    this.saveSession();
    this.deps.adapter.navigateTo('https://www.douyin.com/');
  }

  /** 失败后的返回：未达连续失败上限才返回 feed，否则保持 ERROR 停留当前页 */
  private async backToFeedOrStop(): Promise<void> {
    if (this.state !== 'RUNNING') return;
    await this.backToFeed();
  }

  private async waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.state !== 'RUNNING') return false;
      if (predicate()) return true;
      await sleep(300);
    }
    return predicate();
  }

  /** 记一次失败；达到连续上限则整体停止为 ERROR */
  private markFail(reason: string): void {
    this.consecutiveFails++;
    logger.warn(SCOPE, `fail ${this.consecutiveFails}/${MAX_CONSECUTIVE_FAILS}: ${reason}`);
    if (this.consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
      this.fail(`连续失败，已停止：${reason}`);
      return;
    }
    this.setMessage(`出错（${this.consecutiveFails}/${MAX_CONSECUTIVE_FAILS}）：${reason}`);
    this.saveSession();
  }

  private fail(message: string): void {
    this.clearSession();
    this.state = 'ERROR';
    this.setMessage(message);
    logger.error(SCOPE, message);
  }

  private finishDone(): void {
    const limit = getSettingsSync().autoBatchLimit || 10;
    this.clearSession();
    this.state = 'DONE';
    this.setMessage(`达到单会话上限 ${limit} 条，本次连刷结束`);
    logger.info(SCOPE, `feed automation done, sent=${this.sent}`);
  }

  private setMessage(message: string): void {
    this.message = message;
    this.deps.onChange(this.snapshot());
  }

  // ---------- 会话持久化（sessionStorage，同标签页有效，关标签页即销毁） ----------

  private saveSession(): void {
    if (this.state !== 'RUNNING') return;
    const s: FeedSession = {
      v: 1,
      sent: this.sent,
      fails: this.consecutiveFails,
      visited: Array.from(this.visited),
      message: this.message,
      startedAt: Date.now(),
    };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    } catch (e) {
      logger.warn(SCOPE, `saveSession failed: ${String(e)}`);
    }
  }

  private loadSession(): FeedSession | null {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw) as FeedSession;
      if (s.v !== 1 || typeof s.sent !== 'number' || !Array.isArray(s.visited)) return null;
      if (Date.now() - s.startedAt > SESSION_TTL) {
        this.clearSession();
        return null;
      }
      return s;
    } catch {
      return null;
    }
  }

  private clearSession(): void {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch { /* ignore */ }
  }
}
