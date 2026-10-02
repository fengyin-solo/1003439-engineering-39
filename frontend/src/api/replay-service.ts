import { MODULES, MODULE_BY_KEY } from '@/data/modules'
import { allRows, storageKey } from '@/data/local-store'
import { SEED_ROWS } from '@/data/seed'
import type {
  EntryRow,
  LedgerEntry,
  ModuleMeta,
  ReplayBatch,
  ReplayLastSuccess,
  ReplayModuleResult,
  SnapshotInfo,
} from '@/data/types'

// 历史回放校验（本地开发环境用）：
// 只读业务存储，把旧版本快照按字段映射回填后，在隔离空间（纯内存）里逐模块恢复并核对页面入口。
// 全部通过才往各模块处置台账写一条核对结果；任何一步失败都不碰 forest-fire-patrol:entries，
// 现有运营总览保持不变。回放自己的状态放在独立的 key 里，和业务数据互不影响。
const SNAPSHOT_KEY = 'forest-fire-patrol:entries-snapshot'
const BATCH_KEY = 'forest-fire-patrol:replay-batch'
const LAST_KEY = 'forest-fire-patrol:replay-last'
const LEDGER_KEY = 'forest-fire-patrol:ledger'

// 旧版存储（v1）的字段名 → 当前字段名，回填时逐字段按这张表映射。
const LEGACY_FIELD_MAP: Record<string, string> = {
  编号: 'id',
  状态: 'status',
  待处理: 'pending',
  异常: 'abnormal',
}

// 演示失败路径用：旧版快照里可能带着现已下线的模块。
const RETIRED_MODULE_KEY = 'oldwatch'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function storage(): Storage | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  return window.localStorage
}

function readKey(key: string): string | null {
  return storage()?.getItem(key) ?? null
}

function writeKey(key: string, value: unknown): void {
  storage()?.setItem(key, JSON.stringify(value))
}

// ---- 快照读取与版本识别 ----

type ParsedSnapshot = {
  version: number
  modules: Record<string, unknown[]>
}

function readSnapshotRaw(): { raw: string; source: string } {
  const snapshot = readKey(SNAPSHOT_KEY)
  if (snapshot) {
    return { raw: snapshot, source: SNAPSHOT_KEY }
  }
  const live = readKey(storageKey())
  if (live) {
    return { raw: live, source: storageKey() }
  }
  throw new Error('浏览器里还没有可回放的存储快照')
}

function parseSnapshot(raw: string): ParsedSnapshot {
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('快照内容不是可识别的存储结构')
  }
  const wrapper = parsed as Record<string, unknown>
  // v1 旧版：{ version: 1, savedAt, modules: { 模块key: [行] } }
  if (wrapper.version === 1 && wrapper.modules && typeof wrapper.modules === 'object') {
    return { version: 1, modules: wrapper.modules as Record<string, unknown[]> }
  }
  // 当前版本：直接就是 { 模块key: [行] }
  return { version: 2, modules: wrapper as Record<string, unknown[]> }
}

export function inspectSnapshot(): SnapshotInfo {
  const { raw, source } = readSnapshotRaw()
  const parsed = parseSnapshot(raw)
  const keys = Object.keys(parsed.modules)
  const rowCount = keys.reduce(
    (sum, key) => sum + (Array.isArray(parsed.modules[key]) ? parsed.modules[key].length : 0),
    0,
  )
  return { version: parsed.version, source, moduleCount: keys.length, rowCount }
}

// ---- 旧版字段映射回填 ----

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value !== 0
  }
  const text = String(value ?? '').trim()
  return text === '是' || text === 'true' || text === '1'
}

function migrateRow(meta: ModuleMeta, raw: unknown, index: number): { row: EntryRow; issue: string } {
  const issues: string[] = []
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
  if (source !== raw) {
    issues.push(`第 ${index + 1} 条不是有效记录，已按默认值回填`)
  }
  const mapped: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(source)) {
    mapped[LEGACY_FIELD_MAP[field] ?? field] = value
  }
  const id = Number(mapped.id)
  const status = String(mapped.status ?? '').trim()
  if (!Number.isFinite(id) || id <= 0) {
    issues.push(`第 ${index + 1} 条缺少编号，已按顺序回填`)
  }
  if (!status) {
    issues.push(`第 ${index + 1} 条缺少状态，已回填「${meta.statuses[0]}」`)
  }
  const finalStatus = status || meta.statuses[0]
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const row = {
    ...mapped,
    id: Number.isFinite(id) && id > 0 ? id : index + 1,
    status: finalStatus,
    // 旧版缺待处理/异常标记时按当前约定回填：末态不算待处理，异常默认无。
    pending: mapped.pending === undefined ? finalStatus !== lastStatus : toBoolean(mapped.pending),
    abnormal: mapped.abnormal === undefined ? false : toBoolean(mapped.abnormal),
  } as EntryRow
  return { row, issue: issues.join('；') }
}

