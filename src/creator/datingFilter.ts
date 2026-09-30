import type { AppSettings, CreatorInfo, ProfileGender } from '../types';

export interface DatingMatch {
  matches: boolean;
  reason: string;
}

/** 交友筛选只依据明确展示的资料；未知字段不按 0 或猜测值处理。 */
export function evaluateDatingMatch(
  info: CreatorInfo,
  settings: AppSettings,
  savedGender: ProfileGender = 'UNKNOWN',
  savedConfirmed = false,
): DatingMatch {
  if (settings.outreachMode !== 'DATING') return { matches: true, reason: '商务模式' };

  const gender = savedConfirmed ? savedGender : info.gender;
  if (settings.targetGender !== 'ANY') {
    if (gender === 'UNKNOWN') return { matches: false, reason: '性别未显示，已跳过' };
    if (gender !== settings.targetGender) return { matches: false, reason: '性别不匹配，已跳过' };
  }

  if (!info.followersKnown) return { matches: false, reason: '粉丝数未识别，已跳过' };
  if (info.followers < settings.minFollowers) return { matches: false, reason: '粉丝数低于下限，已跳过' };
  if (settings.maxFollowers > 0 && info.followers > settings.maxFollowers) {
    return { matches: false, reason: '粉丝数高于上限，已跳过' };
  }
  return { matches: true, reason: '符合交友筛选' };
}
