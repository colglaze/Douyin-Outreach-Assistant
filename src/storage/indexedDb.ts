/**
 * IndexedDB 封装（文档第 13 章：第一版使用 IndexedDB 而非 localStorage）。
 * 三个 object store：
 *   creators - keyPath id，索引 secUid（唯一）、status
 *   messages - keyPath id，索引 creatorId
 *   settings - keyPath key
 */
import { logger } from '../utils/logger';

const SCOPE = 'IndexedDB';
const DB_NAME = 'douyin-outreach';
const DB_VERSION = 1;

export const Stores = {
  CREATORS: 'creators',
  MESSAGES: 'messages',
  SETTINGS: 'settings',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(Stores.CREATORS)) {
        const store = db.createObjectStore(Stores.CREATORS, { keyPath: 'id' });
        store.createIndex('secUid', 'secUid', { unique: true });
        store.createIndex('status', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains(Stores.MESSAGES)) {
        const store = db.createObjectStore(Stores.MESSAGES, { keyPath: 'id' });
        store.createIndex('creatorId', 'creatorId', { unique: false });
      }
      if (!db.objectStoreNames.contains(Stores.SETTINGS)) {
        db.createObjectStore(Stores.SETTINGS, { keyPath: 'key' });
      }
      logger.info(SCOPE, 'database schema initialized');
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      logger.error(SCOPE, 'open failed', req.error);
      reject(req.error);
    };
  });
  return dbPromise;
}

function tx<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const req = run(t.objectStore(storeName));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbPut<T>(storeName: string, value: T): Promise<IDBValidKey> {
  const db = await openDB();
  return tx(db, storeName, 'readwrite', (s) => s.put(value));
}

export async function dbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openDB();
  return tx<T | undefined>(db, storeName, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export async function dbGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openDB();
  return tx<T[]>(db, storeName, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export async function dbGetByIndex<T>(
  storeName: string,
  indexName: string,
  value: string,
): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readonly');
    const req = t.objectStore(storeName).index(indexName).get(value);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function dbDelete(storeName: string, key: string): Promise<undefined> {
  const db = await openDB();
  return tx(db, storeName, 'readwrite', (s) => s.delete(key));
}
