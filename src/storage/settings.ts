/**
 * 配置中心（文档第 25 章）：品牌信息、联系方式、默认模板、AI 配置等。
 * 持久化到 IndexedDB 的 settings store，内存中做一层缓存。
 */
import { dbGet, dbPut, Stores } from './indexedDb';
import type { AppSettings } from '../types';
import { setDebug } from '../utils/logger';

const SETTINGS_KEY = 'app';

export const DEFAULT_SETTINGS: AppSettings = {
  brand: '',
  brandIntro: '',
  product: '',
  contact: '',
  wechat: '',
  category: '',
  defaultTemplateId: 'business_001',
  aiEnabled: false,
  aiEndpoint: 'https://api.openai.com/v1/chat/completions',
  aiApiKey: '',
  aiModel: 'gpt-4o-mini',
  aiTone: '自然口语化',
  autoSendEnabled: false, // REQ-20260903-01：默认禁用，保持人工点击发送
  customMessage: '',      // REQ-20260903-02：默认空，回退默认模板
  autoBatchLimit: 10,     // REQ-20260903-02：连刷单会话发送上限
  debug: false,
};

let cache: AppSettings | null = null;

export async function loadSettings(): Promise<AppSettings> {
  if (cache) return cache;
  const row = await dbGet<{ key: string; value: Partial<AppSettings> }>(Stores.SETTINGS, SETTINGS_KEY);
  cache = { ...DEFAULT_SETTINGS, ...(row?.value || {}) };
  setDebug(cache.debug);
  return cache;
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadSettings();
  cache = { ...current, ...patch };
  await dbPut(Stores.SETTINGS, { key: SETTINGS_KEY, value: cache });
  setDebug(cache.debug);
  return cache;
}

/** 同步读取（必须先 loadSettings 过） */
export function getSettingsSync(): AppSettings {
  return cache || DEFAULT_SETTINGS;
}
