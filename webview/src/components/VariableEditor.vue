<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { EntityRef, VariableInput, VariableRecord } from '../../../src/shared/types';
import { useEditor } from '../composables/editor';
import {
  addOpRefs,
  bindEffectiveRows,
  deleteVariableDraft,
  draftVariableInput,
  hasEntityDraft,
  newTempId,
  refKey,
  sameRef,
  setVariableDraft,
} from '../composables/draftOps';
import type { BoundRow } from '../composables/draftOps';
import { firstId, indexById, nameFromIndex } from '../composables/names';
import { toNumber } from '../composables/format';
import DraftForm from './DraftForm.vue';
import ConfirmDialog from './ConfirmDialog.vue';

interface VariableForm {
  name: string;
  comment: string;
  groupId: number;
  defTypeId: number;
  directionId: number;
  attributeId: number;
  userAddress: string;
  wiring: string;
  isRetain: boolean;
  initialValue: string;
}

interface VariableHidden {
  varInstanceId: number;
  resourcePouId: number;
  scopeId: number;
}

const { state, ops, commitOps } = useEditor();

const db = computed(() => state.value?.snapshot.db);
const groupIndex = computed(() => indexById(db.value?.groups));
const directionIndex = computed(() => indexById(db.value?.directions));
const attributeIndex = computed(() => indexById(db.value?.attributes));
const defTypeIndex = computed(() => indexById(db.value?.definitionTypes));
const pouIndex = computed(() => indexById(db.value?.pous));

const search = ref('');
const groupFilter = ref<'all' | number>('all');

const boundRows = computed<BoundRow<VariableRecord>[]>(() => {
  const current = state.value;
  if (!current) return [];
  const existingIds = new Set((current.snapshot.db?.variables ?? []).map((item) => item.id));
  return bindEffectiveRows(current.plan.effective.variables, existingIds, addOpRefs(ops.value, 'variable'));
});

const filteredRows = computed(() => {
  const query = search.value.trim().toLowerCase();
  const group = groupFilter.value;
  return boundRows.value.filter((item) => {
    if (group !== 'all' && item.row.groupId !== group) return false;
    if (!query) return true;
    return item.row.name.toLowerCase().includes(query) || item.row.comment.toLowerCase().includes(query);
  });
});

function typeName(row: VariableRecord): string {
  if (row.varInstanceId === 2) return nameFromIndex(pouIndex.value, row.defTypeId);
  return nameFromIndex(defTypeIndex.value, row.defTypeId);
}

function isDirty(item: BoundRow<VariableRecord>): boolean {
  return hasEntityDraft(ops.value, 'variable', item.target);
}

function rowKey(item: BoundRow<VariableRecord>, index: number): string {
  return item.target ? refKey(item.target) : `orphan-${index}`;
}

/* ------------------------------ 表单 ------------------------------ */

function blankForm(): VariableForm {
  const database = db.value;
  return {
    name: '',
    comment: '',
    groupId: firstId(database?.groups),
    defTypeId: firstId(database?.definitionTypes),
    directionId: firstId(database?.directions),
    attributeId: firstId(database?.attributes),
    userAddress: '',
    wiring: '',
    isRetain: false,
    initialValue: '',
  };
}

const form = reactive<VariableForm>(blankForm());

function blankHidden(): VariableHidden {
  const database = db.value;
  const globalScope = database?.scopes.find((scope) => scope.name.toLowerCase() === 'global') ?? database?.scopes[0];
  return {
    varInstanceId: 1,
    resourcePouId: database?.resources[0]?.id ?? 0,
    scopeId: globalScope?.id ?? 0,
  };
}

const hidden = reactive<VariableHidden>(blankHidden());
const formNote = ref('');
const drawer = ref<{ target: EntityRef | null } | null>(null);
const pendingDelete = ref<BoundRow<VariableRecord> | null>(null);

const isEditing = computed(() => {
  const target = drawer.value?.target;
  return target !== null && target !== undefined && target.kind === 'existing';
});
const drawerTitle = computed(() => (isEditing.value ? '编辑变量' : '新增变量'));

const duplicateCount = computed(() => {
  const name = form.name.trim();
  if (!name) return 0;
  const current = drawer.value?.target ?? null;
  return boundRows.value.filter((item) => item.row.name === name && !sameRef(item.target, current)).length;
});

function openCreate(): void {
  Object.assign(form, blankForm());
  Object.assign(hidden, blankHidden());
  formNote.value = '';
  drawer.value = { target: null };
}

