import type { EntryRow, LedgerEntry, ReplayProgress, StorageSnapshot } from './types'

// 历史回放校验的本地持久化。
// 注意：这里全部走「裸读」——键不存在就返回空，绝不走 local-store 的 readStorage，
// 也就不会触发示例数据播种。回放无论重复多少次，都不能往业务数据里新增示例数据。

const ENTRIES_KEY = 'forest-fire-patrol:entries'
const SNAPSHOTS_KEY = 'forest-fire-patrol:snapshots'
const REPLAY_KEY = 'forest-fire-patrol:replay'
const LEDGER_KEY = 'forest-fire-patrol:ledger'

function storage(): Storage | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  return window.localStorage
}

function readJson<T>(key: string): T | null {
  const store = storage()
  if (!store) {
    return null
  }
  const raw = store.getItem(key)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  storage()?.setItem(key, JSON.stringify(value))
}

/** 裸读业务数据：没有就返回 null，由调用方决定怎么处理，这里不播种。 */
export function readRawEntries(): Record<string, EntryRow[]> | null {
  return readJson<Record<string, EntryRow[]>>(ENTRIES_KEY)
}

export function readSnapshots(): StorageSnapshot[] {
  return readJson<StorageSnapshot[]>(SNAPSHOTS_KEY) ?? []
}

export function appendSnapshot(snapshot: StorageSnapshot): void {
  writeJson(SNAPSHOTS_KEY, [...readSnapshots(), snapshot])
}

export function findSnapshot(batchNo: string): StorageSnapshot | null {
  return readSnapshots().find((item) => item.batchNo === batchNo) ?? null
}

export function readReplayProgress(): ReplayProgress | null {
  return readJson<ReplayProgress>(REPLAY_KEY)
}

export function writeReplayProgress(progress: ReplayProgress): void {
  writeJson(REPLAY_KEY, progress)
}

export function readLedger(): LedgerEntry[] {
  return readJson<LedgerEntry[]>(LEDGER_KEY) ?? []
}

export function appendLedgerEntries(entries: LedgerEntry[]): void {
  const existing = readLedger()
  const known = new Set(existing.map((item) => item.id))
  // 台账 id 由批次号 + 模块决定，同一批次重复入账直接去重
  const fresh = entries.filter((item) => !known.has(item.id))
  if (fresh.length > 0) {
    writeJson(LEDGER_KEY, [...existing, ...fresh])
  }
}
