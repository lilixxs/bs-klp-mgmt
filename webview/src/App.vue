<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useEditor } from './composables/editor';
import type { TabId } from './composables/editor';
import { baseName } from './composables/names';
import { formatTime, severityLabel } from './composables/format';
import VariableEditor from './components/VariableEditor.vue';
import ProgramEditor from './components/ProgramEditor.vue';
import CommEditor from './components/CommEditor.vue';
import ProjectEditor from './components/ProjectEditor.vue';
import DiagnosticsView from './components/DiagnosticsView.vue';

const { state, ops, notices, activeTab, start, save, discard, reload, dismissNotice } = useEditor();

onMounted(start);

const snapshot = computed(() => state.value?.snapshot ?? null);
const busy = computed(() => state.value?.busy === true);
const dirtyCount = computed(() => ops.value.length);

const diagnostics = computed(() => state.value?.plan.diagnostics ?? []);
const errorCount = computed(() => diagnostics.value.filter((item) => item.severity === 'error').length);
const warningCount = computed(() => diagnostics.value.filter((item) => item.severity === 'warning').length);

const deviceText = computed(() => {
  const devices = snapshot.value?.project.devices ?? [];
  if (devices.length === 0) return '无设备';
  return devices.map((item) => (item.dataDir ? `${item.name} · ${item.dataDir}` : item.name)).join('，');
});

const tabs = computed<Array<{ id: TabId; label: string }>>(() => [
  { id: 'variables', label: '变量' },
  { id: 'programs', label: '程序' },
  { id: 'comm', label: '通讯' },
  { id: 'project', label: '项目' },
  { id: 'diagnostics', label: '诊断' },
]);

const canSave = computed(() => {
  const current = state.value;
  if (!current || current.busy) return false;
  return current.plan.canSave && ops.value.length > 0;
});

const saveHint = computed(() => {
  const current = state.value;
  if (!current) return '尚未收到宿主数据';
  if (current.busy) return '宿主正忙';
  if (!current.plan.canSave) return '保存计划存在错误，见「诊断」标签';
  if (ops.value.length === 0) return '没有未保存的修改';
  return '写入数据库与 .stf 文件';
});

const statusText = computed(() => {
  const current = state.value;
  if (!current) return '等待宿主数据';
  if (current.busy) return current.busyMessage ?? '处理中…';
  return '就绪';
});
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="identity">
        <h1>{{ snapshot?.project.name ?? 'KLP 编辑器' }}</h1>
        <p class="meta">
          <template v-if="snapshot">
            <span>入口 <span class="mono">{{ baseName(snapshot.entryPath) }}</span></span>
            <span>格式 {{ snapshot.project.version || '—' }}</span>
            <span>IDE {{ snapshot.project.ideVersion || '—' }}</span>
            <span>设备 {{ deviceText }}</span>
          </template>
          <span v-else>在命令面板执行「KLP: 打开项目」，选择 *.mgp 入口文件。</span>
        </p>
      </div>

      <div class="actions">
        <span class="badge" :class="{ active: dirtyCount > 0 }" :title="`草稿操作数 ${dirtyCount}`">
          {{ dirtyCount }} 项未保存
        </span>
        <button type="button" class="btn btn-primary" :disabled="!canSave" :title="saveHint" @click="save">
          保存
        </button>
        <button
          type="button"
          class="btn"
          :disabled="busy || !state || dirtyCount === 0"
          title="丢弃所有未保存的修改"
          @click="discard"
        >
          放弃修改
        </button>
        <button type="button" class="btn" :disabled="busy || !state" title="重新读取工程" @click="reload">
          重新加载
        </button>
      </div>
    </header>

    <nav v-if="state" class="tabs" role="tablist" aria-label="编辑器标签">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        class="tab"
        :class="{ active: activeTab === tab.id }"
        :aria-selected="activeTab === tab.id"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
        <span v-if="tab.id === 'diagnostics' && (errorCount > 0 || warningCount > 0)" class="tab-badges">
          <span v-if="errorCount > 0" class="chip error">{{ errorCount }}</span>
          <span v-if="warningCount > 0" class="chip warn">{{ warningCount }}</span>
        </span>
      </button>
    </nav>

    <main class="content">
      <div v-if="!state" class="empty">
        <p>等待宿主推送 {{ '{' }} type: 'state' {{ '}' }} 消息。</p>
        <p class="hint">页面只负责展示与生成草稿，不直接读写工程文件。</p>
      </div>
      <template v-else>
        <VariableEditor v-if="activeTab === 'variables'" />
        <ProgramEditor v-else-if="activeTab === 'programs'" />
        <CommEditor v-else-if="activeTab === 'comm'" />
        <ProjectEditor v-else-if="activeTab === 'project'" />
        <DiagnosticsView v-else />
      </template>
    </main>

    <footer class="statusbar">
      <span class="status-dot" :class="{ busy }" aria-hidden="true"></span>
      <span>{{ statusText }}</span>
      <span class="spacer"></span>
      <span v-if="state">加载于 {{ formatTime(state.snapshot.loadedAt) }} · 草稿 {{ dirtyCount }} 项</span>
      <span v-else>未连接</span>
    </footer>

    <div class="notices" aria-live="polite">
      <div v-for="notice in notices" :key="notice.id" class="notice" :class="notice.severity">
        <span class="notice-severity">{{ severityLabel[notice.severity] }}</span>
        <span class="notice-message">{{ notice.message }}</span>
        <button type="button" class="btn btn-icon" aria-label="关闭提示" @click="dismissNotice(notice.id)">×</button>
      </div>
    </div>
  </div>
</template>