// ---- 隔离空间恢复 ----

type RestoredSpace = {
  rows: Record<string, EntryRow[]>
  issues: Record<string, string[]>
  unknownKeys: string[]
}

function restoreSpace(parsed: ParsedSnapshot): RestoredSpace {
  const rows: Record<string, EntryRow[]> = {}
  const issues: Record<string, string[]> = {}
  const unknownKeys = Object.keys(parsed.modules).filter((key) => !MODULE_BY_KEY.has(key))
  for (const meta of MODULES) {
    const rawRows = Array.isArray(parsed.modules[meta.key]) ? parsed.modules[meta.key] : null
    if (rawRows === null) {
      // 快照里没有这个模块：只在隔离空间按示例数据补齐用于核对，不写回正式存储，
      // 所以重复回放也不会给现有数据新增示例记录。
      rows[meta.key] = clone(SEED_ROWS[meta.key] ?? [])
      issues[meta.key] = ['快照缺少该模块，已在隔离空间按示例数据补齐']
      continue
    }
    const seen = new Set<number>()
    const migrated: EntryRow[] = []
    const moduleIssues: string[] = []
    rawRows.forEach((raw, index) => {
      const { row, issue } = migrateRow(meta, raw, index)
      if (seen.has(row.id)) {
        moduleIssues.push(`编号 ${row.id} 重复，多余记录已跳过`)
        return
      }
      seen.add(row.id)
      migrated.push(row)
      if (issue) {
        moduleIssues.push(issue)
      }
    })
    rows[meta.key] = migrated
    if (moduleIssues.length > 0) {
      issues[meta.key] = moduleIssues
    }
  }
  return { rows, issues, unknownKeys }
}

// ---- 批次状态：中断保留批次号，继续时从未验证模块开始 ----

export function loadBatch(): ReplayBatch | null {
  const raw = readKey(BATCH_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as ReplayBatch
  } catch {
    return null
  }
}

function saveBatch(batch: ReplayBatch): void {
  writeKey(BATCH_KEY, batch)
}

export function loadLastSuccess(): ReplayLastSuccess | null {
  const raw = readKey(LAST_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as ReplayLastSuccess
  } catch {
    return null
  }
}

