/**
 * 全局类型定义 —— 与计划书第 7/13/14/18/25 章的数据结构一一对应。
 */

/** 页面类型（文档第 5.1 节） */
export type PageType = 'HOME' | 'SEARCH' | 'CREATOR' | 'VIDEO' | 'MESSAGE' | 'UNKNOWN';
export type ProfileGender = 'MALE' | 'FEMALE' | 'UNKNOWN';
export type TargetGender = 'ANY' | 'MALE' | 'FEMALE';
export type OutreachMode = 'BUSINESS' | 'DATING';

export interface WorkSample {
  url: string;
  caption: string;
  coverUrl: string;
}

export interface WorkGenderEvidence {
  source: 'CAPTION' | 'TRANSCRIPT' | 'COVER';
  text: string;
  workUrl?: string;
}

export interface WorkCoverText {
  workIndex: number;
  text: string;
}

export interface WorkGenderSuggestion {
  gender: ProfileGender;
  evidence: WorkGenderEvidence[];
  worksChecked: number;
  coversChecked: number;
  transcriptUsed: boolean;
  warning?: string;
}

/** 联系状态机（文档第 14 章）：NEW→SAVED→CONTACTED→REPLIED→INTERESTED→NEGOTIATING→COOPERATING→FINISHED，另有 REJECTED */
export type ContactStatus =
  | 'NEW'
  | 'SAVED'
  | 'CONTACTED'
  | 'REPLIED'
  | 'INTERESTED'
  | 'NEGOTIATING'
  | 'COOPERATING'
  | 'FINISHED'
  | 'REJECTED';

export const CONTACT_STATUS_FLOW: ContactStatus[] = [
  'NEW', 'SAVED', 'CONTACTED', 'REPLIED', 'INTERESTED',
  'NEGOTIATING', 'COOPERATING', 'FINISHED', 'REJECTED',
];

export const CONTACT_STATUS_LABEL: Record<ContactStatus, string> = {
  NEW: '未联系',
  SAVED: '已收藏',
  CONTACTED: '已联系',
  REPLIED: '已回复',
  INTERESTED: '有意向',
  NEGOTIATING: '洽谈中',
  COOPERATING: '合作中',
  FINISHED: '已完成',
  REJECTED: '已拒绝',
};

/** 达人主页解析结果（文档第 7.1 节，第一阶段只采集必要信息） */
export interface CreatorInfo {
  secUid: string;
  nickname: string;
  avatar: string;
  followers: number;
  followersKnown: boolean;
  gender: ProfileGender;
  following: number;
  likes: number;
  signature: string;
  url: string;
  tags: string[];
}

/** 达人库记录（文档第 13 章 Creator） */
export interface Creator extends CreatorInfo {
  id: string;
  genderConfirmed?: boolean; // 用户在本地人工标记
  status: ContactStatus;
  note: string;
  lastContactAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 私信记录（文档第 18 章 Message） */
export interface OutreachMessage {
  id: string;
  creatorId: string;
  type: 'OUTREACH' | 'FOLLOW_UP';
  content: string;
  templateId: string | null;
  createdAt: number;
  status: 'DRAFT' | 'FILLED' | 'SENT';
}

/** 私信模板（文档第 9 章） */
export interface MessageTemplate {
  id: string;
  name: string;
  content: string;
  builtIn?: boolean;
}

/** 配置中心（文档第 25 章） */
export interface AppSettings {
  outreachMode: OutreachMode;
  targetGender: TargetGender;
  minFollowers: number;
  maxFollowers: number; // 0 表示不限上限
  datingMessage: string;
  datingMessageMode: 'CUSTOM' | 'TEMPLATE';
  datingTemplateId: string;
  brand: string;          // 品牌名称
  brandIntro: string;     // 品牌简介
  product: string;        // 产品名称
  contact: string;        // 默认联系人
  wechat: string;         // 联系方式
  category: string;       // 默认达人类型
  defaultTemplateId: string;
  businessMessageMode: 'CUSTOM' | 'TEMPLATE';
  customTemplates: MessageTemplate[];
  aiEnabled: boolean;
  aiEndpoint: string;     // OpenAI 兼容接口
  aiApiKey: string;
  aiModel: string;
  aiTone: string;         // AI 语气
  autoSendEnabled: boolean; // REQ-20260903-01：消息自动发送开关（全局持久，默认关闭）
  customMessage: string;  // 商务连刷自由文案（支持模板变量）
  autoBatchLimit: number; // REQ-20260903-02：连刷自动化单会话发送上限
  debug: boolean;
}