function openEdit(item: BoundRow<VariableRecord>): void {
  const target = item.target;
  if (!target) return;
  const draft = draftVariableInput(ops.value, target);
  const row = item.row;
  Object.assign(form, {
    name: draft?.name ?? row.name,
    comment: draft?.comment ?? row.comment,
    groupId: draft?.groupId ?? row.groupId,
    defTypeId: draft?.defTypeId ?? row.defTypeId,
    directionId: draft?.directionId ?? row.directionId,
    attributeId: draft?.attributeId ?? row.attributeId,
    userAddress: draft?.userAddress ?? row.userAddress,
    wiring: draft?.wiring ?? row.wiring,
    isRetain: draft?.isRetain ?? row.isRetain,
    initialValue: draft?.initialValue ?? row.initialValue,
  });
  Object.assign(hidden, {
    varInstanceId: draft?.varInstanceId ?? row.varInstanceId,
    resourcePouId: draft?.resourcePouId ?? row.resourcePouId,
    scopeId: draft?.scopeId ?? row.scopeId,
  });
  formNote.value = draft ? '当前显示的是草稿中的值。' : '';
  drawer.value = { target };
}

function closeDrawer(): void {
  drawer.value = null;
  formNote.value = '';
}

function submit(): void {
  const name = form.name.trim();
  if (!name) {
    formNote.value = '名称不能为空。';
    return;
  }
  if (toNumber(form.defTypeId) === 0) {
    formNote.value = '请选择类型。';
    return;
  }
  const input: VariableInput = {
    name,
    comment: form.comment,
    groupId: toNumber(form.groupId),
    defTypeId: toNumber(form.defTypeId),
    directionId: toNumber(form.directionId),
    attributeId: toNumber(form.attributeId),
    varInstanceId: hidden.varInstanceId,
    resourcePouId: hidden.resourcePouId,
    scopeId: hidden.scopeId,
    userAddress: form.userAddress,
    wiring: form.wiring,
    isRetain: form.isRetain,
    initialValue: form.initialValue,
  };
  const target: EntityRef = drawer.value?.target ?? { kind: 'new', tempId: newTempId('variable') };
  commitOps(setVariableDraft(ops.value, target, input));
  closeDrawer();
}

function askDelete(item: BoundRow<VariableRecord>): void {
  if (!item.target) return;
  pendingDelete.value = item;
}

const deleteMessage = computed(() => {
  const item = pendingDelete.value;
  if (!item) return '';
  return item.target?.kind === 'new'
    ? `撤销新增的变量「${item.row.name}」？`
    : `删除变量「${item.row.name}」？保存后该行将从数据库移除。`;
});

function confirmDelete(): void {
  const item = pendingDelete.value;
  pendingDelete.value = null;
  if (!item?.target) return;
  if (sameRef(drawer.value?.target, item.target)) closeDrawer();
  commitOps(deleteVariableDraft(ops.value, item.target));
}
</script>

