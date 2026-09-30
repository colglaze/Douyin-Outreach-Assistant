/**
 * 私信模板系统（文档第 9 章）。
 * 支持 {{nickname}} {{followers}} {{brand}} {{product}} {{contact}} {{wechat}} {{category}} 变量。
 */
import type { AppSettings, CreatorInfo, MessageTemplate } from '../types';
import { formatCount } from '../utils/number';

/** 内置模板只读；用户模板保存在本地设置。 */
export const BUILTIN_TEMPLATES: MessageTemplate[] = [
  {
    id: 'dating_001',
    name: '礼貌交友',
    builtIn: true,
    content: '你好 {{nickname}}，看到你的分享，觉得很有意思。想认识一下，方便聊聊吗？如果不方便也没关系，祝你今天愉快。',
  },
  {
    id: 'business_001',
    name: '商务合作',
    builtIn: true,
    content:
      '你好 {{nickname}}，\n\n我们是 {{brand}}，目前正在寻找优质的{{category}}创作者进行合作。\n\n看了你的内容之后感觉与你的账号定位比较匹配，想了解一下最近是否有商务合作档期？\n\n方便的话可以加我微信：{{wechat}}',
  },
  {
    id: 'product_001',
    name: '产品置换',
    builtIn: true,
    content:
      '你好 {{nickname}}～\n\n我们是 {{brand}}，最近有一款{{product}}想邀请你体验。\n\n如果你感兴趣的话，我们可以提供产品置换合作，期待你的回复！',
  },
];

/** 由达人信息 + 配置中心构建变量表 */
export function buildVars(info: CreatorInfo, settings: AppSettings): Record<string, string> {
  return {
    nickname: info.nickname,
    followers: formatCount(info.followers),
    signature: info.signature,
    brand: settings.brand,
    product: settings.product,
    contact: settings.contact,
    wechat: settings.wechat,
    category: settings.category || '各领域',
  };
}

/** 已知变量替换为对应值；未知占位符保留原样，避免改写自由文案。 */
export function render(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match);
}

export function getAllTemplates(settings: AppSettings): MessageTemplate[] {
  return [...BUILTIN_TEMPLATES, ...settings.customTemplates];
}

export function getTemplateById(id: string, customTemplates: MessageTemplate[] = []): MessageTemplate | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id) || customTemplates.find((t) => t.id === id);
}

export function saveCustomTemplate(
  templates: MessageTemplate[], name: string, content: string, id?: string,
): { templates: MessageTemplate[]; template: MessageTemplate } {
  const cleanName = name.trim();
  const cleanContent = content.trim();
  if (!cleanName || cleanName.length > 80 || !cleanContent) {
    throw new Error('模板名称需为 1–80 字，内容不能为空');
  }
  const existing = id ? templates.find((t) => t.id === id) : undefined;
  if (id && (!existing || existing.builtIn)) throw new Error('只能修改自定义模板');
  const template: MessageTemplate = { id: id || `custom_${crypto.randomUUID()}`, name: cleanName, content: cleanContent };
  return {
    templates: existing ? templates.map((t) => t.id === id ? template : t) : [...templates, template],
    template,
  };
}

export function deleteCustomTemplate(settings: AppSettings, id: string): Partial<AppSettings> {
  if (!settings.customTemplates.some((t) => t.id === id)) throw new Error('自定义模板不存在');
  return {
    customTemplates: settings.customTemplates.filter((t) => t.id !== id),
    defaultTemplateId: settings.defaultTemplateId === id ? 'business_001' : settings.defaultTemplateId,
    datingTemplateId: settings.datingTemplateId === id ? 'dating_001' : settings.datingTemplateId,
  };
}

export function resolveBatchMessageSource(settings: AppSettings): string {
  const dating = settings.outreachMode === 'DATING';
  const mode = dating ? settings.datingMessageMode : settings.businessMessageMode;
  if (mode === 'CUSTOM') return dating ? settings.datingMessage : settings.customMessage;
  const templateId = dating ? settings.datingTemplateId : settings.defaultTemplateId;
  return getTemplateById(templateId, settings.customTemplates)?.content || '';
}
