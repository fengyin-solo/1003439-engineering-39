import { MODULES, MODULE_BY_KEY } from '@/data/modules'
import {
  appendLedgerEntries,
  appendSnapshot,
  findSnapshot,
  readLedger,
  readRawEntries,
  readReplayProgress,
  readSnapshots,
  writeReplayProgress,
} from '@/data/replay-store'
import type {
  EntryRow,
  LedgerEntry,
  ModuleVerification,
  ReplayProgress,
  StorageSnapshot,
} from '@/data/types'

// 历史回放校验：读取存储快照 → 旧版本按字段映射回填 → 在隔离空间（纯内存对象）恢复
// 各业务模块并逐一核对页面入口。全程不写业务数据，失败不会覆盖现有总览。

// 当前存储结构版本：v2 = { id, status, pending, abnormal, ...业务字段 }
export const CURRENT_STORAGE_VERSION = 2

// 旧版本字段映射：v1 的状态字段叫 state，且没有 pending / abnormal 标记，
// 升到 v2 时把 state 改名成 status，标记位按下面的默认值回填。
const FIELD_MAPPINGS: Record<number, Record<string, string>> = {
  1: { state: 'status' },
}

// 页面入口文件清单：构建期收集，回放时逐一确认每个模块都有能打开的页面
const PAGE_ENTRIES = import.meta.glob('../views/*/index.vue')

// 批次号要全局唯一：精确到毫秒再加两位序号，同一毫秒内连开两批也不会撞号
let tick = 0