<template>
  <section class="pane">
    <div v-if="!db" class="empty">
      <p>未读取到设备数据库（PrjLibrary.mdb），变量编辑器不可用。</p>
      <p class="hint">宿主没有返回 snapshot.db，通常表示 .mgp 未声明设备或数据库读取失败。</p>
    </div>

    <template v-else>
      <div class="toolbar">
        <label class="search" for="var-search">
          <span class="visually-hidden">按名称或注释搜索</span>
          <input id="var-search" v-model="search" class="input" type="search" placeholder="按名称 / 注释搜索" />
        </label>
        <label class="inline-field" for="var-group-filter">
          <span>分组</span>
          <select id="var-group-filter" v-model="groupFilter" class="input">
            <option value="all">全部（{{ boundRows.length }}）</option>
            <option v-for="group in db?.groups ?? []" :key="group.id" :value="group.id">{{ group.name }}</option>
          </select>
        </label>
        <span class="spacer"></span>
        <span class="muted">显示 {{ filteredRows.length }} / {{ boundRows.length }} 行</span>
        <button type="button" class="btn btn-primary" @click="openCreate">新增变量</button>
      </div>

      <div class="split">
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th class="col-dot" scope="col"><span class="visually-hidden">未保存修改</span></th>
                <th scope="col">名称</th>
                <th scope="col">类型</th>
                <th scope="col">分组</th>
                <th scope="col">方向</th>
                <th scope="col">属性</th>
                <th scope="col">注释</th>
                <th scope="col">本机地址</th>
                <th scope="col">I/O 组态</th>
                <th scope="col" class="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(item, index) in filteredRows" :key="rowKey(item, index)">
                <td class="col-dot">
                  <span v-if="isDirty(item)" class="dot" role="img" aria-label="有未保存的修改"></span>
                </td>
                <td class="mono">{{ item.row.name }}</td>
                <td>{{ typeName(item.row) }}</td>
                <td>{{ nameFromIndex(groupIndex, item.row.groupId) }}</td>
                <td>{{ nameFromIndex(directionIndex, item.row.directionId) }}</td>
                <td>{{ nameFromIndex(attributeIndex, item.row.attributeId) }}</td>
                <td class="col-comment" :title="item.row.comment">{{ item.row.comment }}</td>
                <td class="mono">{{ item.row.userAddress || '—' }}</td>
                <td class="mono">{{ item.row.wiring || '—' }}</td>
                <td class="col-actions">
                  <button type="button" class="link" :disabled="!item.target" @click="openEdit(item)">编辑</button>
                  <button type="button" class="link danger" :disabled="!item.target" @click="askDelete(item)">
                    删除
                  </button>
                  <span v-if="!item.target" class="chip warn" title="宿主返回的新增行无法对应到草稿操作">
                    未关联
                  </span>
                </td>
              </tr>
              <tr v-if="filteredRows.length === 0">
                <td class="empty-cell" colspan="10">没有符合条件的变量。</td>
              </tr>
            </tbody>
          </table>
        </div>

        <aside v-if="drawer" class="drawer" aria-labelledby="var-drawer-title">
          <header class="drawer-head">
            <h2 id="var-drawer-title">{{ drawerTitle }}</h2>
            <button type="button" class="btn btn-icon" @click="closeDrawer">关闭</button>
          </header>

          <div class="drawer-body">
            <DraftForm label="名称" for-id="var-name">
              <input id="var-name" v-model="form.name" class="input" type="text" autocomplete="off" />
            </DraftForm>

            <DraftForm label="注释" for-id="var-comment">
              <input id="var-comment" v-model="form.comment" class="input" type="text" autocomplete="off" />
            </DraftForm>

            <DraftForm label="分组" for-id="var-group">
              <select id="var-group" v-model="form.groupId" class="input">
                <option v-for="group in db?.groups ?? []" :key="group.id" :value="group.id">{{ group.name }}</option>
              </select>
            </DraftForm>

            <DraftForm label="类型" for-id="var-type" hint="仅列出定义类型；功能块实例类型请在原库中维护。">
              <select id="var-type" v-model="form.defTypeId" class="input">
                <option :value="0">（未选择）</option>
                <option v-for="type in db?.definitionTypes ?? []" :key="type.id" :value="type.id">{{ type.name }}</option>
              </select>
            </DraftForm>

            <DraftForm label="方向" for-id="var-direction">
              <select id="var-direction" v-model="form.directionId" class="input">
                <option v-for="direction in db?.directions ?? []" :key="direction.id" :value="direction.id">
                  {{ direction.name }}
                </option>
              </select>
            </DraftForm>

            <DraftForm label="属性" for-id="var-attribute">
              <select id="var-attribute" v-model="form.attributeId" class="input">
                <option v-for="attribute in db?.attributes ?? []" :key="attribute.id" :value="attribute.id">
                  {{ attribute.name }}
                </option>
              </select>
            </DraftForm>

            <DraftForm label="本机地址" for-id="var-address" hint="UserAddress，原样写入。">
              <input id="var-address" v-model="form.userAddress" class="input mono" type="text" autocomplete="off" />
            </DraftForm>

            <DraftForm label="I/O 组态" for-id="var-wiring" hint="Wiring，原样写入。">
              <input id="var-wiring" v-model="form.wiring" class="input mono" type="text" autocomplete="off" />
            </DraftForm>

            <div class="field inline-check">
              <input id="var-retain" v-model="form.isRetain" type="checkbox" />
              <label for="var-retain">保持（Retain）</label>
            </div>

            <DraftForm label="初始值" for-id="var-initial">
              <input id="var-initial" v-model="form.initialValue" class="input mono" type="text" autocomplete="off" />
            </DraftForm>

            <p v-if="duplicateCount > 0" class="hint warn">
              现有 {{ duplicateCount }} 个同名变量，宿主可能拒绝该修改。
            </p>
            <p v-if="formNote" class="hint">{{ formNote }}</p>
            <p class="hint">本表单不改动作用域 / 所属 POU / 实例类型（新增时按 1 / 0 / 0 提交）。</p>
          </div>

          <footer class="drawer-foot">
            <button type="button" class="btn" @click="closeDrawer">取消</button>
            <button type="button" class="btn btn-primary" @click="submit">确定</button>
          </footer>
        </aside>
      </div>
    </template>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="删除变量"
      :message="deleteMessage"
      detail="只生成草稿操作；点「保存」后才会写入数据库。"
      confirm-label="删除"
      danger
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </section>
</template>
