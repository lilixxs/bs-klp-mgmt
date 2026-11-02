<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { EntityRef, ProgramInput, ProgramRecord, ProgramSource } from '../../../src/shared/types';
import { useEditor } from '../composables/editor';
import {
  addOpRefs,
  bindEffectiveRows,
  deleteProgramDraft,
  draftProgramInput,
  hasEntityDraft,
  newTempId,
  refKey,
  sameRef,
  setProgramDraft,
} from '../composables/draftOps';
import type { BoundRow } from '../composables/draftOps';
import { baseName, buildSourceIndex } from '../composables/names';
import DraftForm from './DraftForm.vue';
import ConfirmDialog from './ConfirmDialog.vue';

interface ProgramEntry extends BoundRow<ProgramRecord> {
  source?: ProgramSource;
}

const { state, ops, commitOps, openProgram } = useEditor();

const db = computed(() => state.value?.snapshot.db);

const entries = computed<ProgramEntry[]>(() => {
  const current = state.value;
  if (!current) return [];
  const existingIds = new Set((current.snapshot.db?.programs ?? []).map((item) => item.id));
  const bound = bindEffectiveRows(current.plan.effective.programs, existingIds, addOpRefs(ops.value, 'program'));
  const sourceIndex = buildSourceIndex(current.snapshot.devices);
  return bound.map((item) => ({ ...item, source: sourceIndex.get(item.row.name.toLowerCase()) }));
});

const selected = ref<EntityRef | null>(null);
const selectedEntry = computed<ProgramEntry | null>(
  () => entries.value.find((item) => item.target !== null && sameRef(item.target, selected.value)) ?? null,
);

const form = reactive({ name: '', comment: '' });
const writeNote = ref('');
const pendingDelete = ref<ProgramEntry | null>(null);
const creating = ref(false);
const newProgram = reactive({ name: '', comment: '' });
const newProgramNote = ref('');

const stLanguageId = computed(() => {
  const languages = db.value?.languages ?? [];
  return languages.find((language) => language.name.toUpperCase() === 'ST')?.id ?? -1;
});

const baseValues = computed(() => {
  const entry = selectedEntry.value;
  if (!entry) return null;
  const draft = entry.target ? draftProgramInput(ops.value, entry.target) : undefined;
  return {
    name: draft?.name ?? entry.row.name,
    comment: draft?.comment ?? entry.row.comment,
  };
});

const baseSignature = computed(() => {
  const base = baseValues.value;
  return base ? JSON.stringify(base) : '';
});

const dirty = computed(() => {
  const base = baseValues.value;
  if (!base) return false;
  return form.name.trim() !== base.name || form.comment.trim() !== base.comment;
});

const stCapable = computed(() => selectedEntry.value?.row.languageId === stLanguageId.value);
const sourceMissing = computed(() => {
  const entry = selectedEntry.value;
  if (!entry) return false;
  return !entry.source || entry.source.missing;
});
const sourcePath = computed(() => selectedEntry.value?.source?.path ?? '');
const sourceEncoding = computed(() => selectedEntry.value?.source?.encoding ?? '');
const languageText = computed(() => {
  const entry = selectedEntry.value;
  if (!entry) return '';
  return db.value?.languages.find((item) => item.id === entry.row.languageId)?.name ?? `languageId=${entry.row.languageId}`;
});
const canOpenInEditor = computed(() => Boolean(selectedEntry.value?.target && sourcePath.value && !sourceMissing.value));

function loadBase(): void {
  const base = baseValues.value;
  if (!base) {
    Object.assign(form, { name: '', comment: '' });
    return;
  }
  Object.assign(form, base);
}

watch(baseSignature, loadBase, { immediate: true });
watch(
  () => refKey(selected.value),
  () => {
    writeNote.value = '';
  },
);

function isDirtyEntry(item: ProgramEntry): boolean {
  return hasEntityDraft(ops.value, 'program', item.target);
}

function select(item: ProgramEntry): void {
  if (!item.target) return;
  if (!sameRef(selected.value, item.target) && dirty.value) {
    writeNote.value = '切换程序：上一份未写入草稿的名称/注释修改已丢弃。';
  }
  selected.value = item.target;
}