function stamp(): string {
  const now = new Date()
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  tick = (tick + 1) % 100
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${day}-${time}${pad(now.getMilliseconds(), 3)}${pad(tick)}`
}

/** 把旧版本快照逐版做字段映射，升到当前结构后补齐默认标记，返回隔离空间用的行数据。 */
export function migrateSnapshotRows(snapshot: StorageSnapshot): Record<string, EntryRow[]> {
  const restored: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(snapshot.rows)) {
    const meta = MODULE_BY_KEY.get(key)
    const lastStatus = meta ? meta.statuses[meta.statuses.length - 1] : ''
    restored[key] = rows.map((raw) => {
      let row: Record<string, unknown> = { ...raw }
      for (let version = snapshot.version; version < CURRENT_STORAGE_VERSION; version += 1) {
        const mapping = FIELD_MAPPINGS[version] ?? {}
        row = Object.fromEntries(
          Object.entries(row).map(([field, value]) => [mapping[field] ?? field, value]),
        )
      }
      const status = String(row.status ?? '')
      return {
        ...row,
        status,
        // 旧版本没有标记位：待处理按「不是末态」回填，异常默认无
        pending: typeof row.pending === 'boolean' ? row.pending : status !== lastStatus,
        abnormal: typeof row.abnormal === 'boolean' ? row.abnormal : false,
      } as EntryRow
    })
  }
  return restored
}

/** 把当前行数据转成 v1 旧格式：status 改叫 state，去掉 pending / abnormal。 */
function toLegacyRows(rows: EntryRow[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const { status, pending, abnormal, ...fields } = row
    return { ...fields, state: status }
  })
}

/**
 * 留存当前业务数据的存储快照。
 * asVersion 用于本地模拟旧版存储（比如传 1），验证回放时的字段映射回填。
 * 裸读 entries：本地还没有数据时快照就是空的，不触发示例数据播种。
 */
export function captureSnapshot(asVersion: number = CURRENT_STORAGE_VERSION): StorageSnapshot {
  const raw = readRawEntries() ?? {}
  const rows: StorageSnapshot['rows'] = {}
  for (const [key, list] of Object.entries(raw)) {
    rows[key] = asVersion < CURRENT_STORAGE_VERSION ? toLegacyRows(list) : list.map((row) => ({ ...row }))
  }
  const snapshot: StorageSnapshot = {
    batchNo: `SNAP-${stamp()}`,
    version: asVersion,
    savedAt: new Date().toISOString(),
    rows,
  }
  appendSnapshot(snapshot)
  return snapshot
}

export function listSnapshots(): StorageSnapshot[] {
  return readSnapshots()
}

async function pageEntryProblems(key: string): Promise<string[]> {
  const problems: string[] = []
  if (!PAGE_ENTRIES[`../views/${key}/index.vue`]) {
    problems.push(`缺少页面文件 views/${key}/index.vue`)
  }
  const { default: router } = await import('@/router')
  if (!router.hasRoute(key)) {
    problems.push(`路由表没有登记 /${key} 入口`)
  }
  return problems
}

/** 在隔离空间里恢复单个模块并核对：模块登记、页面入口、状态合法性，再统计三量。 */
async function verifyModule(key: string, rows: EntryRow[]): Promise<ModuleVerification> {
  const meta = MODULE_BY_KEY.get(key)
  const problems: string[] = []
  if (!meta) {
    problems.push('业务模块未登记')
  }
  const entryProblems = await pageEntryProblems(key)
  problems.push(...entryProblems)
  if (meta) {
    const unknown = rows.filter((row) => !meta.statuses.includes(String(row.status)))
    if (unknown.length > 0) {
      problems.push(`${unknown.length} 条记录的状态不在已登记状态里`)
    }
  }
  return {
    key,
    name: meta?.name ?? key,
    created: rows.length,
    pending: rows.filter((row) => row.pending).length,
    abnormal: rows.filter((row) => row.abnormal).length,
    pageEntryOk: entryProblems.length === 0,
    ok: problems.length === 0,
    problems,
  }
}

function persist(progress: ReplayProgress): ReplayProgress {
  const next = { ...progress, updatedAt: new Date().toISOString() }
  writeReplayProgress(next)
  return next
}

export function currentReplay(): ReplayProgress | null {
  return readReplayProgress()
}

/** 开新批次：取最新一份快照从头核对。已有未完成的批次时请走 resumeReplay 保留批次号。 */
export function beginReplay(): ReplayProgress {
  const snapshots = readSnapshots()
  const snapshot = snapshots[snapshots.length - 1]
  if (!snapshot) {
    throw new Error('还没有可用的存储快照，请先留存一份快照')
  }
  return persist({
    batchNo: `REPLAY-${stamp()}`,
    snapshotBatch: snapshot.batchNo,
    status: 'running',
    nextIndex: 0,
    results: [],
    updatedAt: '',
  })
}

/** 继续回放：保留批次号，丢掉未验证模块的残留结果，从 nextIndex 指向的模块接着来。 */
export function resumeReplay(): ReplayProgress {
  const progress = readReplayProgress()
  if (!progress) {
    throw new Error('没有可继续的回放批次')
  }
  if (progress.status === 'passed') {
    throw new Error(`批次 ${progress.batchNo} 已校验通过，不用继续`)
  }
  return persist({
    ...progress,
    status: 'running',
    results: progress.results.slice(0, progress.nextIndex),
  })
}

let pauseRequested = false

export function requestPauseReplay(): void {
  pauseRequested = true
}

/** 逐模块恢复并核对，每步落盘进度；全部通过才写处置台账。 */
export async function runReplay(
  onUpdate?: (progress: ReplayProgress) => void,
): Promise<ReplayProgress> {
  pauseRequested = false
  const progress = readReplayProgress()
  if (!progress) {
    throw new Error('还没有回放批次，请先开始回放')
  }
  const snapshot = findSnapshot(progress.snapshotBatch)
  if (!snapshot) {
    // 快照丢了批次也走不下去：标失败、留批次号，等业务侧补快照后再继续
    return persist({ ...progress, status: 'failed' })
  }
  // 隔离空间：迁移结果只放在内存里，不写回 entries，现有总览不受影响
  const restored = migrateSnapshotRows(snapshot)
  while (progress.nextIndex < MODULES.length) {
    if (pauseRequested) {
      return persist({ ...progress, status: 'paused' })
    }
    const meta = MODULES[progress.nextIndex]
    const result = await verifyModule(meta.key, restored[meta.key] ?? [])
    progress.results.push(result)
    if (!result.ok) {
      // 失败即停：保留批次号与进度，不写台账、不动业务数据，下次从该模块继续
      return persist({ ...progress, status: 'failed' })
    }
    progress.nextIndex += 1
    const saved = persist({ ...progress, status: 'running' })
    onUpdate?.({ ...saved, results: [...saved.results] })
    // 让出主线程：界面上能看到逐模块推进，也给中断留出窗口
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  const done = persist({ ...progress, status: 'passed' })
  writeLedger(done)
  return done
}

/** 校验通过后，给每个业务模块的处置台账追加一条核对结果；原模块数据保留不动。 */
function writeLedger(progress: ReplayProgress): void {
  const entries: LedgerEntry[] = progress.results.map((result) => ({
    id: `L-${progress.batchNo}-${result.key}`,
    batchNo: progress.batchNo,
    moduleKey: result.key,
    moduleName: result.name,
    result: 'passed',
    created: result.created,
    pending: result.pending,
    abnormal: result.abnormal,
    detail: `回放批次 ${progress.batchNo} 核对通过：页面入口正常，登记 ${result.created} 条、待处理 ${result.pending}、异常 ${result.abnormal}`,
    createdAt: new Date().toISOString(),
  }))
  appendLedgerEntries(entries)
}

export function loadLedger(): LedgerEntry[] {
  return readLedger()
}
