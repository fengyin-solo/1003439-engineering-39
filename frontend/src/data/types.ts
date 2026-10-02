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

/** 历史回放校验用到的公共类型：快照、回放进度、处置台账。 */

// 存储快照：把某一时刻的 entries 原样留底，version 记录存储结构版本，
// 旧版本快照在回放前先按字段映射回填到当前结构。
export type StorageSnapshot = {
  batchNo: string
  version: number
  savedAt: string
  rows: Record<string, Record<string, unknown>[]>
}

// 单个业务模块的回放核对结果
export type ModuleVerification = {
  key: string
  name: string
  created: number
  pending: number
  abnormal: number
  pageEntryOk: boolean
  ok: boolean
  problems: string[]
}

export type ReplayStatus = 'running' | 'paused' | 'failed' | 'passed'

// 回放进度：中断后靠它续跑，batchNo 保持不变，nextIndex 指向第一个未验证的模块
export type ReplayProgress = {
  batchNo: string
  snapshotBatch: string
  status: ReplayStatus
  nextIndex: number
  results: ModuleVerification[]
  updatedAt: string
}

// 处置台账记录：校验通过后每个业务模块追加一条核对结果，原模块数据不动，留作追溯
export type LedgerEntry = {
  id: string
  batchNo: string
  moduleKey: string
  moduleName: string
  result: 'passed' | 'failed'
  created: number
  pending: number
  abnormal: number
  detail: string
  createdAt: string
}
