/**
 * Selectors 配置中心（文档第 23 章）。
 * 抖音最大的维护风险是 DOM 结构变化，所有选择器必须集中在此文件。
 * 每项为候选数组，按优先级依次尝试，便于抖音小版本更新时快速降级命中。
 * 抖音改版时只需修改本文件。
 *
 * 校准记录（BUG-20260902-01，2026-09-02 真实页面探测）：
 * - 达人页真实 data-e2e：user-detail / user-info / user-info-follow(关注) /
 *   user-info-fans(粉丝) / user-info-like(获赞) / user-info-follow-btn
 * - 昵称是页面唯一 h1；简介是 user-info 内 <p>(抖音号) 后面的兄弟 div
 * - 私信按钮是 semix 组件库的 button，无 data-e2e，按文本"私信"兜底匹配
 */
export const selectors = {
  /** 主页资料容器；性别识别限定在此区域，避免读取评论或推荐内容。 */
  creatorProfile: [
    '[data-e2e="user-info"]',
    '[data-e2e="user-detail"]',
  ],
  /** 仅匹配带明确性别语义的徽标。 */
  genderBadge: [
    '[data-e2e="user-info"] > p > span',
    '[data-e2e*="gender"]',
    '[aria-label*="性别"]',
    '[title*="性别"]',
    'img[alt="男"], img[alt="女"], img[alt="男性"], img[alt="女性"]',
    'svg[class*="gender"], i[class*="gender"]',
  ],
  /** 登录态公开主页实测：作品在 user-post-list 的 li > a 中，标题在 p，封面在 img。 */
  userPostList: [
    '[data-e2e="user-post-list"]',
  ],
  userPostLinks: [
    'li a[href*="/video/"], li a[href*="/note/"]',
  ],
  userPostCaption: [
    'p',
  ],
  userPostCover: [
    'img',
  ],
  /** 达人主页 - 昵称（页面唯一 h1，实测文本即昵称） */
  creatorName: [
    '[data-e2e="user-detail"] h1',
    '[data-e2e="user-info"] h1',
    'h1',
  ],
  /** 达人主页 - 粉丝数（容器文本形如 "粉丝113.2万"，取数字部分由 parseChineseCount 处理） */
  followerCount: [
    '[data-e2e="user-info-fans"]',
  ],
  /** 达人主页 - 关注数 */
  followingCount: [
    '[data-e2e="user-info-follow"]',
  ],
  /** 达人主页 - 获赞数 */
  likesCount: [
    '[data-e2e="user-info-like"]',
  ],
  /** 达人主页 - 简介/签名（user-info 内 <p>抖音号</p> 之后的兄弟 div，实测有效） */
  signature: [
    '[data-e2e="user-info"] p + div',
    '[data-e2e="user-detail"] p + div',
  ],
  /** 达人主页 - 头像 */
  avatar: [
    '[data-e2e="user-detail"] img[class*="avatar"]',
    '[class*="avatar"] img',
    '[data-e2e="user-info"] img',
  ],
  /**
   * 达人主页 - 私信按钮。
   * 实测为 <button class="semi-button semi-button-secondary j85duc">私信</button>，无 data-e2e。
   * 注意：semi-button-secondary 同时被"分享主页"等按钮使用，不能作为候选，
   * 统一由 adapter 按按钮文本"私信"兜底匹配；hashed class 仅作快速路径。
   */
  messageButton: [
    'button[class*="j85duc"]',
  ],
  /**
   * 私信对话框容器（登录态实测命中，BUG-20260902-01）。
   * 注意：点"私信"后可能先落在会话列表层（StackLayout list），聊天层异步加载，
   * 输入框需要等待出现（messageAdapter 已按 12s 等待处理）。
   */
  messageDialog: [
    '[data-e2e="im-dialog"]',
    '[class*="message-box"]',
    '[class*="chat-box"]',
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
    'textarea[class*="input"]',
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
    '[data-e2e="im-dialog"] [class*="publishBtn"]',
  ],
  /**
   * 推荐页 feed - 达人主页链接（REQ-20260903-02）。
   * 采集方式来自 probe-feed.mjs 实测：feed 页存在 a[href*="/user/"] 锚点（作者头像/昵称）。
   * 由 DouyinAdapter.getFeedAuthorLinks 统一过滤（排除 /user/self）。
   * 注意（BUG-20260903-02）：只有推荐 feed（/，SPA 进入）才有真实作者链接；
   * 精选落地页 /jingxuan 上只有 /user/self。
   */
  feedAuthorLinks: [
    'a[href*="/user/"]',
  ],
  /**
   * 侧栏「推荐」导航链接（BUG-20260903-02 实测）：
   * 打开 https://www.douyin.com/ 会 302 到 /jingxuan（精选），
   * 推荐 feed 只能通过该锚点 SPA 进入（/?recommend=1，实测无刷新、脚本状态保留）。
   */
  recommendNavLink: [
    'a[href*="recommend=1"]',
  ],
  /**
   * 推荐 feed - 下一条视频按钮（V0.5.4 真实页面取证）。
   * 合成 ArrowDown/WheelEvent 不会触发切换；该 data-e2e 控件用完整 pointer/mouse
   * 激活序列可稳定让下一条进入可视区并加载新作者。
   */
  feedNextButton: [
    '[data-e2e="video-switch-next-arrow"]',
    '.xgplayer-playswitch-next',
  ],
} as const;

export type SelectorKey = keyof typeof selectors;
