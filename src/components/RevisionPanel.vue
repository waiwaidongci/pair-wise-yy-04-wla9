<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useSheetStore } from '../stores/sheet'

const store = useSheetStore()
const { opLog, conflicts, vv, baseVV, sessionId, localSeq, recalcGeneration, recalcState, dirtyCount, revisionPanelOpen } = storeToRefs(store)

const recentOps = computed(() => [...opLog.value].reverse().slice(0, 30))

function shortSid(sid: string): string {
  return sid ? `${sid.slice(0, 4)}…${sid.slice(-3)}` : '（未加入）'
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function vvEntries(v: Record<string, number>): Array<[string, number]> {
  return Object.entries(v).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

const recalcStateText = computed(() => ({
  idle: '空闲',
  running: '重算中',
  retrying: '重试中',
  failed: '已保留上次有效值',
}[recalcState.value]))

function reload() {
  window.location.reload()
}
</script>

<template>
  <aside class="revision-panel" :class="{ open: revisionPanelOpen }">
    <div class="panel-header">
      <strong>修订记录</strong>
      <v-btn icon size="x-small" variant="text" @click="store.toggleRevisionPanel">
        <v-icon>mdi-close</v-icon>
      </v-btn>
    </div>

    <div class="panel-body">
      <section>
        <h4>本页会话</h4>
        <div class="kv"><span>会话号</span><code>{{ shortSid(sessionId) }}</code></div>
        <div class="kv"><span>基线版本</span><code class="vv-code">{{ vvEntries(baseVV).map(([k, v]) => `${shortSid(k)}:${v}`).join(' ') || '∅' }}</code></div>
        <div class="kv"><span>操作号</span><code>{{ localSeq }}</code></div>
        <h4>版本向量（当前）</h4>
        <div class="vv-chips">
          <span v-for="[sid, seq] in vvEntries(vv)" :key="sid" class="vv-chip">
            {{ shortSid(sid) }}<b>:{{ seq }}</b>
          </span>
          <span v-if="!vvEntries(vv).length" class="empty">∅</span>
        </div>
      </section>

      <section>
        <h4>公式重算</h4>
        <div class="kv"><span>批次</span><code>#{{ recalcGeneration }}</code></div>
        <div class="kv">
          <span>状态</span>
          <span class="recalc-state" :class="recalcState">{{ recalcStateText }}</span>
        </div>
        <div class="kv"><span>待重算</span><code>{{ dirtyCount }}</code></div>
        <p class="hint">新编辑会作废旧批次（世代围栏）；失败重试，仍失败则保留上次有效值。</p>
      </section>

      <section>
        <h4>冲突（同格两版待选）</h4>
        <div v-if="!conflicts.length" class="empty">无冲突 · 不同单元格直接合并</div>
        <div v-for="c in conflicts" :key="c.cellId" class="conflict">
          <div class="conflict-cell">{{ c.cellId }}</div>
          <div v-for="ver in c.versions" :key="ver.opId" class="version">
            <div class="version-meta">
              <span class="sid">{{ shortSid(ver.sessionId) }}</span>
              <span>·</span>
              <span>{{ formatTime(ver.timestamp) }}</span>
              <span>·</span>
              <code>{{ ver.opId }}</code>
            </div>
            <code class="version-raw">{{ ver.raw || '（空）' }}</code>
            <v-btn size="x-small" variant="outlined" color="primary" @click="store.selectVersion(c.cellId, ver.opId)">采用此版</v-btn>
          </div>
        </div>
      </section>

      <section>
        <h4>操作日志</h4>
        <div class="log">
          <div v-for="op in recentOps" :key="op.opId" class="log-item">
            <code class="log-op">{{ op.opId }}</code>
            <span class="log-cell">{{ op.cellId }}</span>
            <code class="log-raw">{{ op.raw || '∅' }}</code>
          </div>
          <div v-if="!recentOps.length" class="empty">暂无操作</div>
        </div>
      </section>

      <section class="panel-actions">
        <v-btn size="small" variant="outlined" prepend-icon="mdi-open-in-new" @click="store.openSessionTab">新标签页打开会话 B</v-btn>
        <v-btn size="small" variant="outlined" prepend-icon="mdi-playlist-check" @click="store.replayAll">回放日志（幂等）</v-btn>
        <v-btn size="small" variant="outlined" prepend-icon="mdi-reload" @click="reload">重新加载并回放</v-btn>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.revision-panel {
  position: fixed;
  top: 60px;
  right: 0;
  bottom: 0;
  width: 360px;
  z-index: 30;
  background: #fff;
  border-left: 1px solid #dce3ec;
  box-shadow: -4px 0 16px rgba(23, 35, 59, 0.08);
  transform: translateX(100%);
  transition: transform 0.18s ease;
  display: flex;
  flex-direction: column;
}
.revision-panel.open { transform: translateX(0); }
.panel-header {
  height: 44px;
  flex: 0 0 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid #eef2f7;
  color: #17233b;
}
.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
section h4 {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 700;
  color: #59677a;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.kv {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
  color: #334155;
}
.kv code { font-family: ui-monospace, monospace; font-size: 11px; color: #1d4ed8; }
.vv-code { max-width: 200px; text-align: right; word-break: break-all; }
.vv-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.vv-chip {
  padding: 2px 7px;
  border-radius: 10px;
  background: #eef2f7;
  color: #59677a;
  font-size: 11px;
  font-family: ui-monospace, monospace;
}
.vv-chip b { color: #1d4ed8; }
.recalc-state { font-size: 11px; font-weight: 700; }
.recalc-state.running { color: #2563eb; }
.recalc-state.retrying { color: #d97706; }
.recalc-state.failed { color: #dc2626; }
.hint { margin: 6px 0 0; font-size: 10px; color: #94a3b8; line-height: 1.5; }
.empty { font-size: 11px; color: #94a3b8; padding: 4px 0; }
.conflict {
  border: 1px solid #fecaca;
  border-radius: 6px;
  background: #fef2f2;
  padding: 8px;
  margin-bottom: 8px;
}
.conflict-cell { font-family: ui-monospace, monospace; font-weight: 700; color: #b91c1c; font-size: 12px; margin-bottom: 6px; }
.version {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 0;
  border-top: 1px dashed #fecaca;
}
.version-meta { display: flex; gap: 6px; align-items: center; font-size: 10px; color: #7f1d1d; }
.version-meta code { font-family: ui-monospace, monospace; }
.sid { font-weight: 700; }
.version-raw {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: #1f2937;
  background: #fff;
  border: 1px solid #fecaca;
  border-radius: 4px;
  padding: 3px 6px;
  word-break: break-all;
}
.log { display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow-y: auto; }
.log-item { display: flex; gap: 6px; align-items: center; font-size: 10px; padding: 2px 0; border-bottom: 1px solid #f1f5f9; }
.log-op { font-family: ui-monospace, monospace; color: #64748b; }
.log-cell { font-family: ui-monospace, monospace; color: #1d4ed8; font-weight: 700; }
.log-raw { font-family: ui-monospace, monospace; color: #334155; margin-left: auto; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel-actions { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid #eef2f7; }
</style>
