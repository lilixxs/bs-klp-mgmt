<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { CommDeviceInput, CommDeviceRecord, EntityRef } from '../../../src/shared/types';
import { useEditor } from '../composables/editor';
import {
  addOpRefs,
  bindEffectiveRows,
  deleteDeviceDraft,
  draftDeviceInput,
  emptyModbusParams,
  hasEntityDraft,
  newTempId,
  parseRefKey,
  refKey,
  sameRef,
  setDeviceDraft,
} from '../composables/draftOps';
import type { BoundRow } from '../composables/draftOps';
import { indexById } from '../composables/names';
import { toNumber } from '../composables/format';
import DraftForm from './DraftForm.vue';
import ConfirmDialog from './ConfirmDialog.vue';

interface DeviceForm {
  name: string;
  channelKey: string;
  protocol: string;
  interval: number;
  comments: string;
  station: number;
  transDelay: number;
  transMode: number;
  shortFormat: number;
  longFormat: number;
  floatFormat: number;
  longLongFormat: number;
  doubleFloatFormat: number;
  boolBlockSize: number;
  regBlockSize: number;
  singleCmg: number;
  reserved1: number;
}

const { state, ops, commitOps } = useEditor();

const channelIndex = computed(() => indexById(state.value?.plan.effective.channels));

const channelOptions = computed(() => {
  const options: Array<{ key: string; label: string }> = [];
  for (const channel of state.value?.plan.effective.channels ?? []) {
    options.push({ key: refKey({ kind: 'existing', id: channel.id }), label: channel.name });
  }
  for (const add of addOpRefs(ops.value, 'channel')) {
    options.push({ key: refKey({ kind: 'new', tempId: add.tempId }), label: `${add.name}（新增）` });
  }
  return options;
});

const boundRows = computed<BoundRow<CommDeviceRecord>[]>(() => {
  const current = state.value;
  if (!current) return [];
  const existingIds = new Set((current.snapshot.db?.devices ?? []).map((item) => item.id));
  return bindEffectiveRows(current.plan.effective.devices, existingIds, addOpRefs(ops.value, 'device'));
});

function channelRefOf(item: BoundRow<CommDeviceRecord>): EntityRef | null {
  if (item.target) {
    const draft = draftDeviceInput(ops.value, item.target);
    if (draft) return draft.channelRef;
  }
  return item.row.channelId === 0 ? null : { kind: 'existing', id: item.row.channelId };
}

function channelName(ref: EntityRef | null): string {
  if (!ref) return '—';
  if (ref.kind === 'existing') {
    const name = channelIndex.value.get(ref.id);
    return name ?? `#${ref.id}（已删除）`;
  }
  const created = addOpRefs(ops.value, 'channel').find((item) => item.tempId === ref.tempId);
  return created ? `${created.name}（新增）` : '（新增通道已被移除）';
}

function blankForm(): DeviceForm {
  const modbus = emptyModbusParams();
  return {
    name: '',
    channelKey: channelOptions.value[0]?.key ?? '',
    protocol: '',
    interval: 0,
    comments: '',
    station: modbus.station,
    transDelay: modbus.transDelay,
    transMode: modbus.transMode,
    shortFormat: modbus.shortFormat,
    longFormat: modbus.longFormat,
    floatFormat: modbus.floatFormat,
    longLongFormat: modbus.longLongFormat,
    doubleFloatFormat: modbus.doubleFloatFormat,
    boolBlockSize: modbus.boolBlockSize,
    regBlockSize: modbus.regBlockSize,
    singleCmg: modbus.singleCmg,
    reserved1: modbus.reserved1,
  };
}

const drawer = ref<{ target: EntityRef | null } | null>(null);
const form = reactive<DeviceForm>(blankForm());
const formNote = ref('');
const pendingDelete = ref<BoundRow<CommDeviceRecord> | null>(null);

const isEditing = computed(() => {
  const target = drawer.value?.target;
  return target !== null && target !== undefined && target.kind === 'existing';
});
const drawerTitle = computed(() => (isEditing.value ? '编辑通讯设备' : '新增通讯设备'));

const channelKeyMissing = computed(
  () => drawer.value !== null && form.channelKey !== '' && !channelOptions.value.some((option) => option.key === form.channelKey),
);

function isDirty(item: BoundRow<CommDeviceRecord>): boolean {
  return hasEntityDraft(ops.value, 'device', item.target);
}

function openCreate(): void {
  Object.assign(form, blankForm());
  formNote.value = '';
  drawer.value = { target: null };
}

