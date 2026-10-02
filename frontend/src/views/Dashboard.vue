<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>
    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>

    <section class="replay-panel">
      <header class="page-head">
        <div>
          <h3>历史回放校验</h3>
          <p class="page-desc">
            读取浏览器存储快照，旧版本按字段映射回填后在隔离空间逐模块恢复并核对页面入口；
            全程不改上方总览数据，全部通过才写入各模块处置台账。
          </p>
        </div>
        <div class="page-actions">
          <button class="btn" type="button" :disabled="running" @click="makeSnapshot(false)">
            生成旧版快照
          </button>
          <button class="btn" type="button" :disabled="running" @click="makeSnapshot(true)">
            生成旧版快照（含已下线模块）
          </button>
          <button class="btn primary" type="button" :disabled="running" @click="startOrResume">
            {{ startLabel }}
          </button>
          <button v-if="running" class="btn ghost" type="button" @click="requestStop">
            中断回放
          </button>
        </div>
      </header>

      <p class="replay-meta">快照来源：{{ snapshotText }}</p>
      <p v-if="lastSuccess" class="replay-meta">
        最近核对通过：{{ lastSuccess.batchNo }}（{{ fmtTime(lastSuccess.completedAt) }}，{{ lastSuccess.modules }} 个模块）
      </p>
      <p v-if="batch" class="replay-meta">
        当前批次：{{ batch.batchNo }} · {{ statusText }} · 已核对 {{ batch.verified.length }}/{{ totalModules }} 个模块
      </p>
      <p v-if="batch && batch.error" class="error-text">{{ batch.error }}</p>
      <p v-if="panelError" class="error-text">{{ panelError }}</p>

      <table v-if="hasResults" class="data-table">
        <thead>
          <tr>
            <th>业务模块</th><th>恢复条数</th><th>待处理</th><th>异常量</th>
            <th>页面入口</th><th>核对结果</th><th>回填备注</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in batch?.results ?? []" :key="row.key">
            <td>{{ row.name }}</td>
            <td>{{ row.restored }}</td>
            <td>{{ row.pending }}</td>
            <td>{{ row.abnormal }}</td>
            <td>{{ row.pageEntry ? '已登记' : '缺失' }}</td>
            <td>
              <span :class="row.ok ? 'tag-ok' : 'tag-err'">{{ row.ok ? '通过' : '未通过' }}</span>
            </td>
            <td>{{ row.note || '—' }}</td>
          </tr>
        </tbody>
      </table>

      <template v-if="ledgerEntries.length">
        <h4 class="ledger-title">处置台账核对记录（最近 {{ ledgerEntries.length }} 条）</h4>
        <table class="data-table">
          <thead>
            <tr>
              <th>批次号</th><th>业务模块</th><th>核对结果</th>
              <th>恢复条数</th><th>待处理</th><th>异常量</th><th>核对时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in ledgerEntries" :key="entry.id">
              <td>{{ entry.batchNo }}</td>
              <td>{{ entry.moduleName }}</td>
              <td>{{ entry.result }}</td>
              <td>{{ entry.restored }}</td>
              <td>{{ entry.pending }}</td>
              <td>{{ entry.abnormal }}</td>
              <td>{{ fmtTime(entry.checkedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </template>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { loadOverview } from '@/api/local-service'
import {
  beginReplay,
  generateLegacySnapshot,
  inspectSnapshot,
  interruptReplay,
  listLedger,
  loadBatch,
  loadLastSuccess,
  stepReplay,
  type ReplayRunState,
} from '@/api/replay-service'
import { MODULES } from '@/data/modules'
import type {
  LedgerEntry,
  OverviewResult,
  ReplayBatch,
  ReplayLastSuccess,
  SnapshotInfo,
} from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
}

// ---- 历史回放校验 ----

const router = useRouter()
const hasPageEntry = (key: string) => router.hasRoute(key)
const totalModules = MODULES.length
const STEP_INTERVAL = 150

const batch = ref<ReplayBatch | null>(loadBatch())
const snapshot = ref<SnapshotInfo | null>(null)
const lastSuccess = ref<ReplayLastSuccess | null>(loadLastSuccess())
const ledgerEntries = ref<LedgerEntry[]>([])
const panelError = ref('')
const running = ref(false)
const stopRequested = ref(false)

let runState: ReplayRunState | null = null

const hasResults = computed(() => (batch.value?.results.length ?? 0) > 0)
const resumable = computed(
  () => !!batch.value && (batch.value.status === 'interrupted' || batch.value.status === 'running'),
)
const startLabel = computed(() => {
  if (running.value) {
    return '回放中…'
  }
  if (resumable.value && batch.value) {
    return `继续回放（批次 ${batch.value.batchNo}）`
  }
  return '开始回放校验'
})
const statusText = computed(() => {
  const texts: Record<string, string> = {
    running: '进行中',
    interrupted: '已中断，可继续',
    failed: '失败，总览未改动',
    completed: '核对通过',
  }
  return batch.value ? texts[batch.value.status] : ''
})
const snapshotText = computed(() => {
  if (!snapshot.value) {
    return '尚未读取到快照'
  }
  const info = snapshot.value
  return `${info.source} · v${info.version} · ${info.moduleCount} 个模块 / ${info.rowCount} 条记录`
})

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function reloadLedger() {
  ledgerEntries.value = listLedger().slice(-8).reverse()
}

function reloadSnapshotInfo() {
  try {
    snapshot.value = inspectSnapshot()
  } catch {
    snapshot.value = null
  }
}

function makeSnapshot(withRetiredModule: boolean) {
  panelError.value = ''
  try {
    snapshot.value = generateLegacySnapshot(withRetiredModule)
  } catch (error) {
    panelError.value = error instanceof Error ? error.message : '旧版快照生成失败'
  }
}

async function startOrResume() {
  panelError.value = ''
  try {
    runState = beginReplay()
  } catch (error) {
    panelError.value = error instanceof Error ? error.message : '存储快照读取失败'
    return
  }
  batch.value = runState.batch
  snapshot.value = runState.snapshot
  if (runState.batch.status === 'failed') {
    return
  }
  running.value = true
  stopRequested.value = false
  try {
    while (runState.batch.status === 'running' && runState.batch.verified.length < totalModules) {
      if (stopRequested.value) {
        batch.value = interruptReplay(runState.batch)
        break
      }
      stepReplay(runState, hasPageEntry)
      await sleep(STEP_INTERVAL)
    }
  } finally {
    running.value = false
    stopRequested.value = false
    lastSuccess.value = loadLastSuccess()
    reloadLedger()
    refresh()
  }
}

function requestStop() {
  stopRequested.value = true
}

onMounted(() => {
  refresh()
  reloadSnapshotInfo()
  reloadLedger()
})

onBeforeUnmount(() => {
  // 页面离开时回放还在跑：按中断处理，批次号与进度留在本地，下次从未验证模块继续。
  if (running.value && runState) {
    interruptReplay(runState.batch)
  }
})
</script>
