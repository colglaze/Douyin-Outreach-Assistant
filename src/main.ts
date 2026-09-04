/**
 * 入口（文档第 12 章私信执行流程 + 第 30 章开发优先级）。
 * 启动顺序：存储/配置 -> PageObserver/Router -> UI -> 路由订阅。
 * 核心链路：进入达人页 -> 解析 -> 查库(防重复) -> 模板 -> (AI) -> 打开私信 -> 填入 -> 记录。
 */
import { PageObserver } from './core/observer';
import { Router } from './core/router';
import { DouyinAdapter } from './douyin/adapter';
import { CreatorParser } from './douyin/creatorParser';
import { MessageAdapter } from './douyin/messageAdapter';
import { CreatorRepository } from './creator/creatorRepository';
import { CreatorService, type CreatorPageContext } from './creator/creatorService';
import { MessageService } from './message/messageService';
import { FeedAutomation } from './feed/feedAutomation';
import { polish } from './ai/aiService';
import { openDB } from './storage/indexedDb';
import { loadSettings, saveSettings, getSettingsSync } from './storage/settings';
import { FloatingButton } from './ui/floatingButton';
import { OutreachPanel, type PanelActions } from './ui/panel';
import { showToast } from './ui/toast';
import { sleep } from './utils/dom';
import { logger } from './utils/logger';

const SCOPE = 'Main';
const VERSION = '0.5.4';

// BUG-20260903-03：存活标记必须是最早执行的语句——
// 用户在控制台过滤 [DouyinOutreach] 即可确认脚本是否被注入执行
logger.info(SCOPE, `userscript alive v${VERSION}, href=${location.href}`);

