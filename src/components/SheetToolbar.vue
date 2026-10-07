<script setup lang="ts">
import { computed } from 'vue'
import { useSheetStore } from '../stores/sheet'
import { columnLabel } from '../utils/cells'

const store = useSheetStore()
const activeLabel = computed(() => `${columnLabel(store.active.col)}${store.active.row + 1}`)

function openInNewTab() {
  window.open(window.location.href, '_blank')
}
</script>

<template>
  <div class="sheet-toolbar">
    <div class="toolbar-left">
      <v-btn size="small" variant="text" prepend-icon="mdi-undo" :disabled="!store.canUndo" @click="store.undo">撤销</v-btn>
      <v-btn size="small" variant="text" prepend-icon="mdi-redo" :disabled="!store.canRedo" @click="store.redo">重做</v-btn>
      <v-divider vertical class="mx-2" />
      <v-btn-toggle
        :model-value="store.freezeRows"
        density="compact"
        variant="outlined"
        @update:model-value="store.freezeRows = Number($event)"
      >
        <v-btn :value="0" size="small">不冻结行</v-btn>
        <v-btn :value="1" size="small">冻结首行</v-btn>
      </v-btn-toggle>
      <v-btn-toggle
        :model-value="store.freezeCols"
        density="compact"
        variant="outlined"
        @update:model-value="store.freezeCols = Number($event)"
      >
        <v-btn :value="0" size="small">不冻结列</v-btn>
        <v-btn :value="1" size="small">冻结首列</v-btn>
      </v-btn-toggle>
      <v-btn size="small" variant="text" prepend-icon="mdi-delete-outline" @click="store.clearSelection">清除内容</v-btn>
    </div>
    <div class="toolbar-right">
      <span class="session-badge" title="会话号 / 当前版本">
        <v-icon size="12" icon="mdi-account" />{{ store.sessionShort }} · v{{ store.version }}
      </span>
      <span v-if="store.recalcBusy" class="recalc-hint">
        <v-icon size="12" icon="mdi-loading mdi-spin" />重算中
      </span>
      <span class="active-badge">{{ activeLabel }}</span>
      <span class="muted">{{ store.status }}</span>
      <v-btn size="small" variant="text" prepend-icon="mdi-open-in-new" @click="openInNewTab">新标签页</v-btn>
      <v-btn size="small" variant="text" prepend-icon="mdi-source-branch-sync" @click="store.showSyncPanel = !store.showSyncPanel">
        协作
        <v-badge v-if="store.conflicts.length" color="error" :content="store.conflicts.length" inline />
      </v-btn>
      <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="store.reset">重置</v-btn>
      <v-btn size="small" color="primary" variant="flat" prepend-icon="mdi-download" @click="store.exportCsv">导出 CSV</v-btn>
    </div>
  </div>
</template>

<style scoped>
.sheet-toolbar {
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  border-bottom: 1px solid #dce3ec;
  background: #fff;
}
.toolbar-left, .toolbar-right { display: flex; align-items: center; gap: 6px; min-width: 0; }
.active-badge { padding: 4px 8px; border-radius: 5px; color: #1d4ed8; background: #eaf2ff; font: 700 12px ui-monospace, monospace; }
.session-badge { display: inline-flex; align-items: center; gap: 3px; padding: 4px 8px; border-radius: 5px; color: #0f766e; background: #ecfdf5; font: 700 11px ui-monospace, monospace; white-space: nowrap; }
.recalc-hint { display: inline-flex; align-items: center; gap: 3px; color: #b45309; font-size: 11px; white-space: nowrap; }
.muted { color: #718096; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
</style>
