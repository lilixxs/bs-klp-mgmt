<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { EntityRef, VariableMapInput, VariableMapRecord } from '../../../src/shared/types';
import { useEditor } from '../composables/editor';
import {
  addOpRefs,
  bindEffectiveRows,
  deleteMapDraft,
  draftMapInput,
  hasEntityDraft,
  newTempId,
  parseRefKey,
  refKey,
  sameRef,
  setMapDraft,
} from '../composables/draftOps';
import type { BoundRow, EntityGroup } from '../composables/draftOps';
import { indexById } from '../composables/names';
import { toNumber } from '../composables/format';
import DraftForm from './DraftForm.vue';
import ConfirmDialog from './ConfirmDialog.vue';

const { state, ops, commitOps } = useEditor();

const deviceIndex = computed(() => indexById(state.value?.plan.effective.devices));
const variableIndex = computed(() => indexById(state.value?.plan.effective.variables));

const deviceOptions = computed(() => {
  const options: Array<{ key: string; label: string }> = [];
  for (const device of state.value?.plan.effective.devices ?? []) {
    options.push({ key: refKey({ kind: 'existing', id: device.id }), label: device.name });
  }
  for (const add of addOpRefs(ops.value, 'device')) {
    options.push({ key: refKey({ kind: 'new', tempId: add.tempId }), label: `${add.name}（新增）` });
  }
  return options;
});

const variableOptions = computed(() => {
  const options: Array<{ key: string; label: string }> = [];
  for (const variable of state.value?.plan.effective.variables ?? []) {
    options.push({ key: refKey({ kind: 'existing', id: variable.id }), label: variable.name });
  }
  for (const add of addOpRefs(ops.value, 'variable')) {
    options.push({ key: refKey({ kind: 'new', tempId: add.tempId }), label: `${add.name}（新增）` });
  }
  return options;
});

const boundRows = computed<BoundRow<VariableMapRecord>[]>(() => {
  const current = state.value;
  if (!current) return [];
  const existingIds = new Set((current.snapshot.db?.maps ?? []).map((item) => item.id));
  // 映射表没有名称字段，只能按 ops 顺序把新增行对回 add 操作。
  return bindEffectiveRows(current.plan.effective.maps, existingIds, addOpRefs(ops.value, 'map'), () => '');
});

function referenceOf(
  item: BoundRow<VariableMapRecord>,
  pick: (input: VariableMapInput) => EntityRef,
  fallbackId: number,
): EntityRef | null {
  if (item.target) {
    const draft = draftMapInput(ops.value, item.target);
    if (draft) return pick(draft);
  }
  return fallbackId === 0 ? null : { kind: 'existing', id: fallbackId };
}

function referenceName(ref: EntityRef | null, index: Map<number, string>, group: EntityGroup): string {
  if (!ref) return '—';
  if (ref.kind === 'existing') {
    const name = index.get(ref.id);
    return name ?? `#${ref.id}（已删除）`;
  }
  const created = addOpRefs(ops.value, group).find((item) => item.tempId === ref.tempId);
  return created ? `${created.name}（新增）` : '（新增项已被移除）';
}

function deviceNameOf(item: BoundRow<VariableMapRecord>): string {
  return referenceName(referenceOf(item, (input) => input.deviceRef, item.row.deviceId), deviceIndex.value, 'device');
}

function symbolNameOf(item: BoundRow<VariableMapRecord>): string {
  return referenceName(referenceOf(item, (input) => input.symbolRef, item.row.symbolId), variableIndex.value, 'variable');
}

const drawer = ref<{ target: EntityRef | null } | null>(null);
const form = reactive({ deviceKey: '', symbolKey: '', address: '', access: 0 });
const variableQuery = ref('');
const formNote = ref('');
const pendingDelete = ref<BoundRow<VariableMapRecord> | null>(null);

const isEditing = computed(() => {
  const target = drawer.value?.target;
  return target !== null && target !== undefined && target.kind === 'existing';
});
const drawerTitle = computed(() => (isEditing.value ? '编辑变量映射' : '新增变量映射'));

const filteredVariableOptions = computed(() => {
  const query = variableQuery.value.trim().toLowerCase();
  const selectedKey = form.symbolKey;
  if (!query) return variableOptions.value;
  return variableOptions.value.filter(
    (option) => option.key === selectedKey || option.label.toLowerCase().includes(query),
  );
});

const accessOptions = computed(() => {
  const values = new Set<number>([0, 1, 2]);
  values.add(toNumber(form.access));
  return [...values].sort((a, b) => a - b);
});

const deviceKeyMissing = computed(
  () => drawer.value !== null && form.deviceKey !== '' && !deviceOptions.value.some((option) => option.key === form.deviceKey),
);
const symbolKeyMissing = computed(
  () => drawer.value !== null && form.symbolKey !== '' && !variableOptions.value.some((option) => option.key === form.symbolKey),
);

function isDirty(item: BoundRow<VariableMapRecord>): boolean {
  return hasEntityDraft(ops.value, 'map', item.target);
}

function openCreate(): void {
  form.deviceKey = deviceOptions.value[0]?.key ?? '';
  form.symbolKey = variableOptions.value[0]?.key ?? '';
  form.address = '';
  form.access = 0;
  variableQuery.value = '';
  formNote.value = '';
  drawer.value = { target: null };
}

function openEdit(item: BoundRow<VariableMapRecord>): void {
  const target = item.target;
  if (!target) return;
  const draft = draftMapInput(ops.value, target);
  form.deviceKey = refKey(draft?.deviceRef ?? referenceOf(item, (input) => input.deviceRef, item.row.deviceId));
  form.symbolKey = refKey(draft?.symbolRef ?? referenceOf(item, (input) => input.symbolRef, item.row.symbolId));
  form.address = draft?.address ?? item.row.address;
  form.access = draft?.access ?? item.row.access;
  variableQuery.value = '';
  formNote.value = draft ? '当前显示的是草稿中的值。' : '';
  drawer.value = { target };
}