function openEdit(item: BoundRow<CommDeviceRecord>): void {
  const target = item.target;
  if (!target) return;
  const draft = draftDeviceInput(ops.value, target);
  const row = item.row;
  const modbus = draft?.modbus ?? row.modbus ?? emptyModbusParams();
  Object.assign(form, {
    name: draft?.name ?? row.name,
    channelKey: refKey(draft?.channelRef ?? channelRefOf(item)),
    protocol: draft?.protocol ?? row.protocol,
    interval: draft?.interval ?? row.interval,
    comments: draft?.comments ?? row.comments,
    station: modbus.station,
    transDelay: modbus.transDelay,
    transMode: modbus.transMode,
    shortFormat: modbus.shortFormat,
    longFormat: modbus.longFormat,
    floatFormat: modbus.floatFormat,
    longLongFormat: modbus.longLongFormat,
    doubleFloatFormat: modbus.doubleFloatFormat,
    boolBlockSize: modbus.boolBlockSize,
    regBlockSize: modbus.regBlockSize,
    singleCmg: modbus.singleCmg,
    reserved1: modbus.reserved1,
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
  const channelRef = parseRefKey(form.channelKey);
  if (!channelRef) {
    formNote.value = '请选择所属通道。';
    return;
  }
  const input: CommDeviceInput = {
    name,
    channelRef,
    protocol: form.protocol.trim(),
    interval: toNumber(form.interval),
    comments: form.comments,
    modbus: {
      transMode: toNumber(form.transMode),
      station: toNumber(form.station),
      transDelay: toNumber(form.transDelay),
      shortFormat: toNumber(form.shortFormat),
      longFormat: toNumber(form.longFormat),
      floatFormat: toNumber(form.floatFormat),
      longLongFormat: toNumber(form.longLongFormat),
      doubleFloatFormat: toNumber(form.doubleFloatFormat),
      singleCmg: toNumber(form.singleCmg),
      boolBlockSize: toNumber(form.boolBlockSize),
      regBlockSize: toNumber(form.regBlockSize),
      reserved1: toNumber(form.reserved1),
    },
  };
  const target: EntityRef = drawer.value?.target ?? { kind: 'new', tempId: newTempId('device') };
  commitOps(setDeviceDraft(ops.value, target, input));
  closeDrawer();
}

const deleteMessage = computed(() => {
  const item = pendingDelete.value;
  if (!item) return '';
  return item.target?.kind === 'new'
    ? `撤销新增的设备「${item.row.name}」？`
    : `删除设备「${item.row.name}」？引用该设备的变量映射会变成悬空引用。`;
});

function confirmDelete(): void {
  const item = pendingDelete.value;
  pendingDelete.value = null;
  if (!item?.target) return;
  if (sameRef(drawer.value?.target, item.target)) closeDrawer();
  commitOps(deleteDeviceDraft(ops.value, item.target));
}
</script>

<template>
  <div class="pane">
    <div class="toolbar">
      <span class="muted">共 {{ boundRows.length }} 个设备</span>
      <span class="spacer"></span>
      <button type="button" class="btn btn-primary" @click="openCreate">新增设备</button>
    </div>

    <div class="split">
      <div class="table-wrap">
        <table class="grid">
          <thead>
            <tr>
              <th class="col-dot" scope="col"><span class="visually-hidden">未保存修改</span></th>
              <th scope="col">名称</th>
              <th scope="col">通道</th>
              <th scope="col">协议</th>
              <th scope="col">周期(ms)</th>
              <th scope="col">站号</th>
              <th scope="col">备注</th>
              <th scope="col" class="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in boundRows" :key="item.target ? refKey(item.target) : `orphan-${index}`">
              <td class="col-dot">
                <span v-if="isDirty(item)" class="dot" role="img" aria-label="有未保存的修改"></span>
              </td>
              <td class="mono">{{ item.row.name }}</td>
              <td>{{ channelName(channelRefOf(item)) }}</td>
              <td>{{ item.row.protocol || '—' }}</td>
              <td>{{ item.row.interval }}</td>
              <td>{{ item.row.modbus?.station ?? '—' }}</td>
              <td class="col-comment" :title="item.row.comments">{{ item.row.comments }}</td>
              <td class="col-actions">
                <button type="button" class="link" :disabled="!item.target" @click="openEdit(item)">编辑</button>
                <button type="button" class="link danger" :disabled="!item.target" @click="pendingDelete = item">
                  删除
                </button>
                <span v-if="!item.target" class="chip warn" title="无法对应到草稿操作">未关联</span>
              </td>
            </tr>
            <tr v-if="boundRows.length === 0">
              <td class="empty-cell" colspan="8">没有通讯设备。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <aside v-if="drawer" class="drawer" aria-labelledby="dev-drawer-title">
        <header class="drawer-head">
          <h2 id="dev-drawer-title">{{ drawerTitle }}</h2>
          <button type="button" class="btn btn-icon" @click="closeDrawer">关闭</button>
        </header>

        <div class="drawer-body">
          <DraftForm label="名称" for-id="dev-name">
            <input id="dev-name" v-model="form.name" class="input" type="text" autocomplete="off" />
          </DraftForm>

          <DraftForm
            label="所属通道"
            for-id="dev-channel"
            :hint="channelOptions.length === 0 ? '还没有通道，先在「通道」子标签新增一个。' : '可选现有通道，也可选本次新增的通道。'"
          >
            <select id="dev-channel" v-model="form.channelKey" class="input">
              <option value="">（未选择）</option>
              <option v-for="option in channelOptions" :key="option.key" :value="option.key">{{ option.label }}</option>
            </select>
          </DraftForm>
          <p v-if="channelKeyMissing" class="hint warn">当前引用的通道已不在草稿中，请重新选择。</p>

          <DraftForm label="协议" for-id="dev-protocol">
            <input id="dev-protocol" v-model="form.protocol" class="input" type="text" autocomplete="off" />
          </DraftForm>
          <DraftForm label="扫描周期 (ms)" for-id="dev-interval">
            <input id="dev-interval" v-model.number="form.interval" class="input" type="number" min="0" step="1" />
          </DraftForm>
          <DraftForm label="备注" for-id="dev-comments">
            <input id="dev-comments" v-model="form.comments" class="input" type="text" autocomplete="off" />
          </DraftForm>

          <div class="group-title">Modbus 参数</div>
          <DraftForm label="站号" for-id="dev-station">
            <input id="dev-station" v-model.number="form.station" class="input" type="number" min="0" step="1" />
          </DraftForm>
          <DraftForm label="传输延时" for-id="dev-transdelay">
            <input id="dev-transdelay" v-model.number="form.transDelay" class="input" type="number" min="0" step="1" />
          </DraftForm>
          <DraftForm label="传输模式" for-id="dev-transmode" hint="库内数字字段，含义待验证。">
            <input id="dev-transmode" v-model.number="form.transMode" class="input" type="number" min="0" step="1" />
          </DraftForm>

          <div class="group-title">字节序</div>
          <DraftForm label="shortFormat" for-id="dev-short">
            <input id="dev-short" v-model.number="form.shortFormat" class="input" type="number" step="1" />
          </DraftForm>
          <DraftForm label="longFormat" for-id="dev-long">
            <input id="dev-long" v-model.number="form.longFormat" class="input" type="number" step="1" />
          </DraftForm>
          <DraftForm label="floatFormat" for-id="dev-float">
            <input id="dev-float" v-model.number="form.floatFormat" class="input" type="number" step="1" />
          </DraftForm>
          <DraftForm label="longLongFormat" for-id="dev-longlong">
            <input id="dev-longlong" v-model.number="form.longLongFormat" class="input" type="number" step="1" />
          </DraftForm>
          <DraftForm label="doubleFloatFormat" for-id="dev-double">
            <input id="dev-double" v-model.number="form.doubleFloatFormat" class="input" type="number" step="1" />
          </DraftForm>

          <div class="group-title">块大小</div>
          <DraftForm label="boolBlockSize" for-id="dev-boolblock">
            <input id="dev-boolblock" v-model.number="form.boolBlockSize" class="input" type="number" min="0" step="1" />
          </DraftForm>
          <DraftForm label="regBlockSize" for-id="dev-regblock">
            <input id="dev-regblock" v-model.number="form.regBlockSize" class="input" type="number" min="0" step="1" />
          </DraftForm>

          <div class="group-title">保留字段</div>
          <p class="hint">singleCmg / reserved1 含义待验证，默认保留原值。</p>
          <DraftForm label="singleCmg" for-id="dev-singlecmg">
            <input id="dev-singlecmg" v-model.number="form.singleCmg" class="input" type="number" step="1" />
          </DraftForm>
          <DraftForm label="reserved1" for-id="dev-reserved">
            <input id="dev-reserved" v-model.number="form.reserved1" class="input" type="number" step="1" />
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
      title="删除通讯设备"
      :message="deleteMessage"
      detail="只生成草稿操作；点「保存」后才写入数据库。"
      confirm-label="删除"
      danger
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </div>
</template>
