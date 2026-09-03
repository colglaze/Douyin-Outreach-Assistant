// ==UserScript==
// @name         抖音达人商务助手 (Douyin Outreach Assistant)
// @namespace    https://github.com/douyin-outreach
// @version      0.5.3
// @description  达人识别 / 达人库 / 私信模板 / AI润色 / 一键填入私信 / 联系记录（默认人工确认，自动发送需显式开启）
// @author       douyin-outreach
// @match        https://www.douyin.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      api.openai.com
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

"use strict";
(() => {
  // src/core/eventBus.ts
  var EventBus = class {
    constructor() {
      this.handlers = /* @__PURE__ */ new Map();
    }
    /** 订阅事件，返回取消订阅函数 */
    on(event, handler) {
      if (!this.handlers.has(event)) this.handlers.set(event, /* @__PURE__ */ new Set());
      this.handlers.get(event).add(handler);
      return () => this.off(event, handler);
    }
    off(event, handler) {
      this.handlers.get(event)?.delete(handler);
    }
    emit(event, payload) {
      this.handlers.get(event)?.forEach((h) => {
        try {
          h(payload);
        } catch (e) {
          console.error(`[DouyinOutreach][EventBus] handler error on "${event}"`, e);
        }
      });
    }
  };
  var bus = new EventBus();
  var Events = {
    /** 页面（路由）变化，payload: { type: PageType, url: string } */
    PAGE_CHANGED: "page:changed",
    /** DOM 发生显著变化（防抖后），payload: null */
    DOM_CHANGED: "dom:changed"
  };

  // src/utils/logger.ts
  var debugEnabled = false;
  function setDebug(enabled) {
    debugEnabled = enabled;
  }
  function fmt(scope) {
    return `[DouyinOutreach][${scope}]`;
  }
  var logger = {
    info(scope, msg, ...data) {
      console.log(fmt(scope), msg, ...data);
    },
    warn(scope, msg, ...data) {
      console.warn(fmt(scope), msg, ...data);
    },
    error(scope, msg, ...data) {
      console.error(fmt(scope), msg, ...data);
    },
    debug(scope, msg, ...data) {
      if (debugEnabled) console.debug(fmt(scope), msg, ...data);
    }
  };

  // src/core/observer.ts
  var SCOPE = "PageObserver";
  var PageObserver = class {
    constructor() {
      this.lastUrl = location.href;
      this.lastPageType = "UNKNOWN";
      this.mutationObserver = null;
      this.urlCheckTimer = null;
      this.domDebounceTimer = null;
      this.onUrlMaybeChanged = () => {
        if (location.href === this.lastUrl) return;
        this.lastUrl = location.href;
        const type = this.detectPageType();
        if (type !== this.lastPageType) {
          logger.info(SCOPE, `page changed: ${this.lastPageType} -> ${type}`);
          this.lastPageType = type;
        }
        bus.emit(Events.PAGE_CHANGED, { type, url: this.lastUrl });
      };
    }
    /** 根据 URL 识别页面类型（文档 5.1：HOME/SEARCH/CREATOR/VIDEO/MESSAGE/UNKNOWN） */
    detectPageType(url = location.href) {
      try {
        const path = new URL(url).pathname;
        if (path.startsWith("/user/")) return "CREATOR";
        if (path.startsWith("/search")) return "SEARCH";
        if (path.startsWith("/video/") || path.startsWith("/note/")) return "VIDEO";
        if (path.startsWith("/im")) return "MESSAGE";
        if (path === "/" || path === "" || path === "/jingxuan") return "HOME";
        return "UNKNOWN";
      } catch {
        return "UNKNOWN";
      }
    }
    /** 启动监听：URL（pushState/replaceState/popstate/轮询兜底）+ MutationObserver */
    start() {
      this.patchHistory();
      window.addEventListener("popstate", this.onUrlMaybeChanged);
      window.addEventListener("hashchange", this.onUrlMaybeChanged);
      this.urlCheckTimer = window.setInterval(this.onUrlMaybeChanged, 800);
      this.observeDOM();
      this.lastPageType = this.detectPageType();
      bus.emit(Events.PAGE_CHANGED, { type: this.lastPageType, url: this.lastUrl });
      logger.info(SCOPE, `started, initial page = ${this.lastPageType}`);
    }
    stop() {
      window.removeEventListener("popstate", this.onUrlMaybeChanged);
      window.removeEventListener("hashchange", this.onUrlMaybeChanged);
      if (this.urlCheckTimer !== null) window.clearInterval(this.urlCheckTimer);
      this.mutationObserver?.disconnect();
    }
    /** 劫持 history 以捕获 SPA 路由跳转 */
    patchHistory() {
      const fire = () => this.onUrlMaybeChanged();
      ["pushState", "replaceState"].forEach((name) => {
        const original = history[name];
        history[name] = function(...args) {
          const ret = original.apply(this, args);
          fire();
          return ret;
        };
      });
    }
    observeDOM() {
      this.mutationObserver = new MutationObserver(() => {
        if (this.domDebounceTimer !== null) window.clearTimeout(this.domDebounceTimer);
        this.domDebounceTimer = window.setTimeout(() => {
          bus.emit(Events.DOM_CHANGED, null);
        }, 500);
      });
      this.mutationObserver.observe(document.body, { childList: true, subtree: true });
    }
  };

  // src/core/router.ts
  var Router = class {
    constructor() {
      this.handlers = /* @__PURE__ */ new Map();
      bus.on(Events.PAGE_CHANGED, (p) => this.dispatch(p));
    }
    /** 注册某类页面的回调；type 传 '*' 表示所有页面 */
    on(type, handler) {
      if (!this.handlers.has(type)) this.handlers.set(type, /* @__PURE__ */ new Set());
      this.handlers.get(type).add(handler);
    }
    dispatch(payload) {
      this.handlers.get(payload.type)?.forEach((h) => h(payload));
      this.handlers.get("*")?.forEach((h) => h(payload));
    }
  };

  // src/douyin/selectors.ts
  var selectors = {
    /** 达人主页 - 昵称（页面唯一 h1，实测文本即昵称） */
    creatorName: [
      '[data-e2e="user-detail"] h1',
      '[data-e2e="user-info"] h1',
      "h1"
    ],
    /** 达人主页 - 粉丝数（容器文本形如 "粉丝113.2万"，取数字部分由 parseChineseCount 处理） */
    followerCount: [
      '[data-e2e="user-info-fans"]'
    ],
    /** 达人主页 - 关注数 */
    followingCount: [
      '[data-e2e="user-info-follow"]'
    ],
    /** 达人主页 - 获赞数 */
    likesCount: [
      '[data-e2e="user-info-like"]'
    ],
    /** 达人主页 - 简介/签名（user-info 内 <p>抖音号</p> 之后的兄弟 div，实测有效） */
    signature: [
      '[data-e2e="user-info"] p + div',
      '[data-e2e="user-detail"] p + div'
    ],
    /** 达人主页 - 头像 */
    avatar: [
      '[data-e2e="user-detail"] img[class*="avatar"]',
      '[class*="avatar"] img',
      '[data-e2e="user-info"] img'
    ],
    /**
     * 达人主页 - 私信按钮。
     * 实测为 <button class="semi-button semi-button-secondary j85duc">私信</button>，无 data-e2e。
     * 注意：semi-button-secondary 同时被"分享主页"等按钮使用，不能作为候选，
     * 统一由 adapter 按按钮文本"私信"兜底匹配；hashed class 仅作快速路径。
     */
    messageButton: [
      'button[class*="j85duc"]'
    ],
    /**
     * 私信对话框容器（登录态实测命中，BUG-20260902-01）。
     * 注意：点"私信"后可能先落在会话列表层（StackLayout list），聊天层异步加载，
     * 输入框需要等待出现（messageAdapter 已按 12s 等待处理）。
     */
    messageDialog: [
      '[data-e2e="im-dialog"]',
      '[class*="message-box"]',
      '[class*="chat-box"]'
    ],
    /**
     * 私信输入框（登录态实测命中，BUG-20260902-01）。
     * 真实结构：im-dialog 内 Slate.js 编辑器
     * <div class="zone-container editor-kit-container messageEditorinputArea"
     *      data-slate-editor="true" contenteditable="true" data-placeholder="发送消息">
     * 已验证 execCommand('insertText') 可被 Slate 的 beforeinput 正常接收。
     */
    messageInput: [
      '[data-e2e="im-dialog"] div[data-slate-editor][contenteditable="true"]',
      '[data-e2e="im-dialog"] div[contenteditable="true"][class*="editor"]',
      '[data-e2e="im-dialog"] div[contenteditable="true"]',
      'div[contenteditable="true"]',
      'textarea[class*="input"]'
    ],
    /**
     * 私信发送按钮（REQ-20260903-01，2026-09-03 真实取证校准）。
     * 实测：发送按钮是输入区右侧的 svg 图标，class 含 publishBtn，
     * 填入文本后追加 publishRedBtn（变红可点），无文本、无 aria-label、无 data-e2e。
     * 兜底由 DouyinAdapter 在 im-dialog 内按按钮文本"发送"匹配。
     */
    sendButton: [
      '[data-e2e="im-dialog"] [class*="e2e-send-msg-btn"]',
      '[data-e2e="im-dialog"] svg[class*="publishBtn"]',
      '[data-e2e="im-dialog"] [class*="publishBtn"]'
    ],
    /**
     * 推荐页 feed - 达人主页链接（REQ-20260903-02）。
     * 采集方式来自 probe-feed.mjs 实测：feed 页存在 a[href*="/user/"] 锚点（作者头像/昵称）。
     * 由 DouyinAdapter.getFeedAuthorLinks 统一过滤（排除 /user/self）。
     * 注意（BUG-20260903-02）：只有推荐 feed（/，SPA 进入）才有真实作者链接；
     * 精选落地页 /jingxuan 上只有 /user/self。
     */
    feedAuthorLinks: [
      'a[href*="/user/"]'
    ],
    /**
     * 侧栏「推荐」导航链接（BUG-20260903-02 实测）：
     * 打开 https://www.douyin.com/ 会 302 到 /jingxuan（精选），
     * 推荐 feed 只能通过该锚点 SPA 进入（/?recommend=1，实测无刷新、脚本状态保留）。
     */
    recommendNavLink: [
      'a[href*="recommend=1"]'
    ]
  };

  // src/utils/dom.ts
  function queryFirst(candidates, root = document) {
    for (const sel of candidates) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }
  function findByText(selector, text, root = document) {
    const els = root.querySelectorAll(selector);
    for (const el of Array.from(els)) {
      if ((el.textContent || "").trim().includes(text)) return el;
    }
    return null;
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function genId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // src/utils/number.ts
  function parseChineseCount(text) {
    if (!text) return 0;
    const cleaned = text.replace(/[,，\s]/g, "");
    const m = cleaned.match(/([\d.]+)\s*([万wW千kK]?)/);
    if (!m) return 0;
    const base = parseFloat(m[1]);
    if (Number.isNaN(base)) return 0;
    const unit = m[2];
    if (unit === "\u4E07" || unit === "w" || unit === "W") return Math.round(base * 1e4);
    if (unit === "\u5343" || unit === "k" || unit === "K") return Math.round(base * 1e3);
    return Math.round(base);
  }
  function formatCount(n) {
    if (n >= 1e4) {
      const w = n / 1e4;
      return `${w >= 100 ? Math.round(w) : w.toFixed(1)}W`;
    }
    return String(n);
  }

  // src/douyin/adapter.ts
  var SCOPE2 = "DouyinAdapter";
  var DouyinAdapter = class {
    /** 抖音 DOM 的可见性：不能依赖 offsetParent（SVG/StackLayout 会误判）。 */
    isVisible(el) {
      if (!el.isConnected) return false;
      for (let node = el; node; node = node.parentElement) {
        if (node.hidden || node.getAttribute("aria-hidden") === "true") return false;
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    messageDialogs(root = document) {
      const candidates = Array.from(root.querySelectorAll(
        selectors.messageDialog.join(",")
      ));
      return candidates.filter((dialog) => this.isVisible(dialog));
    }
    inputsIn(root) {
      return Array.from(root.querySelectorAll(
        selectors.messageInput.join(",")
      )).filter((el) => this.isUsableInput(el));
    }
    /** 可交互的聊天编辑器；可见但 disabled 的占位输入框不算已进入聊天层。 */
    isUsableInput(el) {
      if (!this.isVisible(el)) return false;
      if (el.disabled) return false;
      if (el.getAttribute("aria-disabled") === "true") return false;
      return el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    }
    /** 通用：按选择器键取元素（自动按候选数组降级） */
    query(key, root = document) {
      const el = queryFirst(selectors[key], root);
      if (!el) logger.debug(SCOPE2, `selector miss: ${key}`);
      return el;
    }
    /** 取元素文本 */
    textOf(key, root = document) {
      return (this.query(key, root)?.textContent || "").trim();
    }
    // ---------- 达人主页字段 ----------
    getCreatorName() {
      return this.textOf("creatorName");
    }
    /** 从 URL 提取 secUid：/user/<secUid> */
    getCreatorSecUid() {
      const m = location.pathname.match(/^\/user\/([^/?]+)/);
      return m ? m[1] : "";
    }
    getCreatorUrl() {
      return location.href.split("?")[0];
    }
    getAvatar() {
      const img = this.query("avatar");
      return img?.src || "";
    }
    getSignature() {
      return this.textOf("signature");
    }
    /**
     * 粉丝数：优先专用选择器；兜底在主页统计区文本中找 "粉丝 xx万"。
     */
    getFollowerCount() {
      const direct = this.textOf("followerCount");
      if (direct) return parseChineseCount(direct);
      const fallback = this.extractCountByLabel("\u7C89\u4E1D");
      if (fallback === null) logger.warn(SCOPE2, "follower count not found");
      return fallback ?? 0;
    }
    getFollowingCount() {
      const direct = this.textOf("followingCount");
      if (direct) return parseChineseCount(direct);
      return this.extractCountByLabel("\u5173\u6CE8") ?? 0;
    }
    getLikesCount() {
      const direct = this.textOf("likesCount");
      if (direct) return parseChineseCount(direct);
      return this.extractCountByLabel("\u83B7\u8D5E") ?? 0;
    }
    /** 在页面文本中查找 "<label> <数字>" 结构（如 "粉丝 18.6万"） */
    extractCountByLabel(label) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        const t = (node.textContent || "").trim();
        if (t === label || t.startsWith(label)) {
          const parent = node.parentElement;
          const around = `${t} ${parent?.textContent || ""}`;
          const m = around.match(/([\d.,万wW千kK]+)/);
          if (m) return parseChineseCount(m[1]);
        }
      }
      return null;
    }
    // ---------- 私信操作 ----------
    /** 查找"私信"按钮：必须是可见且确实包含目标文本的按钮。 */
    getMessageButton() {
      const candidates = [
        ...Array.from(document.querySelectorAll(
          selectors.messageButton.join(",")
        )),
        ...Array.from(document.querySelectorAll('button, [role="button"]'))
      ];
      return candidates.find((el) => this.isVisible(el) && (el.textContent || "").trim().includes("\u79C1\u4FE1")) ?? null;
    }
    /** 当前可见 IM 对话框；优先含聊天输入框、且更靠后的活动层。 */
    getMessageDialog() {
      const dialogs = this.messageDialogs();
      return [...dialogs].reverse().find((dialog) => this.inputsIn(dialog).length > 0) ?? dialogs[dialogs.length - 1] ?? null;
    }
    /**
     * 获取同一个 IM surface 中的对话框、输入框和发送按钮。
     * 抖音会在 DOM 中保留多个 StackLayout/dialog，所有消息操作必须使用同一层，
     * 不能分别从全局 DOM 查询，否则会出现“视觉有字但实际发送空消息”。
     */
    getMessageSurface(root = document) {
      const dialogs = this.messageDialogs(root);
      for (const dialog of [...dialogs].reverse()) {
        const input = this.inputsIn(dialog)[0];
        if (input) {
          return { dialog, input, sendButton: this.getSendButtonIn(dialog) };
        }
      }
      return null;
    }
    /** 当前可见聊天输入框；没有可见输入框时返回 null，不回退到隐藏副本。 */
    getMessageInput() {
      return this.getMessageSurface()?.input ?? null;
    }
    /** 发送按钮必须处于可用状态；灰色占位图标不能触发自动发送。 */
    isSendButtonReady(el) {
      if (!this.isVisible(el)) return false;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      const cls = el.getAttribute("class") || "";
      return !cls.includes("publishBtn") || cls.includes("publishRedBtn") || cls.includes("e2e-send-msg-btn");
    }
    /** 在指定 IM surface 内查找可见发送按钮。 */
    getSendButtonIn(root) {
      const candidates = Array.from(root.querySelectorAll(
        selectors.sendButton.join(",")
      )).filter((el) => this.isVisible(el));
      return candidates.sort((a, b) => {
        const aReady = /publishRedBtn|send-msg-btn/.test(a.getAttribute("class") || "");
        const bReady = /publishRedBtn|send-msg-btn/.test(b.getAttribute("class") || "");
        return Number(bReady) - Number(aReady);
      })[0] ?? Array.from(root.querySelectorAll('button, [role="button"]')).find((el) => this.isVisible(el) && (el.textContent || "").trim().includes("\u53D1\u9001")) ?? null;
    }
    /**
     * 查找私信"发送"按钮（REQ-20260903-01，2026-09-03 取证校准）。
     * 优先从当前可见 IM surface 返回，避免按钮与输入框来自不同残留面板。
     */
    getSendButton() {
      return this.getMessageSurface()?.sendButton ?? null;
    }
    /**
     * IM 面板会话列表层中按昵称定位会话项（BUG-20260903-02）。
     * 场景：面板 SDK 未就绪时点"私信"可能落在列表层而不是目标聊天层，
     * 需要点列表中对应会话项进入聊天层。
     * 实测结构：会话行容器为 div[class*="ConversationItemwrapper"]，
     * 点击行容器（而非内部文本节点）才能可靠触发进入聊天层。
     */
    /** 查找当前可见列表层中的目标会话项；不能由聊天 surface 的首个 dialog 决定。 */
    getImConversationItem(nickname) {
      const normalized = nickname.trim();
      if (!normalized) return null;
      for (const dialog of this.messageDialogs()) {
        const wrappers = Array.from(dialog.querySelectorAll(
          '[class*="ConversationItemwrapper"], [class*="conversationItem"]'
        )).filter((el) => this.isVisible(el));
        const wrapper = wrappers.find((el) => {
          const text = (el.textContent || "").trim();
          return text === normalized || text.startsWith(`${normalized} `) || text.startsWith(`${normalized}
`);
        });
        if (wrapper) return wrapper;
        if (this.inputsIn(dialog).length > 0) continue;
        const match = Array.from(dialog.querySelectorAll("*")).filter((el) => {
          if (!this.isVisible(el)) return false;
          const text = (el.textContent || "").trim();
          return text === normalized || text.startsWith(`${normalized} `) || text.startsWith(`${normalized}
`);
        }).sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0];
        const item = wrapper && this.isVisible(wrapper) ? wrapper : match;
        if (item) return item;
      }
      return null;
    }
    /**
     * 推荐页 feed 中的达人主页链接（REQ-20260903-02）。
     * 选择器集中在 selectors.feedAuthorLinks，这里只做去重与排除自己的过滤。
     */
    getFeedAuthorLinks() {
      const sel = selectors.feedAuthorLinks[0];
      const seen = /* @__PURE__ */ new Set();
      return Array.from(document.querySelectorAll(sel)).filter((a) => {
        const url = a.href.split("?")[0];
        if (url.includes("/user/self") || seen.has(url)) return false;
        seen.add(url);
        return true;
      });
    }
    // ---------- 推荐 feed 导航（BUG-20260903-02 实测补充） ----------
    /**
     * 侧栏「推荐」导航锚点。
     * 实测：打开 / 会 302 到 /jingxuan（精选），推荐 feed 只能点该锚点 SPA 进入（无刷新）。
     */
    getRecommendNavLink() {
      return this.query("recommendNavLink");
    }
    /**
     * 关闭推荐 feed 的新手引导浮层（"滚动鼠标…查看更多推荐视频 [我知道了]"）。
     * 浮层会遮挡/吞掉 feed 上的点击，进入推荐后必须调用一次；不存在则静默跳过。
     */
    dismissFeedGuide() {
      const btn = findByText("button", "\u6211\u77E5\u9053\u4E86") || findByText("span", "\u6211\u77E5\u9053\u4E86") || findByText("div", "\u6211\u77E5\u9053\u4E86");
      if (btn && btn.offsetParent) {
        btn.click();
        logger.info(SCOPE2, "feed guide overlay dismissed");
      }
    }
    /**
     * 站内整页跳转。
     * 实测（BUG-20260903-02）：抖音跳 /user/ 达人主页一定是整页刷新（SPA 不接管），
     * 合成锚点点击是最稳定的触发方式；调用方需自行持久化状态（sessionStorage 续跑）。
     */
    navigateTo(url) {
      const a = document.createElement("a");
      a.href = url;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      logger.info(SCOPE2, `navigateTo: ${url.slice(0, 60)}`);
    }
  };

  // src/douyin/creatorParser.ts
  var SCOPE3 = "CreatorParser";
  var CreatorParser = class {
    constructor(adapter) {
      this.adapter = adapter;
    }
    /** 解析当前达人主页；非达人页或关键字段缺失时返回 null */
    parse() {
      const secUid = this.adapter.getCreatorSecUid();
      const nickname = this.adapter.getCreatorName();
      if (!secUid) {
        logger.warn(SCOPE3, "not a creator page (secUid missing)");
        return null;
      }
      if (!nickname) {
        logger.warn(SCOPE3, "creator nickname not found, page may still be loading");
        return null;
      }
      const info = {
        secUid,
        nickname,
        avatar: this.adapter.getAvatar(),
        followers: this.adapter.getFollowerCount(),
        following: this.adapter.getFollowingCount(),
        likes: this.adapter.getLikesCount(),
        signature: this.adapter.getSignature(),
        url: this.adapter.getCreatorUrl(),
        tags: this.extractTags()
      };
      logger.info(SCOPE3, "creator detected", {
        nickname: info.nickname,
        followers: info.followers
      });
      return info;
    }
    /** 从简介中粗提取标签（#话题 或常见领域词），第一版保持简单 */
    extractTags() {
      const sig = this.adapter.getSignature();
      const tags = [];
      const hashTags = sig.match(/#([^\s#]+)/g);
      if (hashTags) tags.push(...hashTags.map((t) => t.slice(1)));
      return tags.slice(0, 5);
    }
  };

  // src/douyin/messageAdapter.ts
  var SCOPE4 = "MessageAdapter";
  var MessageAdapter = class {
    constructor(adapter) {
      this.adapter = adapter;
      this.surface = null;
    }
    currentSurface() {
      if (this.surface?.dialog.isConnected && this.surface.input.isConnected && this.adapter.isVisible(this.surface.dialog) && this.adapter.isVisible(this.surface.input) && this.surface.dialog.contains(this.surface.input)) {
        return this.surface;
      }
      const latest = this.adapter.getMessageSurface();
      this.surface = latest;
      return latest;
    }
    async waitForDialogGone(dialog, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const stillVisible = this.adapter.isVisible(dialog);
        const current = this.adapter.getMessageSurface();
        if (!stillVisible && current?.dialog !== dialog) return;
        await sleep(200);
      }
    }
    dispatchActivation(el) {
      const r = el.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2
      };
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        el.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, opts) : new MouseEvent(type, opts));
      }
    }
    async waitForChatSurface(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const surface = this.adapter.getMessageSurface();
        if (surface) return surface;
        await sleep(300);
      }
      return null;
    }
    /**
    * 点击"私信"按钮打开私信窗口，返回是否成功。
    * 传入 nickname 时，若面板落在会话列表层（BUG-20260903-02），自动点列表中
    * 对应会话项进入聊天层；首轮失败会关闭面板重试一次（实测达人页加载早期
    * IM SDK 未就绪会吞掉首次点击，等待+重试后可恢复）。
    */
    async openMessageDialog(nickname, forceFresh = false) {
      const previous = this.surface?.dialog ?? this.adapter.getMessageDialog();
      if (forceFresh && previous) {
        this.surface = null;
        this.closeMessageDialog();
        await this.waitForDialogGone(previous, 2500);
      } else {
        this.surface = null;
      }
      for (let attempt = 1; attempt <= 2; attempt++) {
        const btn = this.adapter.getMessageButton();
        if (!btn) {
          logger.error(SCOPE4, "message button not found");
          return false;
        }
        btn.click();
        logger.info(SCOPE4, `message button clicked (attempt ${attempt})`);
        const deadline = Date.now() + 15e3;
        let clickedItem = false;
        while (Date.now() < deadline) {
          const surface = this.adapter.getMessageSurface();
          if (surface) {
            this.surface = surface;
            logger.info(SCOPE4, nickname ? "chat input ready (direct conversation opened)" : "chat input ready");
            return true;
          }
          if (nickname && !clickedItem) {
            const item = this.adapter.getImConversationItem(nickname);
            if (item) {
              logger.info(SCOPE4, `conversation item found, activating: ${nickname}`);
              this.dispatchActivation(item);
              clickedItem = true;
            }
          }
          if (clickedItem) {
            const chat = await this.waitForChatSurface(2500);
            if (chat) {
              this.surface = chat;
              logger.info(SCOPE4, "chat input ready after conversation activation");
              return true;
            }
            clickedItem = false;
          }
          await sleep(300);
        }
        if (attempt < 2) {
          logger.warn(SCOPE4, "open dialog failed, reset and retry...");
          this.closeMessageDialog();
          await sleep(3e3);
        }
      }
      this.surface = null;
      logger.error(SCOPE4, "message input not found after opening dialog");
      return false;
    }
    /**
     * 关闭 IM 面板（BUG-20260903-02）。
     * 实测：发完不关闭时，面板状态会跨页面残留，导致下一个达人点"私信"落在列表层；
     * 每次触达后关闭面板可保证下一位达人从干净的聊天层开始。
     */
    closeMessageDialog() {
      const dialog = this.surface?.dialog ?? this.adapter.getMessageDialog();
      if (!dialog) return;
      const close = Array.from(dialog.querySelectorAll('[class*="closeImPage"]')).find((el) => this.adapter.isVisible(el));
      if (close) {
        close.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        this.surface = null;
        logger.info(SCOPE4, "message dialog closed");
      }
    }
    /**
     * 向私信输入框写入文本。
     * 抖音输入框为 Slate.js contenteditable（React 受控），直接赋值不会触发框架状态更新。
     * BUG-20260903-04：禁止 innerHTML 清空——那会摧毁 Slate 的 [data-slate-node] 叶节点，
     * 模型与 DOM 失去映射后 insertText 只写入 DOM（视觉有字、模型为空），
     * 发送时被平台判「不能发送空白消息」。
     * 正解：selectAll 全选既有内容 -> insertText 替换插入，Slate 经原生 beforeinput 同步模型；
     * 兜底用合成 paste 事件（Slate 的 onPaste 会把纯文本写入模型），
     * 绝不直接写 textContent（必然导致模型为空）。
     */
    /** 规范化编辑器文本：Slate 多行会用节点表示换行，校验时忽略零宽字符和空白差异。 */
    normalizeEditorText(text) {
      return text.replace(/[​‌‍﻿\s]/g, "");
    }
    /** 选中 Slate 编辑器既有内容，供写入前替换草稿（不破坏叶节点）。 */
    selectEditorContents(input) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    /** 合成 paste 写入：Slate 的 onPaste 会把多行纯文本拆分进模型（BUG-20260903-04 验证路径）。 */
    pasteIntoSlate(input, text) {
      input.focus();
      this.selectEditorContents(input);
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      dt.setData("text/html", text.split(/\r\n|\r|\n/).map((l) => `<div>${l || "<br>"}</div>`).join(""));
      input.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      }));
    }
    /** execCommand 兜底写入：多行分段插入，避免换行被 insertText 吞掉；不派发 Enter 键盘事件。 */
    insertIntoSlate(input, text) {
      input.focus();
      this.selectEditorContents(input);
      const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      let ok = true;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) {
          ok = document.execCommand("insertText", false, lines[i]) && ok;
        }
        if (i < lines.length - 1) {
          ok = document.execCommand("insertLineBreak", false) && ok;
        }
      }
      return ok;
    }
    /** 校验同一编辑器中是否已有完整文案。 */
    hasFullText(input, expected) {
      const actual = input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.value : input.textContent || "";
      return this.normalizeEditorText(actual) === this.normalizeEditorText(expected);
    }
    async fillMessage(text) {
      if (!text.trim()) {
        logger.warn(SCOPE4, "refusing to fill empty message");
        return false;
      }
      const surface = this.currentSurface();
      const input = surface?.input;
      if (!surface || !input) {
        logger.error(SCOPE4, "message input not found");
        return false;
      }
      if (!this.adapter.isVisible(input) || !surface.dialog.contains(input)) {
        logger.error(SCOPE4, "message surface became invalid before fill");
        this.surface = null;
        return false;
      }
      input.focus();
      await sleep(50);
      if (document.activeElement !== input) {
        logger.warn(SCOPE4, "message input could not receive focus");
      }
      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
        const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        setter?.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const isMultiline = /\r|\n/.test(text);
        if (isMultiline) {
          this.pasteIntoSlate(input, text);
          await sleep(200);
          if (!this.hasFullText(input, text)) {
            logger.warn(SCOPE4, "paste insert incomplete, fallback to per-line insertText");
            const ok = this.insertIntoSlate(input, text);
            if (!ok) logger.warn(SCOPE4, "per-line insertText also reported failure");
          }
        } else {
          const ok = this.insertIntoSlate(input, text);
          if (!ok) logger.warn(SCOPE4, "single-line insertText reported failure");
        }
      }
      await sleep(500);
      if (!input.isConnected || !this.adapter.isVisible(input) || !surface.dialog.contains(input)) {
        logger.error(SCOPE4, "message input replaced during fill");
        this.surface = null;
        return false;
      }
      if (!this.hasFullText(input, text)) {
        const actual = input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.value : input.textContent || "";
        logger.error(SCOPE4, `fill verification failed: expected ${text.length} chars, got ${actual.length} chars`);
        return false;
      }
      logger.info(SCOPE4, `message filled, length = ${text.length}`);
      return true;
    }
    /**
     * 点击发送按钮发送当前已填入的消息（REQ-20260903-01）。
     * 实测发送按钮可能需要同时触发 svg 与 inputAction 宿主的完整事件序列。
     * 发送成功后输入框会被清空，以此做结果校验（防"点了但没发出去"的静默失败）。
     * 边界：只在"填入成功后"被上层调用，单次派发，不做重试轰炸。
     */
    messageText(input) {
      return (input.textContent || input.value || "").replace(/[​‌‍﻿\s]/g, "");
    }
    async waitForInputClear(input, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!input.isConnected) return false;
        if (!this.messageText(input)) return true;
        await sleep(150);
      }
      return !input.isConnected || !this.messageText(input);
    }
    async sendMessage() {
      const surface = this.currentSurface();
      const input = surface?.input;
      let btn = surface?.sendButton;
      if (!surface || !input) {
        logger.error(SCOPE4, "send target not found in current message surface");
        return false;
      }
      const text = this.messageText(input);
      if (!text) {
        logger.error(SCOPE4, "refusing to send empty message");
        return false;
      }
      const deadline = Date.now() + 3e3;
      while ((!btn || !this.adapter.isSendButtonReady(btn)) && Date.now() < deadline) {
        await sleep(250);
        const latest = this.adapter.getMessageSurface();
        if (latest?.dialog === surface.dialog) btn = latest.sendButton;
      }
      if (!btn || !this.adapter.isSendButtonReady(btn)) {
        logger.error(SCOPE4, "send button is not available; synthetic events cannot create trusted click");
        return false;
      }
      const host = btn.closest('[class*="inputAction"]') || btn;
      this.dispatchActivation(btn);
      logger.info(SCOPE4, `send activation dispatched on send target (synthetic=${!new MouseEvent("click").isTrusted})`);
      let sent = await this.waitForInputClear(input, 2500);
      if (!sent && host !== btn && input.isConnected) {
        this.dispatchActivation(host);
        logger.info(SCOPE4, "send target had no effect; host activation dispatched once");
        sent = await this.waitForInputClear(input, 2e3);
      }
      if (sent) {
        logger.info(SCOPE4, "send confirmed (input cleared)");
        return true;
      }
      if (!input.isConnected || !surface.dialog.isConnected) {
        logger.warn(SCOPE4, "message surface replaced before send confirmation");
        this.surface = null;
        return false;
      }
      const residual = this.messageText(input);
      logger.error(SCOPE4, `auto-send not accepted; input still has ${residual.length} chars, please click Send manually`);
      return false;
    }
  };

  // src/storage/indexedDb.ts
  var SCOPE5 = "IndexedDB";
  var DB_NAME = "douyin-outreach";
  var DB_VERSION = 1;
  var Stores = {
    CREATORS: "creators",
    MESSAGES: "messages",
    SETTINGS: "settings"
  };
  var dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(Stores.CREATORS)) {
          const store = db.createObjectStore(Stores.CREATORS, { keyPath: "id" });
          store.createIndex("secUid", "secUid", { unique: true });
          store.createIndex("status", "status", { unique: false });
        }
        if (!db.objectStoreNames.contains(Stores.MESSAGES)) {
          const store = db.createObjectStore(Stores.MESSAGES, { keyPath: "id" });
          store.createIndex("creatorId", "creatorId", { unique: false });
        }
        if (!db.objectStoreNames.contains(Stores.SETTINGS)) {
          db.createObjectStore(Stores.SETTINGS, { keyPath: "key" });
        }
        logger.info(SCOPE5, "database schema initialized");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        logger.error(SCOPE5, "open failed", req.error);
        reject(req.error);
      };
    });
    return dbPromise;
  }
  function tx(db, storeName, mode, run) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const req = run(t.objectStore(storeName));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbPut(storeName, value) {
    const db = await openDB();
    return tx(db, storeName, "readwrite", (s) => s.put(value));
  }
  async function dbGet(storeName, key) {
    const db = await openDB();
    return tx(db, storeName, "readonly", (s) => s.get(key));
  }
  async function dbGetAll(storeName) {
    const db = await openDB();
    return tx(db, storeName, "readonly", (s) => s.getAll());
  }
  async function dbGetByIndex(storeName, indexName, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, "readonly");
      const req = t.objectStore(storeName).index(indexName).get(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbDelete(storeName, key) {
    const db = await openDB();
    return tx(db, storeName, "readwrite", (s) => s.delete(key));
  }

  // src/creator/creatorRepository.ts
  var CreatorRepository = class {
    /** secUid -> 稳定的内部 id */
    toId(secUid) {
      return `creator_${secUid}`;
    }
    async exists(secUid) {
      return await this.getBySecUid(secUid) !== void 0;
    }
    async getBySecUid(secUid) {
      return dbGetByIndex(Stores.CREATORS, "secUid", secUid);
    }
    async getById(id) {
      return dbGet(Stores.CREATORS, id);
    }
    async list() {
      const all = await dbGetAll(Stores.CREATORS);
      return all.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    /** 由页面解析结果创建新记录；已存在时合并刷新基础字段，保留状态与备注 */
    async upsertFromInfo(info) {
      const id = this.toId(info.secUid);
      const now = Date.now();
      const existing = await this.getBySecUid(info.secUid);
      if (existing) {
        const merged = {
          ...existing,
          nickname: info.nickname || existing.nickname,
          avatar: info.avatar || existing.avatar,
          followers: info.followers || existing.followers,
          following: info.following || existing.following,
          likes: info.likes || existing.likes,
          signature: info.signature || existing.signature,
          url: info.url || existing.url,
          tags: info.tags.length ? info.tags : existing.tags,
          updatedAt: now
        };
        await dbPut(Stores.CREATORS, merged);
        return { creator: merged, isNew: false };
      }
      const creator = {
        ...info,
        id,
        status: "SAVED",
        note: "",
        lastContactAt: null,
        createdAt: now,
        updatedAt: now
      };
      await dbPut(Stores.CREATORS, creator);
      return { creator, isNew: true };
    }
    async updateStatus(id, status) {
      const c = await this.getById(id);
      if (!c) return;
      await dbPut(Stores.CREATORS, {
        ...c,
        status,
        lastContactAt: status === "CONTACTED" ? Date.now() : c.lastContactAt,
        updatedAt: Date.now()
      });
    }
    async updateNote(id, note) {
      const c = await this.getById(id);
      if (!c) return;
      await dbPut(Stores.CREATORS, { ...c, note, updatedAt: Date.now() });
    }
    async remove(id) {
      await dbDelete(Stores.CREATORS, id);
    }
  };

  // src/creator/creatorService.ts
  var SCOPE6 = "CreatorService";
  var CreatorService = class {
    constructor(repo) {
      this.repo = repo;
    }
    /** 同步当前页面达人：不自动入库，只做查询比对（入库动作由用户点击触发） */
    async syncFromPage(info) {
      const existing = await this.repo.getBySecUid(info.secUid);
      const alreadyContacted = !!existing && existing.status !== "NEW" && existing.status !== "SAVED";
      if (alreadyContacted) {
        logger.info(SCOPE6, `creator already contacted: ${info.nickname}, status = ${existing.status}`);
      }
      return { info, existing, alreadyContacted };
    }
    /** 加入达人库（文档第 12 章流程中的"创建记录"步骤） */
    async saveToLibrary(info) {
      const result = await this.repo.upsertFromInfo(info);
      logger.info(SCOPE6, result.isNew ? `creator saved: ${info.nickname}` : `creator refreshed: ${info.nickname}`);
      return result;
    }
    async markStatus(creatorId, status) {
      await this.repo.updateStatus(creatorId, status);
      logger.info(SCOPE6, `status updated: ${creatorId} -> ${status}`);
    }
  };

  // src/message/messageService.ts
  var SCOPE7 = "MessageService";
  var MessageService = class {
    constructor(repo) {
      this.repo = repo;
    }
    /** 记录一次触达（填入私信后调用），并把达人状态推进到 CONTACTED */
    async recordOutreach(creatorId, content, templateId) {
      const msg = {
        id: genId("msg"),
        creatorId,
        type: "OUTREACH",
        content,
        templateId,
        createdAt: Date.now(),
        // 脚本只负责"填入"，发送由用户人工确认（文档第 20 章自动化边界）
        status: "FILLED"
      };
      await dbPut(Stores.MESSAGES, msg);
      await this.repo.updateStatus(creatorId, "CONTACTED");
      logger.info(SCOPE7, `outreach recorded for ${creatorId}, length = ${content.length}`);
      return msg;
    }
    async listByCreator(creatorId) {
      const all = await dbGetAll(Stores.MESSAGES);
      return all.filter((m) => m.creatorId === creatorId).sort((a, b) => b.createdAt - a.createdAt);
    }
    /** 自动发送成功后把消息状态从 FILLED 推进到 SENT（REQ-20260903-01） */
    async markSent(msgId) {
      const all = await dbGetAll(Stores.MESSAGES);
      const msg = all.find((m) => m.id === msgId);
      if (!msg) {
        logger.warn(SCOPE7, `markSent: message ${msgId} not found`);
        return;
      }
      msg.status = "SENT";
      await dbPut(Stores.MESSAGES, msg);
      logger.info(SCOPE7, `message ${msgId} marked as SENT`);
    }
  };

  // src/storage/settings.ts
  var SETTINGS_KEY = "app";
  var DEFAULT_SETTINGS = {
    brand: "",
    brandIntro: "",
    product: "",
    contact: "",
    wechat: "",
    category: "",
    defaultTemplateId: "business_001",
    aiEnabled: false,
    aiEndpoint: "https://api.openai.com/v1/chat/completions",
    aiApiKey: "",
    aiModel: "gpt-4o-mini",
    aiTone: "\u81EA\u7136\u53E3\u8BED\u5316",
    autoSendEnabled: false,
    // REQ-20260903-01：默认禁用，保持人工点击发送
    customMessage: "",
    // REQ-20260903-02：默认空，回退默认模板
    autoBatchLimit: 10,
    // REQ-20260903-02：连刷单会话发送上限
    debug: false
  };
  var cache = null;
  async function loadSettings() {
    if (cache) return cache;
    const row = await dbGet(Stores.SETTINGS, SETTINGS_KEY);
    cache = { ...DEFAULT_SETTINGS, ...row?.value || {} };
    setDebug(cache.debug);
    return cache;
  }
  async function saveSettings(patch) {
    const current = await loadSettings();
    cache = { ...current, ...patch };
    await dbPut(Stores.SETTINGS, { key: SETTINGS_KEY, value: cache });
    setDebug(cache.debug);
    return cache;
  }
  function getSettingsSync() {
    return cache || DEFAULT_SETTINGS;
  }

  // src/message/templateEngine.ts
  var BUILTIN_TEMPLATES = [
    {
      id: "business_001",
      name: "\u5546\u52A1\u5408\u4F5C",
      builtIn: true,
      content: "\u4F60\u597D {{nickname}}\uFF0C\n\n\u6211\u4EEC\u662F {{brand}}\uFF0C\u76EE\u524D\u6B63\u5728\u5BFB\u627E\u4F18\u8D28\u7684{{category}}\u521B\u4F5C\u8005\u8FDB\u884C\u5408\u4F5C\u3002\n\n\u770B\u4E86\u4F60\u7684\u5185\u5BB9\u4E4B\u540E\u611F\u89C9\u4E0E\u4F60\u7684\u8D26\u53F7\u5B9A\u4F4D\u6BD4\u8F83\u5339\u914D\uFF0C\u60F3\u4E86\u89E3\u4E00\u4E0B\u6700\u8FD1\u662F\u5426\u6709\u5546\u52A1\u5408\u4F5C\u6863\u671F\uFF1F\n\n\u65B9\u4FBF\u7684\u8BDD\u53EF\u4EE5\u52A0\u6211\u5FAE\u4FE1\uFF1A{{wechat}}"
    },
    {
      id: "product_001",
      name: "\u4EA7\u54C1\u7F6E\u6362",
      builtIn: true,
      content: "\u4F60\u597D {{nickname}}\uFF5E\n\n\u6211\u4EEC\u662F {{brand}}\uFF0C\u6700\u8FD1\u6709\u4E00\u6B3E{{product}}\u60F3\u9080\u8BF7\u4F60\u4F53\u9A8C\u3002\n\n\u5982\u679C\u4F60\u611F\u5174\u8DA3\u7684\u8BDD\uFF0C\u6211\u4EEC\u53EF\u4EE5\u63D0\u4F9B\u4EA7\u54C1\u7F6E\u6362\u5408\u4F5C\uFF0C\u671F\u5F85\u4F60\u7684\u56DE\u590D\uFF01"
    }
  ];
  function buildVars(info, settings) {
    return {
      nickname: info.nickname,
      followers: formatCount(info.followers),
      signature: info.signature,
      brand: settings.brand,
      product: settings.product,
      contact: settings.contact,
      wechat: settings.wechat,
      category: settings.category || "\u5404\u9886\u57DF"
    };
  }
  function render(content, vars) {
    return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? "");
  }
  function getTemplateById(id) {
    return BUILTIN_TEMPLATES.find((t) => t.id === id);
  }

  // src/feed/feedAutomation.ts
  var SCOPE8 = "FeedAutomation";
  var SESSION_KEY = "doa.feedSession.v1";
  var SESSION_TTL = 30 * 60 * 1e3;
  var MAX_CONSECUTIVE_FAILS = 2;
  var MAX_EMPTY_SCROLL_ROUNDS = 8;
  var FeedAutomation = class {
    constructor(deps) {
      this.deps = deps;
      this.state = "IDLE";
      this.sent = 0;
      this.consecutiveFails = 0;
      this.visited = /* @__PURE__ */ new Set();
      this.message = "\u672A\u542F\u52A8";
      const s = this.loadSession();
      if (s) {
        this.state = "RUNNING";
        this.sent = s.sent;
        this.consecutiveFails = s.fails;
        this.visited = new Set(s.visited);
        this.message = s.message;
      }
    }
    snapshot() {
      return {
        state: this.state,
        sent: this.sent,
        limit: getSettingsSync().autoBatchLimit || 10,
        visited: this.visited.size,
        message: this.message
      };
    }
    /** 手动停止：清除会话（整页跳转后也不再续跑）并立即进入终态 */
    stop() {
      if (this.state !== "RUNNING") return;
      this.clearSession();
      this.state = "STOPPED";
      this.setMessage(`\u5DF2\u624B\u52A8\u505C\u6B62\uFF08\u672C\u6B21\u53D1\u9001 ${this.sent} \u6761\uFF09`);
      logger.info(SCOPE8, `stopped by user, sent=${this.sent}`);
    }
    /** 手动启动（面板按钮）。必须在推荐页或精选落地页上启动 */
    async start() {
      if (this.state === "RUNNING") return;
      if (!getSettingsSync().autoSendEnabled) {
        this.fail("\u9700\u8981\u5148\u5728\u8BBE\u7F6E\u4E2D\u5F00\u542F\u300C\u6D88\u606F\u81EA\u52A8\u53D1\u9001\u300D\u5F00\u5173");
        return;
      }
      if (!this.isRecommendPage() && location.pathname !== "/jingxuan") {
        this.fail("\u8BF7\u5148\u56DE\u5230\u6296\u97F3\u63A8\u8350\u9875\uFF08\u9996\u9875\uFF09\u518D\u542F\u52A8");
        return;
      }
      this.state = "RUNNING";
      this.sent = 0;
      this.consecutiveFails = 0;
      this.visited.clear();
      this.setMessage("\u8FDE\u5237\u4E2D\u2026");
      this.saveSession();
      logger.info(SCOPE8, "feed automation started");
      await this.stepOnFeed();
    }
    /**
     * 整页刷新后的续跑入口（main.ts 在每次脚本启动时调用）。
     * 无有效会话则直接返回；有会话则按当前页面类型执行对应步骤。
     */
    async resume() {
      if (this.state !== "RUNNING") return;
      logger.info(SCOPE8, `resume on ${location.pathname}: sent=${this.sent}, visited=${this.visited.size}`);
      this.deps.onChange(this.snapshot());
      await sleep(2500);
      if (this.state !== "RUNNING") return;
      if (location.pathname.startsWith("/user/")) {
        await this.stepOnCreator();
      } else {
        await this.stepOnFeed();
      }
    }
    // ---------- 步骤 1：推荐 feed 页（采集 -> 跳达人页） ----------
    async stepOnFeed() {
      if (this.state !== "RUNNING") return;
      if (location.pathname === "/jingxuan") {
        this.setMessage("\u8FDB\u5165\u63A8\u8350 feed\u2026");
        const nav = this.deps.adapter.getRecommendNavLink();
        if (!nav) {
          this.fail("\u627E\u4E0D\u5230\u4FA7\u680F\u300C\u63A8\u8350\u300D\u5BFC\u822A\u5165\u53E3");
          return;
        }
        nav.removeAttribute("target");
        nav.click();
        const ok = await this.waitFor(() => this.isRecommendPage(), 8e3);
        if (!ok) {
          this.fail("\u65E0\u6CD5\u8FDB\u5165\u63A8\u8350 feed");
          return;
        }
        await sleep(2500);
      }
      if (!this.isRecommendPage()) {
        this.setMessage("\u8FD4\u56DE\u63A8\u8350\u9875\u2026");
        this.saveSession();
        this.deps.adapter.navigateTo("https://www.douyin.com/");
        return;
      }
      this.deps.adapter.dismissFeedGuide();
      await sleep(500);
      for (let round = 0; round < MAX_EMPTY_SCROLL_ROUNDS; round++) {
        if (this.state !== "RUNNING") return;
        const links = this.deps.adapter.getFeedAuthorLinks().filter((a) => !this.visited.has(a.href.split("?")[0]));
        if (links.length > 0) {
          const url = links[0].href.split("?")[0];
          this.visited.add(url);
          this.setMessage(`\u8FDB\u5165\u8FBE\u4EBA\u4E3B\u9875\uFF08\u672C\u6B21\u5DF2\u8BBF\u95EE ${this.visited.size} \u4E2A\uFF09`);
          this.saveSession();
          await sleep(300);
          this.deps.adapter.navigateTo(url);
          return;
        }
        this.setMessage(`\u672A\u53D1\u73B0\u65B0\u8FBE\u4EBA\uFF0C\u5207\u6362\u4E0B\u4E00\u6761\uFF08${round + 1}/${MAX_EMPTY_SCROLL_ROUNDS}\uFF09`);
        this.scrollFeed();
        await sleep(2500);
      }
      this.fail("\u591A\u6B21\u5207\u6362\u540E\u4ECD\u65E0\u65B0\u8FBE\u4EBA\u94FE\u63A5\uFF08\u53EF\u80FD\u672A\u767B\u5F55\u3001\u88AB\u5F39\u7A97\u906E\u6321\u6216 feed \u672A\u52A0\u8F7D\uFF09");
    }
    // ---------- 步骤 2：达人主页（解析 -> 私信 -> 回 feed） ----------
    async stepOnCreator() {
      if (this.state !== "RUNNING") return;
      const limit = getSettingsSync().autoBatchLimit || 10;
      this.setMessage("\u8FBE\u4EBA\u9875\u52A0\u8F7D\u4E2D\u2026");
      const expectedSecUid = this.deps.adapter.getCreatorSecUid();
      const ready = await this.waitFor(() => {
        if (!location.pathname.startsWith("/user/")) return false;
        if (expectedSecUid && this.deps.adapter.getCreatorSecUid() !== expectedSecUid) return false;
        const parsed = this.deps.parser.parse();
        return !!parsed && (!expectedSecUid || parsed.secUid === expectedSecUid);
      }, 15e3);
      if (!ready) {
        this.markFail("\u8FBE\u4EBA\u9875\u5185\u5BB9\u52A0\u8F7D\u8D85\u65F6\u6216\u8FBE\u4EBA\u8EAB\u4EFD\u4E0D\u5339\u914D");
        await this.backToFeedOrStop();
        return;
      }
      if (expectedSecUid && this.deps.adapter.getCreatorSecUid() !== expectedSecUid) {
        this.markFail("\u8FBE\u4EBA\u9875\u9762\u5DF2\u5207\u6362\uFF0C\u53D6\u6D88\u5F53\u524D\u64CD\u4F5C");
        return;
      }
      await sleep(4e3);
      const info = this.deps.parser.parse();
      if (!info) {
        this.markFail("\u8FBE\u4EBA\u8D44\u6599\u89E3\u6790\u5931\u8D25");
        await this.backToFeedOrStop();
        return;
      }
      const ctx = await this.deps.creatorService.syncFromPage(info);
      if (ctx.alreadyContacted) {
        this.setMessage(`\u8DF3\u8FC7\u5DF2\u8054\u7CFB\uFF1A${info.nickname}`);
        logger.info(SCOPE8, `skip already contacted: ${info.nickname}`);
        await this.backToFeedOrStop();
        return;
      }
      const messageReady = await this.waitFor(() => !!this.deps.adapter.getMessageButton(), 1e4);
      if (!messageReady) {
        this.markFail(`\u8FBE\u4EBA\u9875\u79C1\u4FE1\u5165\u53E3\u52A0\u8F7D\u8D85\u65F6\uFF1A${info.nickname}`);
        await this.backToFeedOrStop();
        return;
      }
      const done = await this.outreachOnce(ctx, info, limit);
      if (this.state !== "RUNNING") return;
      if (!done) {
        await this.backToFeedOrStop();
        return;
      }
      await this.backToFeed();
    }
    /** 单个达人的私信触达；返回 true 表示发送成功并已记录 */
    async outreachOnce(ctx, info, limit) {
      const { messageAdapter, creatorService, messageService } = this.deps;
      const opened = await messageAdapter.openMessageDialog(info.nickname, true);
      if (!opened) {
        this.markFail(`\u79C1\u4FE1\u7A97\u53E3\u6253\u4E0D\u5F00\uFF08\u53EF\u80FD\u672A\u767B\u5F55\uFF09\uFF1A${info.nickname}`);
        return false;
      }
      await sleep(400);
      const settings = getSettingsSync();
      const vars = buildVars(info, settings);
      const content = settings.customMessage.trim() ? render(settings.customMessage, vars) : render(getTemplateById(settings.defaultTemplateId)?.content || "", vars);
      logger.info(SCOPE8, `rendered message length = ${content.length}`);
      const filled = await messageAdapter.fillMessage(content);
      if (!filled) {
        messageAdapter.closeMessageDialog();
        this.markFail(`\u79C1\u4FE1\u586B\u5165\u5931\u8D25\uFF1A${info.nickname}`);
        return false;
      }
      await sleep(600);
      const sentOk = await messageAdapter.sendMessage();
      if (!sentOk) {
        this.fail(`\u81EA\u52A8\u53D1\u9001\u672A\u88AB\u5E73\u53F0\u63A5\u53D7\uFF0C\u8BF7\u5728\u5F53\u524D\u804A\u5929\u7A97\u53E3\u624B\u52A8\u70B9\u51FB\u53D1\u9001\uFF1A${info.nickname}`);
        return false;
      }
      messageAdapter.closeMessageDialog();
      let cur = ctx;
      if (!cur.existing) {
        await creatorService.saveToLibrary(info);
        cur = await creatorService.syncFromPage(info);
      }
      const msg = await messageService.recordOutreach(cur.existing.id, content, null);
      await messageService.markSent(msg.id);
      this.sent++;
      this.consecutiveFails = 0;
      this.setMessage(`\u5DF2\u53D1\u9001 ${this.sent}/${limit}\uFF1A${info.nickname}`);
      logger.info(SCOPE8, `sent ${this.sent}/${limit}: ${info.nickname}`);
      await sleep(2e3);
      return true;
    }
    // ---------- 工具 ----------
    /** 推荐 feed 页判定：SPA 进入后为 /?recommend=1（pathname 即 /） */
    isRecommendPage() {
      return location.pathname === "/" || location.pathname === "";
    }
    /** 推荐页连刷切换下一条（下箭头 + 滚轮） */
    scrollFeed() {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true })
      );
      window.dispatchEvent(new WheelEvent("wheel", { deltaY: 1200, bubbles: true }));
    }
    /** 达到上限则收官，否则整页跳回首页（302 到精选后由 resume 续跑） */
    async backToFeed() {
      if (this.state !== "RUNNING") return;
      const limit = getSettingsSync().autoBatchLimit || 10;
      if (this.sent >= limit) {
        this.finishDone();
        return;
      }
      this.setMessage("\u8FD4\u56DE\u63A8\u8350\u9875\u2026");
      this.saveSession();
      this.deps.adapter.navigateTo("https://www.douyin.com/");
    }
    /** 失败后的返回：未达连续失败上限才返回 feed，否则保持 ERROR 停留当前页 */
    async backToFeedOrStop() {
      if (this.state !== "RUNNING") return;
      await this.backToFeed();
    }
    async waitFor(predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (this.state !== "RUNNING") return false;
        if (predicate()) return true;
        await sleep(300);
      }
      return predicate();
    }
    /** 记一次失败；达到连续上限则整体停止为 ERROR */
    markFail(reason) {
      this.consecutiveFails++;
      logger.warn(SCOPE8, `fail ${this.consecutiveFails}/${MAX_CONSECUTIVE_FAILS}: ${reason}`);
      if (this.consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        this.fail(`\u8FDE\u7EED\u5931\u8D25\uFF0C\u5DF2\u505C\u6B62\uFF1A${reason}`);
        return;
      }
      this.setMessage(`\u51FA\u9519\uFF08${this.consecutiveFails}/${MAX_CONSECUTIVE_FAILS}\uFF09\uFF1A${reason}`);
      this.saveSession();
    }
    fail(message) {
      this.clearSession();
      this.state = "ERROR";
      this.setMessage(message);
      logger.error(SCOPE8, message);
    }
    finishDone() {
      const limit = getSettingsSync().autoBatchLimit || 10;
      this.clearSession();
      this.state = "DONE";
      this.setMessage(`\u8FBE\u5230\u5355\u4F1A\u8BDD\u4E0A\u9650 ${limit} \u6761\uFF0C\u672C\u6B21\u8FDE\u5237\u7ED3\u675F`);
      logger.info(SCOPE8, `feed automation done, sent=${this.sent}`);
    }
    setMessage(message) {
      this.message = message;
      this.deps.onChange(this.snapshot());
    }
    // ---------- 会话持久化（sessionStorage，同标签页有效，关标签页即销毁） ----------
    saveSession() {
      if (this.state !== "RUNNING") return;
      const s = {
        v: 1,
        sent: this.sent,
        fails: this.consecutiveFails,
        visited: Array.from(this.visited),
        message: this.message,
        startedAt: Date.now()
      };
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
      } catch (e) {
        logger.warn(SCOPE8, `saveSession failed: ${String(e)}`);
      }
    }
    loadSession() {
      try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (s.v !== 1 || typeof s.sent !== "number" || !Array.isArray(s.visited)) return null;
        if (Date.now() - s.startedAt > SESSION_TTL) {
          this.clearSession();
          return null;
        }
        return s;
      } catch {
        return null;
      }
    }
    clearSession() {
      try {
        sessionStorage.removeItem(SESSION_KEY);
      } catch {
      }
    }
  };

  // src/ai/prompt.ts
  function buildPolishMessages(draft, creator, settings) {
    const system = "\u4F60\u662F\u4E00\u4F4D\u8D44\u6DF1\u7684\u54C1\u724C\u5546\u52A1\u62D3\u5C55\u4E13\u5BB6\uFF0C\u64C5\u957F\u7ED9\u5185\u5BB9\u521B\u4F5C\u8005\u5199\u4E2A\u6027\u5316\u7684\u5408\u4F5C\u79C1\u4FE1\u3002\u4F60\u7684\u6539\u5199\u5FC5\u987B\u57FA\u4E8E\u7528\u6237\u63D0\u4F9B\u7684\u8FBE\u4EBA\u8D44\u6599\uFF0C\u7EDD\u5BF9\u4E0D\u80FD\u7F16\u9020\u8FBE\u4EBA\u6CA1\u6709\u7684\u4FE1\u606F\u3002";
    const user = `\u6839\u636E\u8FBE\u4EBA\u8D44\u6599\u6539\u5199\u4E0B\u9762\u8FD9\u6761\u5546\u52A1\u5408\u4F5C\u79C1\u4FE1\u3002

\u3010\u8FBE\u4EBA\u8D44\u6599\u3011
\u6635\u79F0\uFF1A${creator.nickname}
\u7C89\u4E1D\u6570\uFF1A${formatCount(creator.followers)}
\u7B80\u4ECB\uFF1A${creator.signature || "\uFF08\u65E0\uFF09"}
\u6807\u7B7E\uFF1A${creator.tags.join(" / ") || "\uFF08\u65E0\uFF09"}

\u3010\u54C1\u724C\u4FE1\u606F\u3011
\u54C1\u724C\uFF1A${settings.brand || "\uFF08\u672A\u586B\u5199\uFF09"}
\u4EA7\u54C1\uFF1A${settings.product || "\uFF08\u672A\u586B\u5199\uFF09"}

\u3010\u539F\u59CB\u79C1\u4FE1\u3011
${draft}

\u3010\u6539\u5199\u8981\u6C42\u3011
1. \u4E0D\u8981\u50CF\u7FA4\u53D1\u5E7F\u544A
2. \u63A7\u5236\u5728100\u5B57\u4EE5\u5185
3. ${settings.aiTone || "\u81EA\u7136\u53E3\u8BED\u5316"}
4. \u4E0D\u5938\u5F20
5. \u4E0D\u7F16\u9020\u8FBE\u4EBA\u4FE1\u606F
6. \u4FDD\u7559\u5408\u4F5C\u610F\u56FE
7. \u76F4\u63A5\u8F93\u51FA\u6539\u5199\u540E\u7684\u79C1\u4FE1\u6B63\u6587\uFF0C\u4E0D\u8981\u4EFB\u4F55\u89E3\u91CA`;
    return [
      { role: "system", content: system },
      { role: "user", content: user }
    ];
  }

  // src/ai/aiService.ts
  var SCOPE9 = "AiService";
  async function polish(draft, creator) {
    const settings = getSettingsSync();
    if (!settings.aiEnabled || !settings.aiApiKey) {
      logger.warn(SCOPE9, "AI not configured, fallback to original text");
      return { text: draft, aiUsed: false, error: "AI \u672A\u914D\u7F6E\uFF0C\u8BF7\u5148\u5728\u8BBE\u7F6E\u4E2D\u586B\u5199\u63A5\u53E3\u4E0E Key" };
    }
    try {
      const content = await callChatCompletions(settings, draft, creator);
      if (!content) throw new Error("empty response");
      return { text: content.trim(), aiUsed: true };
    } catch (e) {
      logger.error(SCOPE9, "polish failed, fallback to original", e);
      return { text: draft, aiUsed: false, error: `AI \u8C03\u7528\u5931\u8D25\uFF1A${String(e)}` };
    }
  }
  function callChatCompletions(settings, draft, creator) {
    const messages = buildPolishMessages(draft, creator, settings);
    const body = JSON.stringify({
      model: settings.aiModel,
      messages,
      temperature: 0.7,
      max_tokens: 300
    });
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: settings.aiEndpoint,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.aiApiKey}`
        },
        data: body,
        timeout: 3e4,
        onload: (resp) => {
          if (resp.status < 200 || resp.status >= 300) {
            reject(new Error(`HTTP ${resp.status}: ${resp.responseText.slice(0, 200)}`));
            return;
          }
          try {
            const json = JSON.parse(resp.responseText);
            resolve(json.choices?.[0]?.message?.content || "");
          } catch (e) {
            reject(e);
          }
        },
        onerror: (e) => reject(e),
        ontimeout: () => reject(new Error("timeout"))
      });
    });
  }

  // src/ui/floatingButton.ts
  var FloatingButton = class {
    constructor(onToggle, version) {
      this.onToggle = onToggle;
      this.version = version;
      document.getElementById("doa-fab")?.remove();
      this.el = this.render();
      document.body.appendChild(this.el);
    }
    render() {
      const el = document.createElement("div");
      el.id = "doa-fab";
      el.title = `\u6296\u97F3\u8FBE\u4EBA\u5546\u52A1\u52A9\u624B v${this.version}\uFF08\u70B9\u51FB\u5C55\u5F00/\u6536\u8D77\u9762\u677F\uFF09`;
      el.style.cssText = [
        "position:fixed",
        "right:16px",
        "top:45%",
        "z-index:9999998",
        "background:linear-gradient(135deg,#fe2c55,#ff6b9d)",
        "color:#fff",
        "padding:10px 12px",
        "border-radius:12px",
        "font-size:13px",
        "font-weight:600",
        "cursor:pointer",
        "box-shadow:0 4px 14px rgba(254,44,85,.4)",
        "user-select:none",
        "writing-mode:vertical-lr",
        "letter-spacing:2px"
      ].join(";");
      const label = document.createElement("span");
      label.textContent = "\u8FBE\u4EBA\u52A9\u624B";
      el.appendChild(label);
      const badge = document.createElement("span");
      badge.textContent = `v${this.version}`;
      badge.style.cssText = [
        "position:absolute",
        "left:-6px",
        "bottom:-6px",
        "writing-mode:horizontal-tb",
        "letter-spacing:0",
        "font-size:9px",
        "font-weight:400",
        "line-height:1.4",
        "padding:0 4px",
        "border-radius:6px",
        "background:rgba(0,0,0,.75)",
        "color:#fff",
        "pointer-events:none"
      ].join(";");
      el.appendChild(badge);
      el.addEventListener("click", () => this.onToggle());
      return el;
    }
    /** 自愈：抖音 SPA 重绘若移除外部挂载节点，重新挂回 body */
    ensureMounted() {
      if (!this.el.isConnected && document.body) {
        document.body.appendChild(this.el);
      }
    }
    setVisible(visible) {
      this.el.style.display = visible ? "block" : "none";
    }
  };

  // src/types.ts
  var CONTACT_STATUS_FLOW = [
    "NEW",
    "SAVED",
    "CONTACTED",
    "REPLIED",
    "INTERESTED",
    "NEGOTIATING",
    "COOPERATING",
    "FINISHED",
    "REJECTED"
  ];
  var CONTACT_STATUS_LABEL = {
    NEW: "\u672A\u8054\u7CFB",
    SAVED: "\u5DF2\u6536\u85CF",
    CONTACTED: "\u5DF2\u8054\u7CFB",
    REPLIED: "\u5DF2\u56DE\u590D",
    INTERESTED: "\u6709\u610F\u5411",
    NEGOTIATING: "\u6D3D\u8C08\u4E2D",
    COOPERATING: "\u5408\u4F5C\u4E2D",
    FINISHED: "\u5DF2\u5B8C\u6210",
    REJECTED: "\u5DF2\u62D2\u7EDD"
  };

  // src/ui/toast.ts
  var COLORS = {
    info: "#333",
    success: "#0a8a3a",
    warn: "#b26a00",
    error: "#c02c2c"
  };
  function showToast(message, type = "info", durationMs = 2600) {
    const el = document.createElement("div");
    el.textContent = message;
    el.style.cssText = [
      "position:fixed",
      "top:64px",
      "left:50%",
      "transform:translateX(-50%)",
      `background:${COLORS[type]}`,
      "color:#fff",
      "padding:8px 16px",
      "border-radius:8px",
      "font-size:13px",
      "z-index:9999999",
      "box-shadow:0 4px 12px rgba(0,0,0,.25)",
      "transition:opacity .3s",
      "pointer-events:none"
    ].join(";");
    document.body.appendChild(el);
    window.setTimeout(() => {
      el.style.opacity = "0";
      window.setTimeout(() => el.remove(), 350);
    }, durationMs);
  }

  // src/ui/panel.ts
  var FEED_STATE_LABEL = {
    IDLE: "\u672A\u542F\u52A8",
    RUNNING: "\u8FDE\u5237\u4E2D",
    STOPPED: "\u5DF2\u505C\u6B62",
    DONE: "\u5DF2\u5B8C\u6210",
    ERROR: "\u51FA\u9519"
  };
  var OutreachPanel = class {
    constructor() {
      this.visible = false;
      this.view = "main";
      /** 进入设置视图前的内容视图（main/feed），供「← 返回」恢复 */
      this.lastContentView = "main";
      this.ctx = null;
      this.actions = null;
      this.el = document.createElement("div");
      this.el.id = "doa-panel";
      this.el.style.cssText = [
        "position:fixed",
        "right:16px",
        "top:12%",
        "width:320px",
        "max-height:76vh",
        "overflow-y:auto",
        "z-index:9999998",
        "background:#fff",
        "border-radius:14px",
        "box-shadow:0 8px 30px rgba(0,0,0,.22)",
        "font-size:13px",
        "color:#222",
        "display:none",
        'font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif'
      ].join(";");
      document.body.appendChild(this.el);
    }
    toggle() {
      this.visible = !this.visible;
      this.el.style.display = this.visible ? "block" : "none";
      if (this.visible) {
        this.renderContent();
      }
    }
    hide() {
      this.visible = false;
      this.el.style.display = "none";
    }
    /** 自愈（BUG-20260903-03）：抖音 SPA 重绘若移除外部挂载节点，重新挂回 body */
    ensureMounted() {
      if (!this.el.isConnected && document.body) {
        document.body.appendChild(this.el);
      }
    }
    /** 更新当前达人上下文并重绘（若面板处于打开状态） */
    showForCreator(ctx, actions) {
      this.ctx = ctx;
      this.actions = actions;
      if (this.view === "feed") this.view = "main";
      if (this.visible) this.renderContent();
    }
    /** 推荐页（REQ-20260903-02）：面板进入连刷视图 */
    showFeedHome(actions) {
      this.ctx = null;
      this.actions = actions;
      if (this.view === "main") this.view = "feed";
      if (this.visible) this.renderContent();
    }
    /** 连刷状态变化时刷新（仅当正处于连刷视图） */
    refreshFeed() {
      if (this.visible && this.view === "feed") this.renderContent();
    }
    /** 非达人页：面板内容置空 */
    clear() {
      this.ctx = null;
      if (this.visible) this.renderContent();
    }
    // ---------- 渲染 ----------
    renderContent() {
      if (this.view !== "settings") this.lastContentView = this.view;
      if (this.view === "settings") {
        this.renderSettings();
        return;
      }
      if (this.view === "feed") {
        this.renderFeedHome();
        return;
      }
      if (!this.ctx) {
        this.el.innerHTML = this.wrap(`
        <div style="color:#999;text-align:center;padding:24px 0;">
          \u6253\u5F00\u4E00\u4E2A\u6296\u97F3\u8FBE\u4EBA\u4E3B\u9875\uFF08/user/*\uFF09\u540E\uFF0C<br/>\u8FD9\u91CC\u4F1A\u663E\u793A\u8FBE\u4EBA\u8D44\u6599\u4E0E\u79C1\u4FE1\u5DE5\u5177\u3002
        </div>`);
        return;
      }
      const { info, existing, alreadyContacted } = this.ctx;
      const status = existing?.status || "NEW";
      const settings = getSettingsSync();
      const dupWarning = alreadyContacted && existing ? `
      <div style="background:#fff7e6;border:1px solid #ffd591;border-radius:8px;padding:8px 10px;margin-bottom:10px;color:#ad6800;">
        \u26A0 \u8BE5\u8FBE\u4EBA\u5DF2\u7ECF\u8054\u7CFB\u8FC7<br/>
        <span style="font-size:12px;">
          \u4E0A\u6B21\u8054\u7CFB\uFF1A${existing.lastContactAt ? new Date(existing.lastContactAt).toLocaleDateString() : "\u2014"}
          \u3000\u5F53\u524D\u72B6\u6001\uFF1A${CONTACT_STATUS_LABEL[existing.status]}
        </span>
      </div>` : "";
      const templateOptions = BUILTIN_TEMPLATES.map(
        (t) => `<option value="${t.id}" ${t.id === settings.defaultTemplateId ? "selected" : ""}>${t.name}</option>`
      ).join("");
      const statusRadios = CONTACT_STATUS_FLOW.map((s) => `
      <label style="display:inline-flex;align-items:center;margin:2px 8px 2px 0;cursor:pointer;font-size:12px;">
        <input type="radio" name="doa-status" value="${s}" ${s === status ? "checked" : ""}
          ${existing ? "" : "disabled"} style="margin-right:3px;"/>
        ${CONTACT_STATUS_LABEL[s]}
      </label>`).join("");
      this.el.innerHTML = this.wrap(`
      ${dupWarning}
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        ${info.avatar ? `<img src="${info.avatar}" style="width:44px;height:44px;border-radius:50%;object-fit:cover;"/>` : ""}
        <div>
          <div style="font-weight:700;font-size:15px;" id="doa-nickname">${escapeHtml(info.nickname)}</div>
          <div style="color:#888;font-size:12px;">\u7C89\u4E1D ${formatCount(info.followers)}</div>
        </div>
      </div>
      ${info.tags.length ? `<div style="margin-bottom:8px;">${info.tags.map((t) => `<span style="background:#f0f0f5;border-radius:10px;padding:2px 8px;margin-right:4px;font-size:11px;color:#666;">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      ${info.signature ? `<div style="color:#777;font-size:12px;margin-bottom:10px;line-height:1.5;">${escapeHtml(info.signature.slice(0, 80))}</div>` : ""}

      <div style="border-top:1px solid #f0f0f0;margin:10px 0;"></div>

      <div style="margin-bottom:8px;">
        <div style="color:#999;font-size:12px;margin-bottom:4px;">\u79C1\u4FE1\u6A21\u677F</div>
        <select id="doa-template" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:8px;">
          ${templateOptions}
        </select>
      </div>
      <textarea id="doa-message" rows="6"
        style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #ddd;border-radius:8px;resize:vertical;line-height:1.5;"></textarea>
      <div style="display:flex;gap:8px;margin:8px 0;">
        <button id="doa-ai" style="${this.btnStyle("#f5f5f5", "#333")}">AI\u4F18\u5316</button>
        <button id="doa-open-msg" style="${this.btnStyle("#f5f5f5", "#333")}">\u6253\u5F00\u79C1\u4FE1</button>
        <button id="doa-fill" style="${this.btnStyle("#fe2c55", "#fff")}">\u586B\u5165\u79C1\u4FE1</button>
      </div>

      <div style="border-top:1px solid #f0f0f0;margin:10px 0;"></div>

      <div style="color:#999;font-size:12px;margin-bottom:4px;">\u72B6\u6001${existing ? "" : "\uFF08\u52A0\u5165\u8FBE\u4EBA\u5E93\u540E\u53EF\u4FEE\u6539\uFF09"}</div>
      <div style="margin-bottom:10px;">${statusRadios}</div>

      <button id="doa-save" style="${this.btnStyle(existing ? "#f0f0f5" : "#161823", existing ? "#999" : "#fff")};width:100%;">
        ${existing ? "\u2713 \u5DF2\u5728\u8FBE\u4EBA\u5E93" : "\u52A0\u5165\u8FBE\u4EBA\u5E93"}
      </button>
    `);
      this.bindEvents(info);
      this.applyTemplate();
    }
    wrap(inner) {
      const headerLeft = this.view === "settings" ? '<span id="doa-back" style="cursor:pointer;color:#666;font-size:13px;">\u2190 \u8FD4\u56DE</span>' : '<span id="doa-settings" style="cursor:pointer;color:#999;font-size:14px;" title="\u8BBE\u7F6E">\u2699</span>';
      return `
      <div style="padding:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          ${headerLeft}
          <span style="font-weight:700;">\u8FBE\u4EBA\u5546\u52A1\u52A9\u624B</span>
          <span id="doa-close" style="cursor:pointer;color:#bbb;font-size:16px;line-height:1;">\u2715</span>
        </div>
        ${inner}
      </div>`;
    }
    btnStyle(bg, color) {
      return `flex:1;background:${bg};color:${color};border:none;border-radius:8px;padding:7px 0;cursor:pointer;font-size:13px;`;
    }
    // ---------- 事件 ----------
    /** 头部按钮（关闭/设置/返回）在所有视图通用 */
    bindHeaderEvents() {
      this.el.querySelector("#doa-close")?.addEventListener("click", () => this.hide());
      this.el.querySelector("#doa-settings")?.addEventListener("click", () => {
        this.view = "settings";
        this.renderContent();
      });
      this.el.querySelector("#doa-back")?.addEventListener("click", () => {
        this.view = this.lastContentView;
        this.renderContent();
      });
    }
    bindEvents(info) {
      const $ = (id) => this.el.querySelector(`#${id}`);
      this.bindHeaderEvents();
      $("doa-template")?.addEventListener("change", () => this.applyTemplate());
      $("doa-save")?.addEventListener("click", async () => {
        if (!this.actions || this.ctx?.existing) return;
        await this.actions.onSaveToLibrary();
      });
      this.el.querySelectorAll('input[name="doa-status"]').forEach((radio) => {
        radio.addEventListener("change", async () => {
          if (this.actions && radio.checked) {
            await this.actions.onStatusChange(radio.value);
          }
        });
      });
      $("doa-open-msg")?.addEventListener("click", async () => {
        await this.actions?.onOpenMessage();
      });
      $("doa-fill")?.addEventListener("click", async () => {
        const text = $("doa-message")?.value.trim();
        if (!text) {
          showToast("\u79C1\u4FE1\u5185\u5BB9\u4E3A\u7A7A", "warn");
          return;
        }
        const templateId = $("doa-template")?.value || null;
        await this.actions?.onFillMessage(text, templateId);
      });
      $("doa-ai")?.addEventListener("click", async () => {
        const textarea = $("doa-message");
        const text = textarea?.value.trim();
        if (!text || !this.actions) {
          showToast("\u8BF7\u5148\u9009\u62E9\u6A21\u677F\u751F\u6210\u5185\u5BB9", "warn");
          return;
        }
        const btn = $("doa-ai");
        btn.disabled = true;
        btn.textContent = "AI\u751F\u6210\u4E2D\u2026";
        try {
          const polished = await this.actions.onAiPolish(text);
          if (textarea) textarea.value = polished;
        } finally {
          btn.disabled = false;
          btn.textContent = "AI\u4F18\u5316";
        }
      });
    }
    /** 根据当前选中的模板渲染变量并填入文本框 */
    applyTemplate() {
      if (!this.ctx) return;
      const select = this.el.querySelector("#doa-template");
      const textarea = this.el.querySelector("#doa-message");
      const tpl = BUILTIN_TEMPLATES.find((t) => t.id === select?.value);
      if (!tpl || !textarea) return;
      textarea.value = render(tpl.content, buildVars(this.ctx.info, getSettingsSync()));
    }
    // ---------- 推荐页连刷视图（REQ-20260903-02） ----------
    renderFeedHome() {
      const snap = this.actions?.getFeedAutoSnapshot();
      const state = snap?.state ?? "IDLE";
      const running = state === "RUNNING";
      const settings = getSettingsSync();
      const stateColor = {
        IDLE: "#666",
        RUNNING: "#237804",
        STOPPED: "#ad6800",
        DONE: "#237804",
        ERROR: "#cf1322"
      };
      this.el.innerHTML = this.wrap(`
      <div style="background:#f6ffed;border:1px solid #b7eb8f;border-radius:8px;padding:10px;margin-bottom:10px;">
        <div style="font-size:12px;color:#666;margin-bottom:6px;">\u63A8\u8350\u9875\u8FDE\u5237\u81EA\u52A8\u5316</div>
        <div style="margin-bottom:6px;">
          \u72B6\u6001\uFF1A<b style="color:${stateColor[state]};">${FEED_STATE_LABEL[state]}</b>
          \u3000\u5DF2\u53D1\u9001\uFF1A<b>${snap?.sent ?? 0}/${snap?.limit ?? settings.autoBatchLimit}</b>
          \u3000\u5DF2\u8BBF\u95EE\uFF1A${snap?.visited ?? 0}
        </div>
        <div style="font-size:12px;color:#555;line-height:1.5;word-break:break-all;">
          ${escapeHtml(snap?.message ?? "\u672A\u542F\u52A8")}
        </div>
      </div>

      <div style="font-size:12px;color:#999;line-height:1.6;margin-bottom:10px;">
        \u6D41\u7A0B\uFF1A\u91C7\u96C6\u63A8\u8350\u9875\u8FBE\u4EBA -> \u8FDB\u5165\u4E3B\u9875 -> \u8DF3\u8FC7\u5DF2\u8054\u7CFB -> \u586B\u5165\u81EA\u5B9A\u4E49\u79C1\u4FE1 -> \u81EA\u52A8\u53D1\u9001 -> \u8FD4\u56DE\u7EE7\u7EED\u3002<br/>
        ${settings.autoSendEnabled ? settings.customMessage.trim() ? "\u6587\u6848\uFF1A\u4F7F\u7528\u8BBE\u7F6E\u4E2D\u7684\u81EA\u5B9A\u4E49\u79C1\u4FE1\u5185\u5BB9" : "\u6587\u6848\uFF1A\u81EA\u5B9A\u4E49\u5185\u5BB9\u4E3A\u7A7A\uFF0C\u5C06\u4F7F\u7528\u9ED8\u8BA4\u6A21\u677F" : '<b style="color:#cf1322;">\u9700\u5148\u5728 \u2699 \u8BBE\u7F6E\u4E2D\u5F00\u542F\u300C\u6D88\u606F\u81EA\u52A8\u53D1\u9001\u300D\u624D\u80FD\u542F\u52A8</b>'}
      </div>

      <button id="doa-feed-toggle" style="${this.btnStyle(running ? "#f0f0f5" : "#fe2c55", running ? "#333" : "#fff")};width:100%;">
        ${running ? "\u25A0 \u505C\u6B62\u8FDE\u5237" : "\u25B6 \u5F00\u59CB\u8FDE\u5237"}
      </button>
    `);
      this.bindHeaderEvents();
      this.el.querySelector("#doa-feed-toggle")?.addEventListener("click", async () => {
        if (!this.actions) return;
        if (this.actions.getFeedAutoSnapshot().state === "RUNNING") {
          this.actions.onStopFeedAuto();
        } else {
          await this.actions.onStartFeedAuto();
        }
      });
    }
    // ---------- 设置视图（REQ-20260902-02 + REQ-20260903-01 自动发送开关） ----------
    settingsInputStyle() {
      return "width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ddd;border-radius:8px;margin-bottom:8px;font-size:12px;";
    }
    sectionTitle(text, first = false) {
      return `<div style="color:#999;font-size:12px;margin:${first ? "0" : "12px"} 0 6px;">${text}</div>`;
    }
    renderSettings() {
      const s = getSettingsSync();
      const tplOptions = BUILTIN_TEMPLATES.map(
        (t) => `<option value="${t.id}" ${t.id === s.defaultTemplateId ? "selected" : ""}>${t.name}</option>`
      ).join("");
      this.el.innerHTML = this.wrap(`
      ${this.sectionTitle("\u54C1\u724C\u4FE1\u606F", true)}
      <input id="doa-set-brand" placeholder="\u54C1\u724C\u540D\u79F0" value="${escapeHtml(s.brand)}" style="${this.settingsInputStyle()}"/>
      <textarea id="doa-set-brandIntro" placeholder="\u54C1\u724C\u7B80\u4ECB" rows="2" style="${this.settingsInputStyle()}">${escapeHtml(s.brandIntro)}</textarea>
      <input id="doa-set-product" placeholder="\u4EA7\u54C1\u540D\u79F0" value="${escapeHtml(s.product)}" style="${this.settingsInputStyle()}"/>
      <input id="doa-set-contact" placeholder="\u9ED8\u8BA4\u8054\u7CFB\u4EBA" value="${escapeHtml(s.contact)}" style="${this.settingsInputStyle()}"/>
      <input id="doa-set-wechat" placeholder="\u5FAE\u4FE1\u53F7" value="${escapeHtml(s.wechat)}" style="${this.settingsInputStyle()}"/>
      <input id="doa-set-category" placeholder="\u9ED8\u8BA4\u8FBE\u4EBA\u7C7B\u578B" value="${escapeHtml(s.category)}" style="${this.settingsInputStyle()}"/>

      ${this.sectionTitle("\u9ED8\u8BA4\u6A21\u677F")}
      <select id="doa-set-template" style="${this.settingsInputStyle()}">${tplOptions}</select>

      ${this.sectionTitle("AI \u6DA6\u8272")}
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;cursor:pointer;">
        <input type="checkbox" id="doa-set-ai" ${s.aiEnabled ? "checked" : ""}/> \u542F\u7528 AI \u6DA6\u8272\uFF08\u672A\u914D\u7F6E Key \u65F6\u81EA\u52A8\u964D\u7EA7\u4E3A\u539F\u6587\uFF09
      </label>
      <input id="doa-set-aiEndpoint" placeholder="\u63A5\u53E3\u5730\u5740\uFF08OpenAI \u517C\u5BB9\uFF09" value="${escapeHtml(s.aiEndpoint)}" style="${this.settingsInputStyle()}"/>
      <input id="doa-set-aiApiKey" type="password" placeholder="API Key\uFF08\u4EC5\u5B58\u672C\u5730\u6D4F\u89C8\u5668\uFF09" value="${escapeHtml(s.aiApiKey)}" style="${this.settingsInputStyle()}"/>
      <input id="doa-set-aiModel" placeholder="\u6A21\u578B" value="${escapeHtml(s.aiModel)}" style="${this.settingsInputStyle()}"/>
      <input id="doa-set-aiTone" placeholder="\u8BED\u6C14" value="${escapeHtml(s.aiTone)}" style="${this.settingsInputStyle()}"/>

      ${this.sectionTitle("\u6D88\u606F\u81EA\u52A8\u53D1\u9001")}
      <label style="display:flex;align-items:flex-start;gap:6px;margin-bottom:8px;font-size:12px;cursor:pointer;line-height:1.5;">
        <input type="checkbox" id="doa-set-autoSend" ${s.autoSendEnabled ? "checked" : ""} style="margin-top:2px;"/>
        <span>\u586B\u5165\u79C1\u4FE1\u540E\u81EA\u52A8\u70B9\u51FB\u4E00\u6B21\u53D1\u9001\uFF08\u5168\u5C40\u751F\u6548\uFF0C\u6539\u52A8\u5373\u65F6\u4FDD\u5B58\uFF09<br/>
        <span style="color:#ad6800;">\u8FDE\u5237\u81EA\u52A8\u5316\u4F9D\u8D56\u6B64\u5F00\u5173</span></span>
      </label>

      ${this.sectionTitle("\u8FDE\u5237\u81EA\u52A8\u5316")}
      <textarea id="doa-set-customMessage" placeholder="\u81EA\u5B9A\u4E49\u79C1\u4FE1\u5185\u5BB9\uFF08\u652F\u6301 {{nickname}} {{brand}} {{wechat}} \u7B49\u53D8\u91CF\uFF1B\u7559\u7A7A\u5219\u4F7F\u7528\u9ED8\u8BA4\u6A21\u677F\uFF09" rows="4" style="${this.settingsInputStyle()}">${escapeHtml(s.customMessage)}</textarea>
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;">
        \u5355\u4F1A\u8BDD\u53D1\u9001\u4E0A\u9650
        <input id="doa-set-batchLimit" type="number" min="1" max="100" value="${s.autoBatchLimit}" style="width:64px;padding:4px;border:1px solid #ddd;border-radius:6px;"/>
        \u6761
      </label>

      <button id="doa-set-save" style="${this.btnStyle("#fe2c55", "#fff")};width:100%;margin-top:8px;">\u4FDD\u5B58\u8BBE\u7F6E</button>
    `);
      this.bindHeaderEvents();
      const $ = (id) => this.el.querySelector(`#${id}`);
      $("doa-set-autoSend")?.addEventListener("change", async (e) => {
        const checked = e.target.checked;
        await this.actions?.onSaveSettings({ autoSendEnabled: checked });
      });
      $("doa-set-save")?.addEventListener("click", async () => {
        if (!this.actions) return;
        await this.actions.onSaveSettings({
          brand: $("doa-set-brand")?.value.trim() ?? "",
          brandIntro: $("doa-set-brandIntro")?.value.trim() ?? "",
          product: $("doa-set-product")?.value.trim() ?? "",
          contact: $("doa-set-contact")?.value.trim() ?? "",
          wechat: $("doa-set-wechat")?.value.trim() ?? "",
          category: $("doa-set-category")?.value.trim() ?? "",
          defaultTemplateId: $("doa-set-template")?.value ?? "business_001",
          aiEnabled: $("doa-set-ai")?.checked ?? false,
          aiEndpoint: $("doa-set-aiEndpoint")?.value.trim() ?? "",
          aiApiKey: $("doa-set-aiApiKey")?.value.trim() ?? "",
          aiModel: $("doa-set-aiModel")?.value.trim() ?? "",
          aiTone: $("doa-set-aiTone")?.value.trim() ?? "",
          customMessage: $("doa-set-customMessage")?.value ?? "",
          autoBatchLimit: Math.max(1, Number($("doa-set-batchLimit")?.value) || 10)
        });
      });
    }
  };
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[c]);
  }

  // src/main.ts
  var SCOPE10 = "Main";
  var VERSION = "0.5.3";
  logger.info(SCOPE10, `userscript alive v${VERSION}, href=${location.href}`);
  function showFatalBanner(msg) {
    if (!document.body || document.getElementById("doa-fatal-banner")) return;
    const banner = document.createElement("div");
    banner.id = "doa-fatal-banner";
    banner.style.cssText = [
      "position:fixed",
      "left:16px",
      "bottom:16px",
      "z-index:9999999",
      "background:#fff1f0",
      "border:1px solid #ffa39e",
      "color:#cf1322",
      "padding:10px 14px",
      "border-radius:10px",
      "font-size:12px",
      "max-width:340px",
      'font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif'
    ].join(";");
    banner.textContent = `\u8FBE\u4EBA\u52A9\u624B\u521D\u59CB\u5316\u5931\u8D25\uFF08v${VERSION}\uFF09\uFF1A${msg} \u2014\u2014 \u8BF7\u622A\u56FE\u53CD\u9988`;
    document.body.appendChild(banner);
  }
  window.addEventListener("error", (e) => {
    logger.error(SCOPE10, `window error: ${e.message}`);
    if (!document.getElementById("doa-fab")) showFatalBanner(e.message || "unknown error");
  });
  window.addEventListener("unhandledrejection", (e) => {
    logger.error(SCOPE10, `unhandled rejection: ${String(e.reason)}`);
    if (!document.getElementById("doa-fab")) showFatalBanner(String(e.reason));
  });
  function ensureBody(timeoutMs = 5e3) {
    if (document.body) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok) => {
        clearTimeout(timer);
        obs.disconnect();
        resolve(ok);
      };
      const timer = setTimeout(() => done(!!document.body), timeoutMs);
      const obs = new MutationObserver(() => {
        if (document.body) done(true);
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      document.addEventListener("DOMContentLoaded", () => done(!!document.body), { once: true });
    });
  }
  async function bootstrap() {
    if (!await ensureBody()) {
      logger.error(SCOPE10, "document.body not ready after 5s, abort bootstrap");
      return;
    }
    const panel = new OutreachPanel();
    const fab = new FloatingButton(() => panel.toggle(), VERSION);
    fab.setVisible(true);
    setInterval(() => {
      fab.ensureMounted();
      panel.ensureMounted();
    }, 2e3);
    try {
      await openDB();
      await loadSettings();
      const adapter = new DouyinAdapter();
      const parser = new CreatorParser(adapter);
      const messageAdapter = new MessageAdapter(adapter);
      const repo = new CreatorRepository();
      const creatorService = new CreatorService(repo);
      const messageService = new MessageService(repo);
      const feedAuto = new FeedAutomation({
        adapter,
        messageAdapter,
        parser,
        creatorService,
        messageService,
        onChange: (snap) => {
          panel.refreshFeed();
          if (snap.state === "DONE" || snap.state === "STOPPED" || snap.state === "ERROR") {
            showToast(snap.message, snap.state === "ERROR" ? "warn" : "success", 4e3);
          }
        }
      });
      let currentCtx = null;
      const actions = {
        onSaveToLibrary: async () => {
          if (!currentCtx) return;
          const { isNew } = await creatorService.saveToLibrary(currentCtx.info);
          showToast(isNew ? "\u5DF2\u52A0\u5165\u8FBE\u4EBA\u5E93" : "\u8FBE\u4EBA\u5E93\u4FE1\u606F\u5DF2\u66F4\u65B0", "success");
          currentCtx = await creatorService.syncFromPage(currentCtx.info);
          panel.showForCreator(currentCtx, actions);
        },
        onStatusChange: async (status) => {
          if (!currentCtx?.existing) return;
          await creatorService.markStatus(currentCtx.existing.id, status);
          showToast(`\u72B6\u6001\u5DF2\u66F4\u65B0\u4E3A\uFF1A${status}`, "success");
          currentCtx = await creatorService.syncFromPage(currentCtx.info);
          panel.showForCreator(currentCtx, actions);
        },
        onOpenMessage: async () => {
          const ok = await messageAdapter.openMessageDialog(currentCtx?.info.nickname);
          showToast(ok ? "\u79C1\u4FE1\u7A97\u53E3\u5DF2\u6253\u5F00" : "\u672A\u627E\u5230\u79C1\u4FE1\u5165\u53E3\uFF0C\u53EF\u80FD\u672A\u767B\u5F55\u6216\u9875\u9762\u672A\u52A0\u8F7D\u5B8C\u6210", ok ? "success" : "error");
        },
        onFillMessage: async (text, templateId) => {
          if (!currentCtx) return;
          if (!currentCtx.existing) {
            await creatorService.saveToLibrary(currentCtx.info);
            currentCtx = await creatorService.syncFromPage(currentCtx.info);
          }
          const opened = await messageAdapter.openMessageDialog(currentCtx.info.nickname);
          if (!opened) {
            showToast("\u6253\u5F00\u79C1\u4FE1\u5931\u8D25\uFF0C\u8BF7\u786E\u8BA4\u5DF2\u767B\u5F55", "error");
            return;
          }
          await sleep(300);
          const filled = await messageAdapter.fillMessage(text);
          if (!filled) {
            showToast("\u672A\u627E\u5230\u79C1\u4FE1\u8F93\u5165\u6846", "error");
            return;
          }
          await messageService.recordOutreach(currentCtx.existing.id, text, templateId).then(async (msg) => {
            if (getSettingsSync().autoSendEnabled) {
              const sent = await messageAdapter.sendMessage();
              if (sent) {
                await messageService.markSent(msg.id);
                showToast("\u5DF2\u81EA\u52A8\u53D1\u9001\u79C1\u4FE1", "success");
              } else {
                showToast("\u81EA\u52A8\u53D1\u9001\u672A\u88AB\u5E73\u53F0\u63A5\u53D7\uFF1A\u8BF7\u5728\u5F53\u524D IM \u7A97\u53E3\u624B\u52A8\u70B9\u51FB\u53D1\u9001", "warn", 4500);
              }
            } else {
              showToast("\u5DF2\u586B\u5165\u79C1\u4FE1\uFF0C\u8BF7\u4EBA\u5DE5\u786E\u8BA4\u540E\u53D1\u9001", "success");
            }
          });
          currentCtx = await creatorService.syncFromPage(currentCtx.info);
          panel.showForCreator(currentCtx, actions);
        },
        onAiPolish: async (text) => {
          if (!currentCtx) return text;
          const result = await polish(text, currentCtx.info);
          if (result.aiUsed) {
            showToast("AI \u4F18\u5316\u5B8C\u6210", "success");
          } else if (result.error) {
            showToast(result.error, "warn", 3500);
          }
          return result.text;
        },
        onSaveSettings: async (patch) => {
          await saveSettings(patch);
          showToast("\u8BBE\u7F6E\u5DF2\u4FDD\u5B58", "success");
          if (currentCtx) panel.showForCreator(currentCtx, actions);
        },
        // REQ-20260903-02：连刷自动化控制
        onStartFeedAuto: async () => {
          await feedAuto.start();
        },
        onStopFeedAuto: () => feedAuto.stop(),
        getFeedAutoSnapshot: () => feedAuto.snapshot()
      };
      const router = new Router();
      router.on("CREATOR", async () => {
        await sleep(1200);
        let info = parser.parse();
        if (!info) {
          await sleep(1500);
          info = parser.parse();
        }
        if (!info) {
          logger.warn(SCOPE10, "creator parse failed on CREATOR page");
          panel.clear();
          return;
        }
        currentCtx = await creatorService.syncFromPage(info);
        panel.showForCreator(currentCtx, actions);
        if (currentCtx.alreadyContacted) {
          showToast(`\u26A0 ${info.nickname} \u4E4B\u524D\u5DF2\u8054\u7CFB\u8FC7`, "warn", 3500);
        }
      });
      router.on("HOME", () => panel.showFeedHome(actions));
      router.on("SEARCH", () => panel.clear());
      router.on("VIDEO", () => panel.clear());
      router.on("MESSAGE", () => panel.clear());
      router.on("UNKNOWN", () => panel.clear());
      const observer = new PageObserver();
      observer.start();
      feedAuto.resume().catch((e) => {
        logger.error(SCOPE10, `feed automation resume failed: ${String(e)}`);
      });
      logger.info(SCOPE10, `Douyin Outreach Assistant started (v${VERSION})`);
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error(SCOPE10, `bootstrap failed: ${msg}`, e);
      showFatalBanner(msg);
    }
  }
  bootstrap().catch((e) => {
    logger.error(SCOPE10, `bootstrap failed: ${String(e)}`, e);
    showFatalBanner(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  });
})();
