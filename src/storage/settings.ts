/**
 * 配置中心（文档第 25 章）：品牌信息、联系方式、默认模板、AI 配置等。
 * 持久化到 IndexedDB 的 settings store，内存中做一层缓存。
 */
import { dbGet, dbPut, Stores } from './indexedDb';
import type { AppSettings } from '../types';
import { setDebug } from '../utils/logger';

const SETTINGS_KEY = 'app';

export const DEFAULT_SETTINGS: AppSettings = {
  outreachMode: 'BUSINESS',
  targetGender: 'ANY',
  minFollowers: 0,
  maxFollowers: 0,
  datingMessage: '你好 {{nickname}}，看到你的分享，觉得很有意思。想认识一下，方便聊聊吗？如果不方便也没关系，祝你今天愉快。',
  datingMessageMode: 'CUSTOM',
  datingTemplateId: 'dating_001',
  brand: '',
  brandIntro: '',
  product: '',
  contact: '',
  wechat: '',
  category: '',
  defaultTemplateId: 'business_001',
  businessMessageMode: 'TEMPLATE',
  customTemplates: [],
  aiEnabled: false,
  aiEndpoint: 'https://api.openai.com/v1/chat/completions',
  aiApiKey: '',
  aiModel: 'gpt-4o-mini',
  aiTone: '自然口语化',
  autoSendEnabled: false, // REQ-20260903-01：默认禁用，保持人工点击发送
  customMessage: '',
  autoBatchLimit: 10,     // REQ-20260903-02：连刷单会话发送上限
  debug: false,
};

let cache: AppSettings | null = null;

export function normalizeSettings(stored: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    customTemplates: Array.isArray(stored.customTemplates) ? stored.customTemplates : [],
    businessMessageMode: stored.businessMessageMode ?? (stored.customMessage?.trim() ? 'CUSTOM' : 'TEMPLATE'),
  };
}

export async function loadSettings(): Promise<AppSettings> {
  if (cache) return cache;
  const row = await dbGet<{ key: string; value: Partial<AppSettings> }>(Stores.SETTINGS, SETTINGS_KEY);
  cache = normalizeSettings(row?.value);
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
