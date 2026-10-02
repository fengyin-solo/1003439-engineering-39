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

    <header class="page-head">
      <div>
        <h2>历史回放校验</h2>
        <p class="page-desc">
          读取存储快照，旧版本按字段映射回填后在隔离空间逐模块恢复并核对页面入口；全程不改业务数据，失败不会覆盖上方总览。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" :disabled="running" @click="takeSnapshot()">留存快照</button>
        <button class="btn ghost" type="button" :disabled="running" @click="takeSnapshot(1)">
          留存 v1 旧版快照
        </button>
        <button class="btn primary" type="button" :disabled="running" @click="startReplay">
          开始新回放
        </button>
        <button
          v-if="progress && (progress.status === 'paused' || progress.status === 'failed')"
          class="btn primary"
          type="button"
          :disabled="running"
          @click="continueReplay"
        >
          继续回放
        </button>
        <button v-if="running" class="btn" type="button" @click="pauseReplay">中断回放</button>
      </div>
    </header>

    <p v-if="!snapshots.length" class="page-desc">还没有存储快照，先点「留存快照」留一份再回放。</p>

    <template v-if="progress">
      <p class="status-legend">
        <span class="legend-item">批次号：{{ progress.batchNo }}</span>
        <span class="legend-item">快照：{{ progress.snapshotBatch }}</span>
        <span class="legend-item">状态：{{ statusText[progress.status] }}</span>
        <span class="legend-item">进度：{{ verifiedCount }} / {{ moduleTotal }}</span>
        <span class="legend-item">更新于：{{ progress.updatedAt || '—' }}</span>
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>业务模块</th><th>登记</th><th>待处理</th><th>异常量</th><th>页面入口</th><th>结论</th><th>问题</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in progress.results" :key="row.key">
            <td>{{ row.name }}</td>
            <td>{{ row.created }}</td>
            <td>{{ row.pending }}</td>
            <td>{{ row.abnormal }}</td>
            <td>{{ row.pageEntryOk ? '正常' : '缺失' }}</td>
            <td>{{ row.ok ? '通过' : '失败' }}</td>
            <td>{{ row.problems.join('；') || '—' }}</td>
          </tr>
          <tr v-if="!progress.results.length">
            <td colspan="7" class="empty-state">尚未核对任何模块</td>
          </tr>
        </tbody>
      </table>
    </template>

    <template v-if="ledger.length">
      <h3>处置台账核对记录</h3>
      <table class="data-table">
        <thead>
          <tr><th>批次号</th><th>业务模块</th><th>结果</th><th>核对详情</th><th>入账时间</th></tr>
        </thead>
        <tbody>
          <tr v-for="entry in ledger" :key="entry.id">
            <td>{{ entry.batchNo }}</td>
            <td>{{ entry.moduleName }}</td>
            <td>{{ entry.result === 'passed' ? '核对通过' : '核对失败' }}</td>
            <td>{{ entry.detail }}</td>
            <td>{{ entry.createdAt }}</td>
          </tr>
        </tbody>
      </table>
    </template>

    <footer class="page-foot">
      <span>回放只读快照、只写台账，原模块数据保留供追溯；重复回放不会新增示例数据</span>
      <span v-if="replayError" class="error-text">{{ replayError }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import {
  beginReplay,
  captureSnapshot,
  currentReplay,
  listSnapshots,
  loadLedger,
  requestPauseReplay,
  resumeReplay,
  runReplay,
} from '@/api/replay-service'
import { MODULES } from '@/data/modules'
import type { LedgerEntry, OverviewResult, ReplayProgress, StorageSnapshot } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])

const snapshots = ref<StorageSnapshot[]>([])
const progress = ref<ReplayProgress | null>(null)
const ledger = ref<LedgerEntry[]>([])
const replayError = ref('')
const running = ref(false)

const moduleTotal = MODULES.length
const statusText: Record<ReplayProgress['status'], string> = {
  running: '进行中',
  paused: '已中断',
  failed: '有失败',
  passed: '已通过',
}
const verifiedCount = computed(() => progress.value?.nextIndex ?? 0)

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
}

function refreshReplayState() {
  snapshots.value = listSnapshots()
  progress.value = currentReplay()
  ledger.value = loadLedger().slice(-8).reverse()
}

function takeSnapshot(version?: number) {
  replayError.value = ''
  captureSnapshot(version)
  refreshReplayState()
}

async function startReplay() {
  replayError.value = ''
  try {
    progress.value = beginReplay()
    await run()
  } catch (error) {
    replayError.value = error instanceof Error ? error.message : '回放启动失败'
  }
}

async function continueReplay() {
  replayError.value = ''
  try {
    progress.value = resumeReplay()
    await run()
  } catch (error) {
    replayError.value = error instanceof Error ? error.message : '回放继续失败'
  }
}

async function run() {
  running.value = true
  try {
    progress.value = await runReplay((item) => {
      progress.value = item
    })
  } catch (error) {
    replayError.value = error instanceof Error ? error.message : '回放执行失败'
  } finally {
    running.value = false
    refreshReplayState()
  }
}

function pauseReplay() {
  requestPauseReplay()
}

onMounted(() => {
  refresh()
  refreshReplayState()
})
</script>
