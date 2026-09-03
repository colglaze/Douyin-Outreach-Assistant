/**
 * AI Prompt 构造（文档第 10 章）。
 * 要求：不像群发广告 / 100字以内 / 自然口语化 / 不夸张 / 不编造达人信息 / 保留合作意图。
 */
import type { AppSettings, CreatorInfo } from '../types';
import { formatCount } from '../utils/number';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export function buildPolishMessages(
  draft: string,
  creator: CreatorInfo,
  settings: AppSettings,
): ChatMessage[] {
  const system =
    '你是一位资深的品牌商务拓展专家，擅长给内容创作者写个性化的合作私信。' +
    '你的改写必须基于用户提供的达人资料，绝对不能编造达人没有的信息。';

  const user = `根据达人资料改写下面这条商务合作私信。

【达人资料】
昵称：${creator.nickname}
粉丝数：${formatCount(creator.followers)}
简介：${creator.signature || '（无）'}
标签：${creator.tags.join(' / ') || '（无）'}

【品牌信息】
品牌：${settings.brand || '（未填写）'}
产品：${settings.product || '（未填写）'}

【原始私信】
${draft}

【改写要求】
1. 不要像群发广告
2. 控制在100字以内
3. ${settings.aiTone || '自然口语化'}
4. 不夸张
5. 不编造达人信息
6. 保留合作意图
7. 直接输出改写后的私信正文，不要任何解释`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
