<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useEditor } from '../composables/editor';
import { draftProjectRename, setProjectRename } from '../composables/draftOps';
import { baseName } from '../composables/names';

const { state, ops, commitOps } = useEditor();

const snapshot = computed(() => state.value?.snapshot ?? null);
const currentName = computed(() => snapshot.value?.project.name ?? '');
const plannedRename = computed(() => state.value?.plan.projectRename);
const currentRename = computed(() => draftProjectRename(ops.value));
const newName = ref('');

watch(
  currentRename,
  (value) => {
    newName.value = value ?? '';
  },
  { immediate: true },
);

const problem = computed(() => {
  const value = newName.value.trim();
  if (!value) return '请输入新工程名。';
  if (value === currentName.value) return '与当前工程名相同。';
  if (/[\\/:*?"<>|]/.test(value)) return '工程名不能包含 \\ / : * ? " < > | 。';
  if (/[. ]$/.test(value)) return '工程名不能以点或空格结尾。';
  if (value.length > 100) return '工程名过长。';
  return '';
});

function applyRename(): void {
  if (problem.value) return;
  commitOps(setProjectRename(ops.value, newName.value));
}

function clearRename(): void {
  commitOps(setProjectRename(ops.value, ''));
}
</script>

<template>
  <section class="pane">
    <div v-if="!snapshot" class="empty">
      <p>尚未收到工程快照。</p>
    </div>

    <template v-else>
      <div class="cards">
        <article class="card">
          <h2>工程</h2>
          <dl class="kv">
            <dt>工程名</dt>
            <dd class="mono">{{ snapshot.project.name }}</dd>
            <dt>格式版本</dt>
            <dd>{{ snapshot.project.version || '—' }}</dd>
            <dt>IDE 版本</dt>
            <dd>{{ snapshot.project.ideVersion || '—' }}</dd>
            <dt>说明</dt>
            <dd>{{ snapshot.project.description || '—' }}</dd>
          </dl>
        </article>

        <article class="card">
          <h2>文件</h2>
          <dl class="kv">
            <dt>工程目录</dt>
            <dd class="mono path" :title="snapshot.projectDir">{{ snapshot.projectDir }}</dd>
            <dt>入口 .mgp</dt>
            <dd class="mono path" :title="snapshot.entryPath">{{ baseName(snapshot.entryPath) }}</dd>
            <dt>数据库</dt>
            <dd class="mono path" :title="snapshot.dbPath ?? ''">{{ snapshot.dbPath ?? '未读取' }}</dd>
            <dt>数据库内名</dt>
            <dd class="mono">{{ snapshot.db?.dbProjectName ?? '—' }}</dd>
          </dl>
        </article>
      </div>

      <article class="card">
        <h2>设备目录</h2>
        <p class="hint">工程改名只改目录名与 .mgp 文件名，<strong>不改 DataDir</strong>，也不改设备目录里的内容。</p>
        <table class="grid">
          <thead>
            <tr>
              <th scope="col">设备</th>
              <th scope="col">ID</th>
              <th scope="col">DataDir</th>
              <th scope="col">目录路径</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="device in snapshot.devices" :key="device.deviceName">
              <td class="mono">{{ device.deviceName }}</td>
              <td>
                {{ snapshot.project.devices.find((item) => item.name === device.deviceName)?.id ?? '—' }}
              </td>
              <td class="mono">{{ device.dataDir ?? '未声明' }}</td>
              <td class="mono path" :title="device.dataDirPath ?? ''">{{ device.dataDirPath ?? '—' }}</td>
            </tr>
            <tr v-if="snapshot.devices.length === 0">
              <td class="empty-cell" colspan="4">工程没有设备。</td>
            </tr>
          </tbody>
        </table>
      </article>

      <article class="card">
        <h2>工程改名</h2>
        <div class="rename-row">
          <label for="project-new-name">新工程名</label>
          <input
            id="project-new-name"
            v-model="newName"
            class="input"
            type="text"
            autocomplete="off"
            :placeholder="currentName"
          />
          <button type="button" class="btn btn-primary" :disabled="problem !== ''" @click="applyRename">改名</button>
          <button v-if="currentRename !== undefined" type="button" class="btn" @click="clearRename">撤销改名</button>
        </div>
        <p v-if="newName.trim() !== '' && problem" class="hint warn">{{ problem }}</p>
        <p v-else class="hint">改名会同时改工程目录与入口文件名；已有改动会在保存时一起执行。</p>

        <div v-if="currentRename !== undefined" class="plan-box">
          <p>草稿中的改名：<span class="mono">{{ currentName }}</span> → <span class="mono">{{ currentRename }}</span></p>
          <dl v-if="plannedRename" class="kv">
            <dt>目录</dt>
            <dd class="mono path">{{ plannedRename.fromDir }} → {{ plannedRename.toDir }}</dd>
            <dt>入口</dt>
            <dd class="mono path">{{ baseName(plannedRename.fromEntry) }} → {{ baseName(plannedRename.toEntry) }}</dd>
          </dl>
        </div>
      </article>
    </template>
  </section>
</template>
