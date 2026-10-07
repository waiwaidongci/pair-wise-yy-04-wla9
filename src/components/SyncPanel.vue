<script setup lang="ts">
import { computed } from 'vue'
import { useSheetStore } from '../stores/sheet'
import { displayValue } from '../utils/cells'
import type { EditOp } from '../types/revision'

const store = useSheetStore()

const recentOps = computed(() => [...store.ops].slice(-15).reverse())

function sessionHue(session: string) {
  let hash = 0
  for (const char of session) hash = (hash * 31 + char.charCodeAt(0)) % 360
  return hash
}

function sessionTag(session: string) {
  return session.slice(0, 4)
}

function sessionColor(session: string) {
  return `hsl(${sessionHue(session)} 65% 42%)`
}

function formatTime(at: number) {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

function opKindLabel(kind: EditOp['kind']) {
  const labels: Record<EditOp['kind'], string> = {
    edit: '编辑',
    resolve: '冲突解决',
    reset: '重置',
    undo: '撤销',
    redo: '重做',
  }
  return labels[kind]
}

function rawPreview(raw: string) {
  return raw === '' ? '（空）' : raw
}

function valueOf(cellId: string) {
  return displayValue(store.cells[cellId]?.value ?? '')
}
</script>

<template>
  <aside v-if="store.showSyncPanel" class="sync-panel">
    <header class="panel-header">
      <strong>协作与修订记录</strong>
      <v-btn size="x-small" variant="text" icon="mdi-close" @click="store.showSyncPanel = false" />
    </header>

    <section class="session-card">
      <div class="session-line">
        <span class="dot" :style="{ background: sessionColor(store.sessionId) }" />
        本会话 <code>{{ sessionTag(store.sessionId) }}</code>
        <span class="muted">版本 v{{ store.version }} · 操作号 #{{ store.localSeq }}</span>
      </div>
      <div class="session-line muted">
        <v-icon size="13" :icon="store.recalcBusy ? 'mdi-loading mdi-spin' : 'mdi-check-circle-outline'" />
        {{ store.recalcBusy ? '公式链重算中…' : '重算已提交' }} · 日志共 {{ store.ops.length }} 条操作
      </div>
    </section>

    <section v-if="store.conflicts.length" class="panel-section">
      <div class="section-title conflict-title">
        <v-icon size="14" icon="mdi-alert-outline" />
        同格冲突待选（{{ store.conflicts.length }}）
      </div>
      <div v-for="conflict in store.conflicts" :key="conflict.cellId" class="conflict-card">
        <div class="conflict-head">
          <code>{{ conflict.cellId }}</code>
          <span class="muted">当前值 {{ valueOf(conflict.cellId) || '—' }}</span>
        </div>
        <div class="conflict-sides">
          <div class="side">
            <div class="side-tag" :style="{ color: sessionColor(conflict.mine.sessionId) }">
              我的 · {{ sessionTag(conflict.mine.sessionId) }}
            </div>
            <div class="side-raw">{{ rawPreview(conflict.mine.raw) }}</div>
            <v-btn size="x-small" variant="tonal" color="primary" @click="store.resolveConflict(conflict.cellId, 'mine')">
              保留我的
            </v-btn>
          </div>
          <div class="side">
            <div class="side-tag" :style="{ color: sessionColor(conflict.theirs.sessionId) }">
              对方 · {{ sessionTag(conflict.theirs.sessionId) }}
            </div>
            <div class="side-raw">{{ rawPreview(conflict.theirs.raw) }}</div>
            <v-btn size="x-small" variant="tonal" color="warning" @click="store.resolveConflict(conflict.cellId, 'theirs')">
              采用对方
            </v-btn>
          </div>
        </div>
      </div>
    </section>

    <section class="panel-section">
      <div class="section-title">修订记录（最近 {{ recentOps.length }} 条）</div>
      <div v-if="!recentOps.length" class="muted empty">还没有操作，编辑任意单元格即产生修订</div>
      <div v-for="op in recentOps" :key="op.id" class="op-row">
        <span class="dot" :style="{ background: sessionColor(op.sessionId) }" />
        <div class="op-main">
          <div>
            <code>#{{ op.seq }}</code>
            <span class="muted"> 会话 {{ sessionTag(op.sessionId) }} · 基线 v{{ op.baseVersion }}</span>
          </div>
          <div class="muted">
            {{ opKindLabel(op.kind) }} {{ Object.keys(op.changes).length }} 格：
            {{ Object.keys(op.changes).slice(0, 4).join('、') }}{{ Object.keys(op.changes).length > 4 ? '…' : '' }}
          </div>
        </div>
        <span class="muted op-time">{{ formatTime(op.at) }}</span>
      </div>
    </section>
  </aside>
</template>

<style scoped>
.sync-panel {
  position: absolute;
  z-index: 30;
  top: 8px;
  right: 8px;
  bottom: 8px;
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  overflow-y: auto;
  border: 1px solid #cfd8e4;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 10px 32px rgba(23, 35, 59, .16);
}
.panel-header { display: flex; align-items: center; justify-content: space-between; font-size: 13px; }
.session-card { padding: 8px 10px; border-radius: 6px; background: #f4f7fb; font-size: 11px; }
.session-line { display: flex; align-items: center; gap: 6px; line-height: 1.9; }
.dot { width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; }
.muted { color: #718096; }
.panel-section { display: flex; flex-direction: column; gap: 8px; }
.section-title { font-size: 12px; font-weight: 700; color: #334155; }
.conflict-title { display: flex; align-items: center; gap: 4px; color: #b45309; }
.conflict-card { padding: 8px; border: 1px solid #f0c987; border-radius: 6px; background: #fffaf0; }
.conflict-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 11px; }
.conflict-head code { font-weight: 700; color: #b45309; }
.conflict-sides { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.side { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 5px; background: #fff; border: 1px solid #eee2c8; }
.side-tag { font-size: 10px; font-weight: 700; }
.side-raw { min-height: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px ui-monospace, monospace; color: #1f2937; }
.op-row { display: flex; align-items: flex-start; gap: 6px; padding: 5px 2px; border-bottom: 1px dashed #e5eaf0; font-size: 11px; }
.op-row .dot { margin-top: 5px; }
.op-main { flex: 1; min-width: 0; }
.op-time { flex: 0 0 auto; font-size: 10px; }
.empty { padding: 8px 0; font-size: 11px; }
code { font-family: ui-monospace, monospace; }
</style>