function writeDraft(): void {
  const entry = selectedEntry.value;
  if (!entry?.target || !stCapable.value) return;
  const name = form.name.trim();
  if (!name) {
    writeNote.value = '名称不能为空。';
    return;
  }
  const input: ProgramInput = {
    name,
    comment: form.comment.trim(),
    languageId: entry.row.languageId,
    resourceId: entry.row.resourceId,
  };
  commitOps(setProgramDraft(ops.value, entry.target, input));
  writeNote.value = '已写入草稿；点顶部「保存」后才会写入数据库，并同步移动 .stf 文件。';
}

function openInEditor(): void {
  const entry = selectedEntry.value;
  if (!entry?.target || entry.target.kind !== 'existing') {
    writeNote.value = '先保存新增程序，才能在编辑器中打开。';
    return;
  }
  openProgram(entry.target.id);
}

function askDelete(item: ProgramEntry): void {
  if (!item.target) return;
  pendingDelete.value = item;
}

const deleteMessage = computed(() => {
  const entry = pendingDelete.value;
  if (!entry) return '';
  if (entry.target?.kind === 'new') return `撤销新增的程序「${entry.row.name}」？`;
  return `删除程序「${entry.row.name}」？`;
});

const deleteDetail = computed(() => {
  const entry = pendingDelete.value;
  if (entry && entry.row.languageId !== stLanguageId.value) {
    return '非 ST 程序：其源文件不由本插件处理，删除只影响数据库记录。';
  }
  return '只生成草稿操作；点「保存」后才写入数据库并删除 .stf 文件。';
});

function confirmDelete(): void {
  const entry = pendingDelete.value;
  pendingDelete.value = null;
  if (!entry?.target) return;
  if (sameRef(selected.value, entry.target)) selected.value = null;
  commitOps(deleteProgramDraft(ops.value, entry.target));
}

function openCreate(): void {
  newProgram.name = '';
  newProgram.comment = '';
  newProgramNote.value = '';
  creating.value = true;
}

function submitCreate(): void {
  const name = newProgram.name.trim();
  if (!name) {
    newProgramNote.value = '名称不能为空。';
    return;
  }
  const duplicated = entries.value.some((item) => item.row.name === name);
  if (duplicated) {
    newProgramNote.value = '已存在同名程序，请换一个名称。';
    return;
  }
  const input: ProgramInput = {
    name,
    comment: newProgram.comment.trim(),
    languageId: stLanguageId.value,
    resourceId: db.value?.resources[0]?.id ?? 0,
  };
  commitOps(setProgramDraft(ops.value, { kind: 'new', tempId: newTempId('program') }, input));
  creating.value = false;
}
</script>

