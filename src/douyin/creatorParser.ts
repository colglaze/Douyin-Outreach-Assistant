/**
 * CreatorParser（文档第 7 章）：访问达人主页后自动识别达人信息。
 * 第一阶段只采集必要字段：昵称 / 主页链接 / 粉丝数 / 简介。
 */
import { DouyinAdapter } from './adapter';
import type { CreatorInfo } from '../types';
import { logger } from '../utils/logger';

const SCOPE = 'CreatorParser';

export class CreatorParser {
  constructor(private adapter: DouyinAdapter) {}

  /** 解析当前达人主页；非达人页或关键字段缺失时返回 null */
  parse(): CreatorInfo | null {
    const secUid = this.adapter.getCreatorSecUid();
    const nickname = this.adapter.getCreatorName();

    if (!secUid) {
      logger.warn(SCOPE, 'not a creator page (secUid missing)');
      return null;
    }
    if (!nickname) {
      logger.warn(SCOPE, 'creator nickname not found, page may still be loading');
      return null;
    }

    const followers = this.adapter.getFollowerCount();
    const info: CreatorInfo = {
      secUid,
      nickname,
      avatar: this.adapter.getAvatar(),
      followers: followers ?? 0,
      followersKnown: followers !== null,
      gender: this.adapter.getProfileGender(),
      following: this.adapter.getFollowingCount(),
      likes: this.adapter.getLikesCount(),
      signature: this.adapter.getSignature(),
      url: this.adapter.getCreatorUrl(),
      tags: this.extractTags(),
    };

    logger.info(SCOPE, 'creator detected', {
      nickname: info.nickname,
      followers: info.followers,
    });
    return info;
  }

  /** 从简介中粗提取标签（#话题 或常见领域词），第一版保持简单 */
  private extractTags(): string[] {
    const sig = this.adapter.getSignature();
    const tags: string[] = [];
    const hashTags = sig.match(/#([^\s#]+)/g);
    if (hashTags) tags.push(...hashTags.map((t) => t.slice(1)));
    return tags.slice(0, 5);
  }
}