function closeDrawer(): void {
  drawer.value = null;
  formNote.value = '';
}

function submit(): void {
  const deviceRef = parseRefKey(form.deviceKey);
  if (!deviceRef) {
    formNote.value = '请选择设备。';
    return;
  }
  const symbolRef = parseRefKey(form.symbolKey);
  if (!symbolRef) {
    formNote.value = '请选择变量。';
    return;
  }
  const input: VariableMapInput = {
    deviceRef,
    symbolRef,
    address: form.address.trim(),
    access: toNumber(form.access),
  };
  const target: EntityRef = drawer.value?.target ?? { kind: 'new', tempId: newTempId('map') };
  commitOps(setMapDraft(ops.value, target, input));
  closeDrawer();
}

const deleteMessage = computed(() => {
  const item = pendingDelete.value;
  if (!item) return '';
  if (item.target?.kind === 'new') return '撤销新增的变量映射？';
  return `删除映射「${deviceNameOf(item)} → ${symbolNameOf(item)}」？`;
});

function confirmDelete(): void {
  const item = pendingDelete.value;
  pendingDelete.value = null;
  if (!item?.target) return;
  if (sameRef(drawer.value?.target, item.target)) closeDrawer();
  commitOps(deleteMapDraft(ops.value, item.target));
}
</script>

<template>
  <div class="pane">
    <div class="toolbar">
      <span class="muted">共 {{ boundRows.length }} 条映射</span>
      <span class="spacer"></span>
      <button type="button" class="btn btn-primary" :disabled="deviceOptions.length === 0" @click="openCreate">
        新增映射
      </button>
    </div>

    <div class="split">
      <div class="table-wrap">
        <table class="grid">
          <thead>
            <tr>
              <th class="col-dot" scope="col"><span class="visually-hidden">未保存修改</span></th>
              <th scope="col">设备</th>
              <th scope="col">变量</th>
              <th scope="col">地址</th>
              <th scope="col">访问代码</th>
              <th scope="col" class="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in boundRows" :key="item.target ? refKey(item.target) : `orphan-${index}`">
              <td class="col-dot">
                <span v-if="isDirty(item)" class="dot" role="img" aria-label="有未保存的修改"></span>
              </td>
              <td class="mono">{{ deviceNameOf(item) }}</td>
              <td class="mono">{{ symbolNameOf(item) }}</td>
              <td class="mono">{{ item.row.address || '—' }}</td>
              <td>{{ item.row.access }}</td>
              <td class="col-actions">
                <button type="button" class="link" :disabled="!item.target" @click="openEdit(item)">编辑</button>
                <button type="button" class="link danger" :disabled="!item.target" @click="pendingDelete = item">
                  删除
                </button>
                <span v-if="!item.target" class="chip warn" title="无法对应到草稿操作">未关联</span>
              </td>
            </tr>
            <tr v-if="boundRows.length === 0">
              <td class="empty-cell" colspan="6">没有变量映射。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <aside v-if="drawer" class="drawer" aria-labelledby="map-drawer-title">
        <header class="drawer-head">
          <h2 id="map-drawer-title">{{ drawerTitle }}</h2>
          <button type="button" class="btn btn-icon" @click="closeDrawer">关闭</button>
        </header>

        <div class="drawer-body">
          <DraftForm label="设备" for-id="map-device">
            <select id="map-device" v-model="form.deviceKey" class="input">
              <option value="">（未选择）</option>
              <option v-for="option in deviceOptions" :key="option.key" :value="option.key">{{ option.label }}</option>
            </select>
          </DraftForm>
          <p v-if="deviceKeyMissing" class="hint warn">引用的设备已不在草稿中，请重新选择。</p>

          <DraftForm label="筛选变量" for-id="map-symbol-query">
            <input
              id="map-symbol-query"
              v-model="variableQuery"
              class="input"
              type="search"
              placeholder="按变量名筛选"
              autocomplete="off"
            />
          </DraftForm>
          <DraftForm label="变量" for-id="map-symbol" :hint="`可选 ${filteredVariableOptions.length} 个变量`">
            <select id="map-symbol" v-model="form.symbolKey" class="input">
              <option value="">（未选择）</option>
              <option v-for="option in filteredVariableOptions" :key="option.key" :value="option.key">
                {{ option.label }}
              </option>
            </select>
          </DraftForm>
          <p v-if="symbolKeyMissing" class="hint warn">引用的变量已不在草稿中，请重新选择。</p>

          <DraftForm label="地址" for-id="map-address" hint="库内文本字段，按 KLP 的地址写法填写。">
            <input id="map-address" v-model="form.address" class="input mono" type="text" autocomplete="off" />
          </DraftForm>

          <DraftForm label="访问代码" for-id="map-access" hint="0 / 1 / 2 的具体含义未验证；不确定就保留原值。">
            <select id="map-access" v-model="form.access" class="input">
              <option v-for="value in accessOptions" :key="value" :value="value">{{ value }}</option>
            </select>
          </DraftForm>

          <p v-if="formNote" class="hint">{{ formNote }}</p>
        </div>

        <footer class="drawer-foot">
          <button type="button" class="btn" @click="closeDrawer">取消</button>
          <button type="button" class="btn btn-primary" @click="submit">确定</button>
        </footer>
      </aside>
    </div>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="删除变量映射"
      :message="deleteMessage"
      detail="只生成草稿操作；点「保存」后才写入数据库。"
      confirm-label="删除"
      danger
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </div>
</template>
