<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { ChannelInput, ChannelRecord, EntityRef } from '../../../src/shared/types';
import { useEditor } from '../composables/editor';
import {
  addOpRefs,
  bindEffectiveRows,
  deleteChannelDraft,
  draftChannelInput,
  hasEntityDraft,
  newTempId,
  refKey,
  sameRef,
  setChannelDraft,
} from '../composables/draftOps';
import type { BoundRow } from '../composables/draftOps';
import { toNumber } from '../composables/format';
import DraftForm from './DraftForm.vue';
import ConfirmDialog from './ConfirmDialog.vue';

interface ChannelForm {
  name: string;
  portNum: number;
  protocol: string;
  interval: number;
  timeout: number;
  retry: number;
  watchtime: number;
  baudrate: string;
  databits: string;
  parity: string;
  stopbits: string;
  comments: string;
  destIp: string;
  destPort: number;
  tcpudp: number;
}

const { state, ops, commitOps } = useEditor();

const boundRows = computed<BoundRow<ChannelRecord>[]>(() => {
  const current = state.value;
  if (!current) return [];
  const existingIds = new Set((current.snapshot.db?.channels ?? []).map((item) => item.id));
  return bindEffectiveRows(current.plan.effective.channels, existingIds, addOpRefs(ops.value, 'channel'));
});

function blankForm(): ChannelForm {
  const channels = state.value?.plan.effective.channels ?? [];
  const maxPort = channels.reduce((max, item) => (item.portNum > max ? item.portNum : max), 0);
  return {
    name: '',
    portNum: maxPort + 1,
    protocol: '',
    interval: 0,
    timeout: 0,
    retry: 0,
    watchtime: 0,
    baudrate: '',
    databits: '',
    parity: '',
    stopbits: '',
    comments: '',
    destIp: '',
    destPort: 0,
    tcpudp: 0,
  };
}

const drawer = ref<{ target: EntityRef | null } | null>(null);
const form = reactive<ChannelForm>(blankForm());
const formNote = ref('');
const pendingDelete = ref<BoundRow<ChannelRecord> | null>(null);

const isEditing = computed(() => {
  const target = drawer.value?.target;
  return target !== null && target !== undefined && target.kind === 'existing';
});
const drawerTitle = computed(() => (isEditing.value ? '编辑通道' : '新增通道'));

const serialHint = computed(() =>
  form.protocol.trim() === '' ? '协议为空时，KLP 可能不会使用串口参数。' : '',
);

function isDirty(item: BoundRow<ChannelRecord>): boolean {
  return hasEntityDraft(ops.value, 'channel', item.target);
}

function openCreate(): void {
  Object.assign(form, blankForm());
  formNote.value = '';
  drawer.value = { target: null };
}

