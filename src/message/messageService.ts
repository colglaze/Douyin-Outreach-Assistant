/**
 * MessageService（文档第 18 章）：私信记录。
 * 每次联系保存一条 Message，并联动更新达人状态为 CONTACTED（文档第 12 章流程末尾）。
 */
import { dbGetAll, dbPut, Stores } from '../storage/indexedDb';
import { CreatorRepository } from '../creator/creatorRepository';
import type { OutreachMessage } from '../types';
import { genId } from '../utils/dom';
import { logger } from '../utils/logger';

const SCOPE = 'MessageService';

export class MessageService {
  constructor(private repo: CreatorRepository) {}

  /** 记录一次触达（填入私信后调用），并把达人状态推进到 CONTACTED */
  async recordOutreach(
    creatorId: string,
    content: string,
    templateId: string | null,
  ): Promise<OutreachMessage> {
    const msg: OutreachMessage = {
      id: genId('msg'),
      creatorId,
      type: 'OUTREACH',
      content,
      templateId,
      createdAt: Date.now(),
      // 脚本只负责"填入"，发送由用户人工确认（文档第 20 章自动化边界）
      status: 'FILLED',
    };
    await dbPut(Stores.MESSAGES, msg);
    await this.repo.updateStatus(creatorId, 'CONTACTED');
    logger.info(SCOPE, `outreach recorded for ${creatorId}, length = ${content.length}`);
    return msg;
  }

  async listByCreator(creatorId: string): Promise<OutreachMessage[]> {
    const all = await dbGetAll<OutreachMessage>(Stores.MESSAGES);
    return all
      .filter((m) => m.creatorId === creatorId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 自动发送成功后把消息状态从 FILLED 推进到 SENT（REQ-20260903-01） */
  async markSent(msgId: string): Promise<void> {
    const all = await dbGetAll<OutreachMessage>(Stores.MESSAGES);
    const msg = all.find((m) => m.id === msgId);
    if (!msg) {
      logger.warn(SCOPE, `markSent: message ${msgId} not found`);
      return;
    }
    msg.status = 'SENT';
    await dbPut(Stores.MESSAGES, msg);
    logger.info(SCOPE, `message ${msgId} marked as SENT`);
  }
}
