/**
 * AiService（文档第 10/11 章）：模板润色。
 * MVP 阶段直连 OpenAI 兼容接口（通过 GM_xmlhttpRequest 跨域）；
 * 正式阶段必须迁移到 AI Gateway（FastAPI），Key 不放在插件里。
 * 未配置或调用失败时静默降级为原文。
 */
import { buildPolishMessages } from './prompt';
import { getSettingsSync } from '../storage/settings';
import type { AppSettings, CreatorInfo } from '../types';
import { logger } from '../utils/logger';
import { getAiRequestOptions } from './providerPresets';

const SCOPE = 'AiService';

export interface PolishResult {
  text: string;
  aiUsed: boolean;
  error?: string;
}

/** 检查 AI 是否可用（已开启且配置了 Key） */
export function isAiAvailable(): boolean {
  const s = getSettingsSync();
  return s.aiEnabled && !!s.aiApiKey;
}

export async function polish(draft: string, creator: CreatorInfo): Promise<PolishResult> {
  const settings = getSettingsSync();
  if (!settings.aiEnabled || !settings.aiApiKey) {
    logger.warn(SCOPE, 'AI not configured, fallback to original text');
    return { text: draft, aiUsed: false, error: 'AI 未配置，请先在设置中填写接口与 Key' };
  }

  try {
    const content = await callChatCompletions(settings, draft, creator);
    if (!content) throw new Error('empty response');
    return { text: content.trim(), aiUsed: true };
  } catch (e) {
    logger.error(SCOPE, 'polish failed, fallback to original', e);
    return { text: draft, aiUsed: false, error: `AI 调用失败：${String(e)}` };
  }
}

/** 通过 GM_xmlhttpRequest 调用 OpenAI 兼容 chat/completions 接口 */
function callChatCompletions(
  settings: AppSettings,
  draft: string,
  creator: CreatorInfo,
): Promise<string> {
  const messages = buildPolishMessages(draft, creator, settings);
  const body = JSON.stringify({
    model: settings.aiModel,
    messages,
    temperature: 0.7,
    max_tokens: 300,
    ...getAiRequestOptions(settings.aiEndpoint, settings.aiModel),
  });

  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'POST',
      url: settings.aiEndpoint,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.aiApiKey}`,
      },
      data: body,
      timeout: 30000,
      onload: (resp) => {
        if (resp.status < 200 || resp.status >= 300) {
          reject(new Error(`HTTP ${resp.status}: ${resp.responseText.slice(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(resp.responseText) as {
            choices?: { message?: { content?: string } }[];
          };
          resolve(json.choices?.[0]?.message?.content || '');
        } catch (e) {
          reject(e);
        }
      },
      onerror: (e) => reject(e),
      ontimeout: () => reject(new Error('timeout')),
    });
  });
}