function openEdit(item: BoundRow<ChannelRecord>): void {
  const target = item.target;
  if (!target) return;
  const draft = draftChannelInput(ops.value, target);
  const row = item.row;
  Object.assign(form, {
    name: draft?.name ?? row.name,
    portNum: draft?.portNum ?? row.portNum,
    protocol: draft?.protocol ?? row.protocol,
    interval: draft?.interval ?? row.interval,
    timeout: draft?.timeout ?? row.timeout,
    retry: draft?.retry ?? row.retry,
    watchtime: draft?.watchtime ?? row.watchtime,
    baudrate: draft?.baudrate ?? row.baudrate,
    databits: draft?.databits ?? row.databits,
    parity: draft?.parity ?? row.parity,
    stopbits: draft?.stopbits ?? row.stopbits,
    comments: draft?.comments ?? row.comments,
    destIp: draft?.destIp ?? row.destIp,
    destPort: draft?.destPort ?? row.destPort,
    tcpudp: draft?.tcpudp ?? row.tcpudp,
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
  const input: ChannelInput = {
    name,
    portNum: toNumber(form.portNum),
    protocol: form.protocol.trim(),
    interval: toNumber(form.interval),
    timeout: toNumber(form.timeout),
    retry: toNumber(form.retry),
    watchtime: toNumber(form.watchtime),
    destIp: form.destIp.trim(),
    destPort: toNumber(form.destPort),
    tcpudp: toNumber(form.tcpudp),
    baudrate: form.baudrate.trim(),
    databits: form.databits.trim(),
    parity: form.parity.trim(),
    stopbits: form.stopbits.trim(),
    comments: form.comments,
  };
  const target: EntityRef = drawer.value?.target ?? { kind: 'new', tempId: newTempId('channel') };
  commitOps(setChannelDraft(ops.value, target, input));
  closeDrawer();
}

const deleteMessage = computed(() => {
  const item = pendingDelete.value;
  if (!item) return '';
  return item.target?.kind === 'new'
    ? `撤销新增的通道「${item.row.name}」？`
    : `删除通道「${item.row.name}」？引用该通道的设备会变成悬空引用。`;
});

function confirmDelete(): void {
  const item = pendingDelete.value;
  pendingDelete.value = null;
  if (!item?.target) return;
  if (sameRef(drawer.value?.target, item.target)) closeDrawer();
  commitOps(deleteChannelDraft(ops.value, item.target));
}
</script>

<template>
  <div class="pane">
    <div class="toolbar">
      <span class="muted">共 {{ boundRows.length }} 个通道</span>
      <span class="spacer"></span>
      <button type="button" class="btn btn-primary" @click="openCreate">新增通道</button>
    </div>

    <div class="split">
      <div class="table-wrap">
        <table class="grid">
          <thead>
            <tr>
              <th class="col-dot" scope="col"><span class="visually-hidden">未保存修改</span></th>
              <th scope="col">名称</th>
              <th scope="col">端口</th>
              <th scope="col">协议</th>
              <th scope="col">周期(ms)</th>
              <th scope="col">超时(ms)</th>
              <th scope="col">重试</th>
              <th scope="col">重连(s)</th>
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
              <td>{{ item.row.portNum }}</td>
              <td>{{ item.row.protocol || '—' }}</td>
              <td>{{ item.row.interval }}</td>
              <td>{{ item.row.timeout }}</td>
              <td>{{ item.row.retry }}</td>
              <td>{{ item.row.watchtime }}</td>
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
              <td class="empty-cell" colspan="10">没有通讯通道。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <aside v-if="drawer" class="drawer" aria-labelledby="chan-drawer-title">
        <header class="drawer-head">
          <h2 id="chan-drawer-title">{{ drawerTitle }}</h2>
          <button type="button" class="btn btn-icon" @click="closeDrawer">关闭</button>
        </header>

        <div class="drawer-body">
          <DraftForm label="名称" for-id="chan-name">
            <input id="chan-name" v-model="form.name" class="input" type="text" autocomplete="off" />
          </DraftForm>
          <DraftForm label="端口号" for-id="chan-port" hint="物理端口序号，与 .mgp 的 PhyPorts 对应。">
            <input id="chan-port" v-model.number="form.portNum" class="input" type="number" min="0" step="1" />
          </DraftForm>
          <DraftForm label="协议" for-id="chan-protocol">
            <input id="chan-protocol" v-model="form.protocol" class="input" type="text" autocomplete="off" />
          </DraftForm>
          <DraftForm label="扫描周期 (ms)" for-id="chan-interval">
            <input id="chan-interval" v-model.number="form.interval" class="input" type="number" min="0" step="1" />
          </DraftForm>
          <DraftForm label="超时 (ms)" for-id="chan-timeout">
            <input id="chan-timeout" v-model.number="form.timeout" class="input" type="number" min="0" step="1" />
          </DraftForm>
          <DraftForm label="重试" for-id="chan-retry">
            <input id="chan-retry" v-model.number="form.retry" class="input" type="number" min="0" step="1" />
          </DraftForm>
          <DraftForm label="重连间隔 (s)" for-id="chan-watchtime">
            <input id="chan-watchtime" v-model.number="form.watchtime" class="input" type="number" min="0" step="1" />
          </DraftForm>
          <DraftForm label="波特率" for-id="chan-baudrate" hint="串口参数，原样写入库内文本字段。">
            <input id="chan-baudrate" v-model="form.baudrate" class="input mono" type="text" autocomplete="off" />
          </DraftForm>
          <DraftForm label="数据位" for-id="chan-databits">
            <input id="chan-databits" v-model="form.databits" class="input mono" type="text" autocomplete="off" />
          </DraftForm>
          <DraftForm label="校验" for-id="chan-parity">
            <input id="chan-parity" v-model="form.parity" class="input mono" type="text" autocomplete="off" />
          </DraftForm>
          <DraftForm label="停止位" for-id="chan-stopbits">
            <input id="chan-stopbits" v-model="form.stopbits" class="input mono" type="text" autocomplete="off" />
          </DraftForm>
          <DraftForm label="备注" for-id="chan-comments">
            <input id="chan-comments" v-model="form.comments" class="input" type="text" autocomplete="off" />
          </DraftForm>

          <div class="group-title">网络参数</div>
          <p class="hint">这三项不在必需字段清单里，但 ChannelInput 需要，按原值保留。</p>
          <DraftForm label="目标 IP" for-id="chan-destip">
            <input id="chan-destip" v-model="form.destIp" class="input mono" type="text" autocomplete="off" />
          </DraftForm>
          <DraftForm label="目标端口" for-id="chan-destport">
            <input id="chan-destport" v-model.number="form.destPort" class="input" type="number" min="0" step="1" />
          </DraftForm>
          <DraftForm label="TCP/UDP 标识" for-id="chan-tcpudp" hint="库内数字字段，含义待验证；不确定就保留原值。">
            <input id="chan-tcpudp" v-model.number="form.tcpudp" class="input" type="number" min="0" step="1" />
          </DraftForm>

          <p v-if="serialHint" class="hint">{{ serialHint }}</p>
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
      title="删除通道"
      :message="deleteMessage"
      detail="只生成草稿操作；点「保存」后才写入数据库。"
      confirm-label="删除"
      danger
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </div>
</template>
