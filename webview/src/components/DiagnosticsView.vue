<script setup lang="ts">
import { computed } from 'vue';
import type { Severity } from '../../../src/shared/types';
import { useEditor } from '../composables/editor';
import { severityLabel } from '../composables/format';

const { state } = useEditor();

const severityRank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

const diagnostics = computed(() => {
  const list = [...(state.value?.plan.diagnostics ?? [])];
  return list.sort((a, b) => {
    const rank = severityRank[a.severity] - severityRank[b.severity];
    return rank !== 0 ? rank : a.code.localeCompare(b.code);
  });
});

const counts = computed(() => {
  const result = { error: 0, warning: 0, info: 0 };
  for (const item of diagnostics.value) result[item.severity] += 1;
  return result;
});

const summary = computed(() => state.value?.plan.summary ?? []);
const canSave = computed(() => state.value?.plan.canSave ?? false);
const planned = computed(() => {
  const plan = state.value?.plan;
  if (!plan) return null;
  return {
    dbOps: plan.dbOps.length,
    programWrites: plan.programWrites.length,
    programDeletes: plan.programDeletes.length,
    rename: plan.projectRename?.newName ?? '',
  };
});
</script>

<template>
  <section class="pane">
    <div class="toolbar">
      <span class="chip" :class="counts.error > 0 ? 'error' : 'ok'">错误 {{ counts.error }}</span>
      <span class="chip" :class="counts.warning > 0 ? 'warn' : 'ok'">警告 {{ counts.warning }}</span>
      <span class="chip">提示 {{ counts.info }}</span>
      <span class="spacer"></span>
      <span class="chip" :class="canSave ? 'ok' : 'error'">{{ canSave ? '可以保存' : '不能保存' }}</span>
    </div>

    <div v-if="planned" class="toolbar wrap">
      <span class="muted">数据库操作 {{ planned.dbOps }}</span>
      <span class="muted">程序写入 {{ planned.programWrites }}</span>
      <span class="muted">程序删除 {{ planned.programDeletes }}</span>
      <span v-if="planned.rename" class="muted">工程改名 → {{ planned.rename }}</span>
    </div>

    <article class="card">
      <h2>诊断</h2>
      <ul v-if="diagnostics.length > 0" class="diag-list">
        <li v-for="(item, index) in diagnostics" :key="`${item.code}-${index}`" :class="['diag', item.severity]">
          <span class="diag-severity">{{ severityLabel[item.severity] }}</span>
          <span class="diag-code mono">{{ item.code }}</span>
          <span class="diag-message">{{ item.message }}</span>
          <span v-if="item.target" class="diag-target mono" :title="item.target">{{ item.target }}</span>
        </li>
      </ul>
      <p v-else class="empty-cell">没有诊断信息。</p>
    </article>

    <article class="card">
      <h2>保存将执行的操作</h2>
      <ol v-if="summary.length > 0" class="summary-list">
        <li v-for="(line, index) in summary" :key="index">{{ line }}</li>
      </ol>
      <p v-else class="empty-cell">当前草稿不产生任何操作。</p>
    </article>
  </section>
</template>
