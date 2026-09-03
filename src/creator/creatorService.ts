/**
 * CreatorService：达人业务编排（文档第 12/21 章）。
 * 负责"进入达人页 -> 查库 -> 判断是否联系过 -> 防重复提醒"的决策。
 */
import { CreatorRepository } from './creatorRepository';
import type { ContactStatus, Creator, CreatorInfo } from '../types';
import { logger } from '../utils/logger';

const SCOPE = 'CreatorService';

export interface CreatorPageContext {
  info: CreatorInfo;
  /** 库中已有记录（可能为 undefined = 从未收藏） */
  existing: Creator | undefined;
  /** 是否已联系过（用于防重复提醒，文档第 21 章） */
  alreadyContacted: boolean;
}

export class CreatorService {
  constructor(private repo: CreatorRepository) {}

  /** 同步当前页面达人：不自动入库，只做查询比对（入库动作由用户点击触发） */
  async syncFromPage(info: CreatorInfo): Promise<CreatorPageContext> {
    const existing = await this.repo.getBySecUid(info.secUid);
    const alreadyContacted = !!existing && existing.status !== 'NEW' && existing.status !== 'SAVED';
    if (alreadyContacted) {
      logger.info(SCOPE, `creator already contacted: ${info.nickname}, status = ${existing!.status}`);
    }
    return { info, existing, alreadyContacted };
  }

  /** 加入达人库（文档第 12 章流程中的"创建记录"步骤） */
  async saveToLibrary(info: CreatorInfo): Promise<{ creator: Creator; isNew: boolean }> {
    const result = await this.repo.upsertFromInfo(info);
    logger.info(SCOPE, result.isNew ? `creator saved: ${info.nickname}` : `creator refreshed: ${info.nickname}`);
    return result;
  }

  async markStatus(creatorId: string, status: ContactStatus): Promise<void> {
    await this.repo.updateStatus(creatorId, status);
    logger.info(SCOPE, `status updated: ${creatorId} -> ${status}`);
  }
}