<template>
  <section class="pane">
    <div class="toolbar">
      <span class="muted">共 {{ entries.length }} 个程序</span>
      <span class="spacer"></span>
      <button type="button" class="btn btn-primary" :disabled="!db" @click="openCreate">新增程序</button>
    </div>

    <div class="split">
      <ul class="list">
        <li v-for="(entry, index) in entries" :key="entry.target ? refKey(entry.target) : `orphan-${index}`">
          <button
            type="button"
            class="list-item"
            :class="{ active: sameRef(selected, entry.target) }"
            :disabled="!entry.target"
            :title="entry.source?.path ?? '（无 .stf 路径）'"
            @click="select(entry)"
          >
            <span class="dot" :class="{ hidden: !isDirtyEntry(entry) }" aria-hidden="true"></span>
            <span class="list-main">
              <span class="list-title mono">{{ entry.row.name }}</span>
              <span class="list-sub mono">{{ baseName(entry.source?.path) || '无 .stf' }}</span>
            </span>
            <span v-if="entry.row.languageId !== stLanguageId" class="chip warn">不支持（非 ST）</span>
            <span v-else-if="!entry.source || entry.source.missing" class="chip warn">源文件缺失</span>
            <span v-if="!entry.target" class="chip">未关联</span>
          </button>
        </li>
        <li v-if="entries.length === 0" class="empty-cell">没有程序记录。</li>
      </ul>

      <section v-if="selectedEntry" class="editor" aria-labelledby="prog-title">
        <header class="editor-head">
          <h2 id="prog-title" class="mono">{{ selectedEntry.row.name }}</h2>
          <span class="chip">{{ languageText }}</span>
          <span v-if="selectedEntry.row.readOnly" class="chip warn">库内标记只读</span>
          <span v-if="sourceMissing" class="chip warn">源文件缺失</span>
          <span class="spacer"></span>
          <button
            type="button"
            class="btn btn-primary"
            :disabled="!canOpenInEditor"
            :title="canOpenInEditor ? '用 VS Code 原生编辑器打开 .stf（语法高亮、诊断、补全）' : '源文件不存在或尚未保存'"
            @click="openInEditor"
          >
            在编辑器中打开
          </button>
          <button
            type="button"
            class="btn"
            :disabled="!stCapable || !dirty"
            :title="stCapable ? '把名称/注释写入草稿' : '非 ST 程序不支持写入'"
            @click="writeDraft"
          >
            写入草稿
          </button>
          <button type="button" class="btn btn-danger" @click="askDelete(selectedEntry)">删除</button>
        </header>

        <p v-if="!stCapable" class="banner warn">
          不支持（非 ST）：languageId={{ selectedEntry.row.languageId }}。本插件只处理 ST，禁止改名、改注释与写入。
        </p>
        <p v-if="sourceMissing" class="banner warn">
          源文件缺失：找不到对应的 .stf。新增程序保存后会自动生成模板文件。
        </p>
        <p class="banner">
          ST 源码在 VS Code 原生编辑器中修改与保存；本页面负责程序注册、改名、删除与源文件定位。
        </p>

        <div class="editor-meta mono">
          <span>{{ sourcePath || '（无 .stf 路径）' }}</span>
          <span v-if="sourceEncoding">编码 {{ sourceEncoding }}</span>
        </div>

        <div class="editor-fields">
          <DraftForm label="名称" for-id="prog-name">
            <input
              id="prog-name"
              v-model="form.name"
              class="input"
              type="text"
              autocomplete="off"
              :disabled="!stCapable"
            />
          </DraftForm>
          <DraftForm label="注释" for-id="prog-comment">
            <input
              id="prog-comment"
              v-model="form.comment"
              class="input"
              type="text"
              autocomplete="off"
              :disabled="!stCapable"
            />
          </DraftForm>
        </div>

        <p v-if="dirty" class="hint">名称/注释有未写入草稿的修改。</p>
        <p v-if="writeNote" class="hint">{{ writeNote }}</p>
      </section>

      <div v-else class="editor empty">
        <p>从左侧选择一个程序。</p>
        <p class="hint">ST 源码由 VS Code 编辑器打开；本页面管理程序注册与源文件。</p>
      </div>
    </div>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="删除程序"
      :message="deleteMessage"
      :detail="deleteDetail"
      confirm-label="删除"
      danger
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />

    <div v-if="creating" class="overlay" role="presentation">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="prog-new-title">
        <h2 id="prog-new-title" class="dialog-title">新增程序</h2>
        <DraftForm label="名称" for-id="new-prog-name">
          <input id="new-prog-name" v-model="newProgram.name" class="input" type="text" autocomplete="off" />
        </DraftForm>
        <DraftForm label="注释" for-id="new-prog-comment">
          <input id="new-prog-comment" v-model="newProgram.comment" class="input" type="text" autocomplete="off" />
        </DraftForm>
        <p class="hint">按 ST 提交，资源取库中第一条；保存后生成含 PROGRAM/END_PROGRAM 的 .stf 模板。</p>
        <p v-if="newProgramNote" class="hint warn">{{ newProgramNote }}</p>
        <div class="dialog-actions">
          <button type="button" class="btn" @click="creating = false">取消</button>
          <button type="button" class="btn btn-primary" @click="submitCreate">确定</button>
        </div>
      </div>
    </div>
  </section>
</template>
