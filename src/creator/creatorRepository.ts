/**
 * CreatorRepository：达人库数据访问层（文档第 13/17 章）。
 * 以 secUid 作为 Creator 去重的唯一标识（文档第 17 章）。
 */
import { dbDelete, dbGet, dbGetAll, dbGetByIndex, dbPut, Stores } from '../storage/indexedDb';
import type { ContactStatus, Creator, CreatorInfo } from '../types';

export class CreatorRepository {
  /** secUid -> 稳定的内部 id */
  private toId(secUid: string): string {
    return `creator_${secUid}`;
  }

  async exists(secUid: string): Promise<boolean> {
    return (await this.getBySecUid(secUid)) !== undefined;
  }

  async getBySecUid(secUid: string): Promise<Creator | undefined> {
    return dbGetByIndex<Creator>(Stores.CREATORS, 'secUid', secUid);
  }

  async getById(id: string): Promise<Creator | undefined> {
    return dbGet<Creator>(Stores.CREATORS, id);
  }

  async list(): Promise<Creator[]> {
    const all = await dbGetAll<Creator>(Stores.CREATORS);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 由页面解析结果创建新记录；已存在时合并刷新基础字段，保留状态与备注 */
  async upsertFromInfo(info: CreatorInfo): Promise<{ creator: Creator; isNew: boolean }> {
    const id = this.toId(info.secUid);
    const now = Date.now();
    const existing = await this.getBySecUid(info.secUid);

    if (existing) {
      const merged: Creator = {
        ...existing,
        nickname: info.nickname || existing.nickname,
        avatar: info.avatar || existing.avatar,
        followers: info.followersKnown ? info.followers : existing.followers,
        followersKnown: info.followersKnown || existing.followersKnown || false,
        gender: existing.genderConfirmed ? existing.gender : info.gender !== 'UNKNOWN' ? info.gender : existing.gender || 'UNKNOWN',
        following: info.following || existing.following,
        likes: info.likes || existing.likes,
        signature: info.signature || existing.signature,
        url: info.url || existing.url,
        tags: info.tags.length ? info.tags : existing.tags,
        updatedAt: now,
      };
      await dbPut(Stores.CREATORS, merged);
      return { creator: merged, isNew: false };
    }

    const creator: Creator = {
      ...info,
      id,
      status: 'SAVED',
      note: '',
      lastContactAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await dbPut(Stores.CREATORS, creator);
    return { creator, isNew: true };
  }

  async updateStatus(id: string, status: ContactStatus): Promise<void> {
    const c = await this.getById(id);
    if (!c) return;
    await dbPut(Stores.CREATORS, {
      ...c,
      status,
      lastContactAt: status === 'CONTACTED' ? Date.now() : c.lastContactAt,
      updatedAt: Date.now(),
    });
  }

  /** 用户核对主页后在本地标记性别；后续页面解析不会覆盖人工标记。 */
  async updateGender(id: string, gender: Creator['gender']): Promise<void> {
    const c = await this.getById(id);
    if (!c) return;
    await dbPut(Stores.CREATORS, {
      ...c,
      gender,
      genderConfirmed: gender !== 'UNKNOWN',
      updatedAt: Date.now(),
    });
  }

  async updateNote(id: string, note: string): Promise<void> {
    const c = await this.getById(id);
    if (!c) return;
    await dbPut(Stores.CREATORS, { ...c, note, updatedAt: Date.now() });
  }

  async remove(id: string): Promise<void> {
    await dbDelete(Stores.CREATORS, id);
  }
}