/** 初始化失败/致命错误横幅（左下角红色，含版本号，便于用户截图反馈） */
function showFatalBanner(msg: string): void {
  if (!document.body || document.getElementById('doa-fatal-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'doa-fatal-banner';
  banner.style.cssText = [
    'position:fixed', 'left:16px', 'bottom:16px', 'z-index:9999999',
    'background:#fff1f0', 'border:1px solid #ffa39e', 'color:#cf1322',
    'padding:10px 14px', 'border-radius:10px', 'font-size:12px', 'max-width:340px',
    'font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
  ].join(';');
  banner.textContent = `达人助手初始化失败（v${VERSION}）：${msg} —— 请截图反馈`;
  document.body.appendChild(banner);
}

// BUG-20260903-03：bootstrap try 之外的异常（异步回调、事件处理器）也留痕。
// 抖音自身脚本报错很多，只有悬浮按钮不存在时才弹横幅，避免误报刷屏。
window.addEventListener('error', (e) => {
  logger.error(SCOPE, `window error: ${e.message}`);
  if (!document.getElementById('doa-fab')) showFatalBanner(e.message || 'unknown error');
});
window.addEventListener('unhandledrejection', (e) => {
  logger.error(SCOPE, `unhandled rejection: ${String(e.reason)}`);
  if (!document.getElementById('doa-fab')) showFatalBanner(String(e.reason));
});

/** 等 body 就绪：DOMContentLoaded 已过时不再触发，改用观察者 + 超时兜底（BUG-20260903-03） */
function ensureBody(timeoutMs = 5000): Promise<boolean> {
  if (document.body) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      obs.disconnect();
      resolve(ok);
    };
    const timer = setTimeout(() => done(!!document.body), timeoutMs);
    const obs = new MutationObserver(() => {
      if (document.body) done(true);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', () => done(!!document.body), { once: true });
  });
}

async function bootstrap(): Promise<void> {
  // 0. 等 body 就绪（document-idle 下 body 理论上已存在，双保险 + 超时兜底）
  if (!(await ensureBody())) {
    logger.error(SCOPE, 'document.body not ready after 5s, abort bootstrap');
    return;
  }

  // 1. UI 骨架最先渲染（REQ-20260903-02 修复"主页没有任何按钮"）：
  //    后续任何初始化失败，悬浮按钮都必须可见
  const panel = new OutreachPanel();
  const fab = new FloatingButton(() => panel.toggle(), VERSION);
  fab.setVisible(true);

  // BUG-20260903-03：自愈巡检——抖音 SPA 重绘若移除外部挂载节点，自动重新挂载
  setInterval(() => {
    fab.ensureMounted();
    panel.ensureMounted();
  }, 2000);

  try {
    // 2. 基础设施
    await openDB();
    await loadSettings();

    // 3. 各层实例（依赖方向：ui -> service -> adapter -> infra）
    const adapter = new DouyinAdapter();
    const parser = new CreatorParser(adapter);
    const messageAdapter = new MessageAdapter(adapter);
    const repo = new CreatorRepository();
    const creatorService = new CreatorService(repo);
    const messageService = new MessageService(repo);

  // 4. 连刷自动化（REQ-20260903-02）：状态变化刷新面板，终态 toast
  const feedAuto = new FeedAutomation({
    adapter, messageAdapter, parser, creatorService, messageService,
    onChange: (snap) => {
      panel.refreshFeed();
      if (snap.state === 'DONE' || snap.state === 'STOPPED' || snap.state === 'ERROR') {
        showToast(snap.message, snap.state === 'ERROR' ? 'warn' : 'success', 4000);
      }
    },
  });

  // 5. 面板动作回调：UI 不碰抖音 DOM，这里统一编排
  let currentCtx: CreatorPageContext | null = null;

  const actions: PanelActions = {
    onSaveToLibrary: async () => {
      if (!currentCtx) return;
      const { isNew } = await creatorService.saveToLibrary(currentCtx.info);
      showToast(isNew ? '已加入达人库' : '达人库信息已更新', 'success');
      currentCtx = await creatorService.syncFromPage(currentCtx.info);
      panel.showForCreator(currentCtx, actions);
    },

    onStatusChange: async (status) => {
      if (!currentCtx?.existing) return;
      await creatorService.markStatus(currentCtx.existing.id, status);
      showToast(`状态已更新为：${status}`, 'success');
      currentCtx = await creatorService.syncFromPage(currentCtx.info);
      panel.showForCreator(currentCtx, actions);
    },

    onOpenMessage: async () => {
      const ok = await messageAdapter.openMessageDialog(currentCtx?.info.nickname);
      showToast(ok ? '私信窗口已打开' : '未找到私信入口，可能未登录或页面未加载完成', ok ? 'success' : 'error');
    },

    onFillMessage: async (text, templateId) => {
      if (!currentCtx) return;
      // 未入库的达人先自动入库，保证联系记录有归属（文档第 12 章流程）
      if (!currentCtx.existing) {
        await creatorService.saveToLibrary(currentCtx.info);
        currentCtx = await creatorService.syncFromPage(currentCtx.info);
      }
      const opened = await messageAdapter.openMessageDialog(currentCtx.info.nickname);
      if (!opened) {
        showToast('打开私信失败，请确认已登录', 'error');
        return;
      }
      await sleep(300);
      const filled = await messageAdapter.fillMessage(text);
      if (!filled) {
        showToast('未找到私信输入框', 'error');
        return;
      }
      await messageService.recordOutreach(currentCtx.existing!.id, text, templateId)
        .then(async (msg) => {
          // REQ-20260903-01：自动发送开关（全局持久，默认关闭）。
          // 仅在填入成功后自动点击一次发送；关闭时行为与 V0.3 一致（人工点击）。
          if (getSettingsSync().autoSendEnabled) {
            const sent = await messageAdapter.sendMessage();
            if (sent) {
              await messageService.markSent(msg.id);
              showToast('已自动发送私信', 'success');
            } else {
              showToast('自动发送未被平台接受：请在当前 IM 窗口手动点击发送', 'warn', 4500);
            }
          } else {
            showToast('已填入私信，请人工确认后发送', 'success');
          }
        });
      currentCtx = await creatorService.syncFromPage(currentCtx.info);
      panel.showForCreator(currentCtx, actions);
    },

    onAiPolish: async (text) => {
      if (!currentCtx) return text;
      const result = await polish(text, currentCtx.info);
      if (result.aiUsed) {
        showToast('AI 优化完成', 'success');
      } else if (result.error) {
        showToast(result.error, 'warn', 3500);
      }
      return result.text;
    },

    onSaveSettings: async (patch) => {
      await saveSettings(patch);
      showToast('设置已保存', 'success');
      // 设置中的品牌变量会影响模板渲染，刷新面板上下文
      if (currentCtx) panel.showForCreator(currentCtx, actions);
    },

    // REQ-20260903-02：连刷自动化控制
    onStartFeedAuto: async () => {
      await feedAuto.start();
    },
    onStopFeedAuto: () => feedAuto.stop(),
    getFeedAutoSnapshot: () => feedAuto.snapshot(),
  };

  // 6. 路由订阅：达人页解析 + 面板数据刷新；推荐页进入连刷视图；其他页面清空面板
  const router = new Router();

  router.on('CREATOR', async () => {
    // SPA 达人页内容异步渲染，稍等再解析；失败则短延迟重试一次
    await sleep(1200);
    let info = parser.parse();
    if (!info) {
      await sleep(1500);
      info = parser.parse();
    }
    if (!info) {
      logger.warn(SCOPE, 'creator parse failed on CREATOR page');
      panel.clear();
      return;
    }
    currentCtx = await creatorService.syncFromPage(info);
    panel.showForCreator(currentCtx, actions);
    if (currentCtx.alreadyContacted) {
      showToast(`⚠ ${info.nickname} 之前已联系过`, 'warn', 3500);
    }
  });

  router.on('HOME', () => panel.showFeedHome(actions));
  router.on('SEARCH', () => panel.clear());
  router.on('VIDEO', () => panel.clear());
  router.on('MESSAGE', () => panel.clear());
  router.on('UNKNOWN', () => panel.clear());

  // 7. 启动页面监听（会立即派发一次当前页面）
  const observer = new PageObserver();
  observer.start();

  // 8. 连刷会话续跑（BUG-20260903-02）：跳达人主页必经整页刷新，
  //    脚本重启后若 sessionStorage 中有 RUNNING 会话，按当前页面类型继续执行
  feedAuto.resume().catch((e) => {
    logger.error(SCOPE, `feed automation resume failed: ${String(e)}`);
  });

  logger.info(SCOPE, `Douyin Outreach Assistant started (v${VERSION})`);
  } catch (e) {
    // 初始化失败：悬浮按钮已渲染，这里给出可见错误横幅便于用户反馈
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    logger.error(SCOPE, `bootstrap failed: ${msg}`, e);
    showFatalBanner(msg);
  }
}

bootstrap().catch((e) => {
  logger.error(SCOPE, `bootstrap failed: ${String(e)}`, e);
  showFatalBanner(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
});
