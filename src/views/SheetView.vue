<script setup lang="ts">
import { computed } from 'vue'
import FormulaBar from '../components/FormulaBar.vue'
import RevisionPanel from '../components/RevisionPanel.vue'
import SheetGrid from '../components/SheetGrid.vue'
import SheetToolbar from '../components/SheetToolbar.vue'
import { useSheetStore } from '../stores/sheet'

const store = useSheetStore()
const shortSession = computed(() => (store.sessionId ? `${store.sessionId.slice(0, 4)}…${store.sessionId.slice(-3)}` : '—'))
const recalcActive = computed(() => store.recalcState === 'running' || store.recalcState === 'retrying')
</script>

<template>
  <div class="sheet-page">
    <header class="app-header">
      <div class="brand">
        <div class="brand-mark">Σ</div>
        <div>
          <strong>GridFormula</strong>
          <span>在线经营数据公式表 · 修订合并版</span>
        </div>
      </div>
      <div class="header-meta">
        <span>工作簿：季度销售分析</span>
        <span>会话：{{ shortSession }}</span>
        <span>操作号：{{ store.localSeq }}</span>
        <span>重算批次：#{{ store.recalcGeneration }}</span>
        <span>待重算：{{ store.dirtyCount }}</span>
      </div>
    </header>
    <div class="recalc-bar" :class="{ active: recalcActive }">
      <div class="recalc-bar-inner" :class="{ retrying: store.recalcState === 'retrying' }" />
    </div>
    <SheetToolbar />
    <FormulaBar />
    <main class="sheet-main"><SheetGrid /></main>
    <RevisionPanel />
    <footer class="sheet-status">
      <span>方向键导航 · Shift+方向键扩展选区 · Ctrl/Cmd+C/V 复制粘贴 · F2 编辑</span>
      <span>两标签页同格编辑 → 两版待选；不同单元格直接合并；旧重算批次自动作废</span>
      <strong>{{ store.status }}</strong>
    </footer>
  </div>
</template>

<style scoped>
.sheet-page { height: 100%; display: flex; flex-direction: column; background: #eef2f7; }
.app-header { height: 60px; flex: 0 0 60px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; color: #fff; background: #17233b; }
.brand { display: flex; align-items: center; gap: 10px; }
.brand-mark { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 8px; background: #2563eb; font-size: 20px; font-weight: 800; }
.brand strong { display: block; font-size: 16px; }
.brand span, .header-meta { color: #a9b7cb; font-size: 11px; }
.header-meta { display: flex; gap: 18px; }
.recalc-bar { height: 3px; flex: 0 0 3px; background: transparent; overflow: hidden; }
.recalc-bar.active { background: #eef2f7; }
.recalc-bar-inner { height: 100%; width: 40%; background: #2563eb; animation: recalc-slide 0.9s ease-in-out infinite; }
.recalc-bar-inner.retrying { background: #d97706; animation-duration: 0.5s; }
@keyframes recalc-slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(350%); }
}
.sheet-main { flex: 1; min-height: 0; margin: 9px 9px 0; border: 1px solid #cfd8e4; border-radius: 6px; overflow: hidden; background: #fff; }
.sheet-status { height: 30px; flex: 0 0 30px; display: flex; align-items: center; gap: 22px; padding: 0 12px; color: #66758a; font-size: 10px; }
.sheet-status strong { margin-left: auto; color: #2563eb; }
</style>
