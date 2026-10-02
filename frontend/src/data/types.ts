/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// ---- 历史回放校验 ----

export type SnapshotInfo = {
  version: number
  source: string
  moduleCount: number
  rowCount: number
}

export type ReplayModuleResult = {
  key: string
  name: string
  restored: number
  pending: number
  abnormal: number
  liveCreated: number
  livePending: number
  liveAbnormal: number
  pageEntry: boolean
  ok: boolean
  note: string
}

export type ReplayBatchStatus = 'running' | 'interrupted' | 'failed' | 'completed'

export type ReplayBatch = {
  batchNo: string
  status: ReplayBatchStatus
  snapshotVersion: number
  startedAt: string
  updatedAt: string
  verified: string[]
  results: ReplayModuleResult[]
  error: string
}

export type ReplayLastSuccess = {
  batchNo: string
  completedAt: string
  modules: number
}

export type LedgerEntry = {
  id: number
  batchNo: string
  moduleKey: string
  moduleName: string
  result: string
  restored: number
  pending: number
  abnormal: number
  checkedAt: string
  note: string
}
