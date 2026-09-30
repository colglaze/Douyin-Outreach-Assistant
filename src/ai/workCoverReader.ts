import type { AppSettings, WorkCoverText, WorkSample } from '../types';
import { getSettingsSync } from '../storage/settings';
import { logger } from '../utils/logger';
import { getAiRequestOptions, isKnownTextOnlyModel } from './providerPresets';

const SCOPE = 'WorkCoverReader';

export interface CoverReadResult {
  texts: WorkCoverText[];
  coversChecked: number;
  warning?: string;
}

/** 仅提取封面上可见的第一人称自述文字，不用人物外貌推断性别。 */
export async function readCoverTexts(works: WorkSample[]): Promise<CoverReadResult> {
  const settings = getSettingsSync();
  const covers = works.map((work, workIndex) => ({ workIndex, url: work.coverUrl }))
    .filter(({ url }) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && (parsed.hostname === 'douyinpic.com' || parsed.hostname.endsWith('.douyinpic.com'));
      } catch { return false; }
    }).slice(0, 3);
  if (!covers.length) return { texts: [], coversChecked: 0, warning: '当前作品没有可分析的封面。' };
  if (!settings.aiEnabled || !settings.aiApiKey) {
    return { texts: [], coversChecked: 0, warning: 'AI 未启用或未配置 Key，未分析封面画面。' };
  }
  if (isKnownTextOnlyModel(settings.aiEndpoint, settings.aiModel)) {
    return { texts: [], coversChecked: 0, warning: '当前 LongCat-2.0 配置仅支持文字请求；封面未送往 AI。作品文案和粘贴台词仍会分析。' };
  }

  try {
    const content = await requestVisibleText(settings, covers);
    const payload = content.match(/\{[\s\S]*\}/)?.[0] || '';
    const parsed = JSON.parse(payload) as { visibleText?: unknown };
    const texts = Array.isArray(parsed.visibleText) ? parsed.visibleText.flatMap((item): WorkCoverText[] => {
      if (!item || typeof item !== 'object') return [];
      const row = item as { workIndex?: unknown; text?: unknown };
      if (!Number.isInteger(row.workIndex) || !covers.some((cover) => cover.workIndex === row.workIndex) || typeof row.text !== 'string') return [];
      return [{ workIndex: row.workIndex as number, text: row.text.slice(0, 200) }];
    }).slice(0, 6) : [];
    return { texts, coversChecked: covers.length };
  } catch (error) {
    logger.warn(SCOPE, `cover read failed: ${String(error)}`);
    return { texts: [], coversChecked: 0, warning: '封面分析失败；已继续使用作品文案和提供的台词。' };
  }
}

function requestVisibleText(settings: AppSettings, covers: { workIndex: number; url: string }[]): Promise<string> {
  const content = [
    { type: 'text', text: '逐张读取封面里可见的文字。只返回明确属于作者第一人称的性别自述原文，例如“我是女生”；不要根据人物外貌、服装、发型或名字推断性别。没有这样的字句就返回空数组。严格输出 JSON：{"visibleText":[{"workIndex":0,"text":"原文"}]}。workIndex 按图片前文字标签给出。' },
    ...covers.flatMap(({ workIndex, url }) => [
      { type: 'text', text: `作品 ${workIndex} 的封面：` },
      { type: 'image_url', image_url: { url, detail: 'low' } },
    ]),
  ];
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'POST',
      url: settings.aiEndpoint,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.aiApiKey}` },
      data: JSON.stringify({ model: settings.aiModel, messages: [
        { role: 'system', content: '你是图像中文字提取器。看不到就留空，不推断个人属性。' },
        { role: 'user', content },
      ], temperature: 0, max_tokens: 250, ...getAiRequestOptions(settings.aiEndpoint, settings.aiModel) }),
      timeout: 30000,
      onload: (resp) => {
        if (resp.status < 200 || resp.status >= 300) { reject(new Error(`HTTP ${resp.status}`)); return; }
        try {
          const json = JSON.parse(resp.responseText) as { choices?: { message?: { content?: string } }[] };
          resolve(json.choices?.[0]?.message?.content || '');
        } catch (error) { reject(error); }
      },
      onerror: reject,
      ontimeout: () => reject(new Error('timeout')),
    });
  });
}
