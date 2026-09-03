/**
 * 私信模板系统（文档第 9 章）。
 * 支持 {{nickname}} {{followers}} {{brand}} {{product}} {{contact}} {{wechat}} {{category}} 变量。
 */
import type { AppSettings, CreatorInfo, MessageTemplate } from '../types';
import { formatCount } from '../utils/number';

/** 内置模板（MVP 阶段；模板管理界面属 V1.0 范围） */
export const BUILTIN_TEMPLATES: MessageTemplate[] = [
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

/** 变量替换：{{key}} -> value；未提供的变量替换为空串并保留可读性 */
export function render(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? '');
}

export function getTemplateById(id: string): MessageTemplate | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}