function todayStamp(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}${month}${day}`
}

function nextBatchNo(): string {
  const prefix = `RB-${todayStamp()}-`
  const seqs: number[] = []
  for (const candidate of [loadBatch()?.batchNo, loadLastSuccess()?.batchNo]) {
    if (candidate && candidate.startsWith(prefix)) {
      const seq = Number(candidate.slice(prefix.length))
      if (Number.isFinite(seq)) {
        seqs.push(seq)
      }
    }
  }
  const next = (seqs.length > 0 ? Math.max(...seqs) : 0) + 1
  return `${prefix}${String(next).padStart(3, '0')}`
}

export type ReplayRunState = {
  batch: ReplayBatch
  space: RestoredSpace
  snapshot: SnapshotInfo
}

export function beginReplay(): ReplayRunState {
  const { raw } = readSnapshotRaw()
  const parsed = parseSnapshot(raw)
  const space = restoreSpace(parsed)
  const snapshot = inspectSnapshot()
  const existing = loadBatch()
  if (existing && (existing.status === 'interrupted' || existing.status === 'running')) {
    // 断点续放：保留批次号，已核对的模块不再重复，从未验证模块继续。
    existing.status = 'running'
    existing.updatedAt = new Date().toISOString()
    saveBatch(existing)
    return { batch: existing, space, snapshot }
  }
  const now = new Date().toISOString()
  const batch: ReplayBatch = {
    batchNo: nextBatchNo(),
    status: 'running',
    snapshotVersion: parsed.version,
    startedAt: now,
    updatedAt: now,
    verified: [],
    results: [],
    error: '',
  }
  if (space.unknownKeys.length > 0) {
    // 快照里带着已下线的模块：恢复不了，整批判失败，现有总览保持不变。
    batch.status = 'failed'
    batch.error = `快照包含未登记的模块：${space.unknownKeys.join('、')}，回放已停止，现有总览未被改动`
  }
  saveBatch(batch)
  return { batch, space, snapshot }
}

function verifyModule(
  meta: ModuleMeta,
  space: RestoredSpace,
  hasPageEntry: (key: string) => boolean,
): ReplayModuleResult {
  const rows = space.rows[meta.key] ?? []
  const live = allRows()[meta.key] ?? []
  const pageEntry = hasPageEntry(meta.key)
  const notes = [...(space.issues[meta.key] ?? [])]
  if (!pageEntry) {
    notes.push('页面入口未登记')
  }
  return {
    key: meta.key,
    name: meta.name,
    restored: rows.length,
    pending: rows.filter((row) => row.pending).length,
    abnormal: rows.filter((row) => row.abnormal).length,
    liveCreated: live.length,
    livePending: live.filter((row) => row.pending).length,
    liveAbnormal: live.filter((row) => row.abnormal).length,
    pageEntry,
    ok: pageEntry,
    note: notes.join('；'),
  }
}

export function stepReplay(
  state: ReplayRunState,
  hasPageEntry: (key: string) => boolean,
): ReplayBatch {
  const { batch, space } = state
  if (batch.status !== 'running' && batch.status !== 'interrupted') {
    return batch
  }
  batch.status = 'running'
  const nextMeta = MODULES.find((meta) => !batch.verified.includes(meta.key))
  if (!nextMeta) {
    return finalizeReplay(state)
  }
  const result = verifyModule(nextMeta, space, hasPageEntry)
  batch.results = [...batch.results.filter((item) => item.key !== result.key), result]
  batch.updatedAt = new Date().toISOString()
  if (!result.ok) {
    // 失败步骤只记录到批次里，不写台账、不改总览。
    batch.status = 'failed'
    batch.error = `${nextMeta.name}核对未通过：${result.note || '页面入口缺失'}。现有总览保持不变`
    saveBatch(batch)
    return batch
  }
  batch.verified = [...batch.verified, nextMeta.key]
  saveBatch(batch)
  if (batch.verified.length === MODULES.length) {
    return finalizeReplay(state)
  }
  return batch
}

export function interruptReplay(batch: ReplayBatch): ReplayBatch {
  if (batch.status !== 'running') {
    return batch
  }
  // 中断只改批次状态，批次号和已核对进度都留在本地，下次从未验证模块继续。
  batch.status = 'interrupted'
  batch.updatedAt = new Date().toISOString()
  saveBatch(batch)
  return batch
}

function finalizeReplay(state: ReplayRunState): ReplayBatch {
  const { batch } = state
  batch.status = 'completed'
  batch.updatedAt = new Date().toISOString()
  batch.error = ''
  appendLedger(batch)
  const last: ReplayLastSuccess = {
    batchNo: batch.batchNo,
    completedAt: batch.updatedAt,
    modules: batch.verified.length,
  }
  writeKey(LAST_KEY, last)
  saveBatch(batch)
  return batch
}

// ---- 处置台账：校验通过后逐模块写一条核对结果，原始数据保留供追溯 ----

export function listLedger(moduleKey?: string): LedgerEntry[] {
  const raw = readKey(LEDGER_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as LedgerEntry[]
    const entries = Array.isArray(parsed) ? parsed : []
    return moduleKey ? entries.filter((entry) => entry.moduleKey === moduleKey) : entries
  } catch {
    return []
  }
}

function appendLedger(batch: ReplayBatch): void {
  const existing = listLedger()
  let nextId = existing.reduce((max, entry) => Math.max(max, entry.id), 0) + 1
  const additions: LedgerEntry[] = []
  for (const result of batch.results) {
    // 同一批次同一模块只入一条，重复回放不会重复入账。
    if (existing.some((entry) => entry.batchNo === batch.batchNo && entry.moduleKey === result.key)) {
      continue
    }
    additions.push({
      id: nextId,
      batchNo: batch.batchNo,
      moduleKey: result.key,
      moduleName: result.name,
      result: '核对通过',
      restored: result.restored,
      pending: result.pending,
      abnormal: result.abnormal,
      checkedAt: batch.updatedAt,
      note: `回放批次 ${batch.batchNo} 核对通过：恢复 ${result.restored} 条 / 待处理 ${result.pending} / 异常 ${result.abnormal}，原模块数据保留供追溯`,
    })
    nextId += 1
  }
  if (additions.length > 0) {
    writeKey(LEDGER_KEY, [...existing, ...additions])
  }
}

// ---- 本地开发辅助：造一份旧版快照，验证字段映射回填与失败路径 ----

export function generateLegacySnapshot(includeRetiredModule: boolean): SnapshotInfo {
  const live = allRows()
  const modules: Record<string, unknown[]> = {}
  for (const meta of MODULES) {
    modules[meta.key] = (live[meta.key] ?? []).map((row) => {
      const legacy: Record<string, unknown> = {}
      for (const [field, value] of Object.entries(row)) {
        if (field === 'id') {
          legacy['编号'] = value
        } else if (field === 'status') {
          legacy['状态'] = value
        } else if (field === 'pending') {
          legacy['待处理'] = value ? '是' : '否'
        } else if (field === 'abnormal') {
          legacy['异常'] = value ? '是' : '否'
        } else {
          legacy[field] = value
        }
      }
      return legacy
    })
  }
  if (includeRetiredModule) {
    modules[RETIRED_MODULE_KEY] = [
      { 编号: 1, 状态: '正常', 待处理: '否', 异常: '否', 监测点: '旧瞭望监测点样例' },
    ]
  }
  writeKey(SNAPSHOT_KEY, {
    version: 1,
    savedAt: new Date().toISOString(),
    modules,
  })
  return inspectSnapshot()
}

export function clearSnapshot(): void {
  storage()?.removeItem(SNAPSHOT_KEY)
}
