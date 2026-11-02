/**
 * 页面唯一的状态源。宿主推送的 plan 是渲染依据；本地只维护“正在发送的 ops”，
 * 不在页面里另算一份 effective，避免与宿主分叉。
 */
import { ref, shallowRef } from 'vue';
import type { DraftOp, HostToWebMessage, ProjectSnapshot, Severity, ViewState } from '../../../src/shared/types';
import { postToHost, subscribeHost } from './bridge';

export type TabId = 'variables' | 'programs' | 'comm' | 'project' | 'diagnostics';

export interface Notice {
  id: number;
  severity: Severity;
  message: string;
}

const state = shallowRef<ViewState | null>(null);
const ops = ref<DraftOp[]>([]);
const notices = ref<Notice[]>([]);
const activeTab = ref<TabId>('variables');

/** 最近发出去的 ops 快照。用于识别宿主回推的旧副本，避免覆盖更新的本地编辑。 */
let sentSnapshots: string[] = [];
let noticeSeq = 0;
let started = false;

function jsonOf(list: DraftOp[]): string {
  return JSON.stringify(list);
}

function pushNotice(severity: Severity, message: string): void {
  noticeSeq += 1;
  const notice: Notice = { id: noticeSeq, severity, message };
  notices.value = [...notices.value, notice].slice(-5);
  if (severity !== 'error') {
    window.setTimeout(() => dismissNotice(notice.id), 8000);
  }
}

function dismissNotice(id: number): void {
  notices.value = notices.value.filter((notice) => notice.id !== id);
}

function adoptState(next: ViewState): void {
  const hostJson = jsonOf(next.draft.ops);
  const localJson = jsonOf(ops.value);
  if (hostJson === '[]') {
    // 宿主已经没有任何草稿（保存/放弃/重载成功）。空草稿必须采纳，
    // 否则曾提交过空 draft 的 sentSnapshots 会永久挡住清空，形成幽灵未保存项。
    ops.value = [];
    sentSnapshots = [];
  } else if (hostJson !== localJson && !sentSnapshots.includes(hostJson)) {
    ops.value = next.draft.ops;
  }
  state.value = next;
}

function adoptSavedSnapshot(snapshot: ProjectSnapshot, message: string): void {
  const current = state.value;
  if (current) {
    state.value = { ...current, snapshot };
  }
  ops.value = [];
  sentSnapshots = [];
  pushNotice('info', message);
}

function handleMessage(message: HostToWebMessage): void {
  switch (message.type) {
    case 'state':
      adoptState(message.payload);
      break;
    case 'notice':
      pushNotice(message.payload.severity, message.payload.message);
      break;
    case 'saved':
      adoptSavedSnapshot(message.payload.snapshot, message.payload.message);
      break;
  }
}

/** 发送完整 ops。每次本地编辑后立即调用。 */
function commitOps(next: DraftOp[]): void {
  // `ops.value` 里的旧操作可能是 Vue 的响应式 Proxy。结构化克隆（webview postMessage）
  // 不能克隆 Proxy，第二次编辑起会抛 DataCloneError，导致宿主只收到第一项修改。
  // 发送前统一转成普通对象，既是协议要求，也避免本地状态与宿主状态分叉。
  const plain = JSON.parse(JSON.stringify(next)) as DraftOp[];
  ops.value = plain;
  const json = jsonOf(plain);
  sentSnapshots = [...sentSnapshots.filter((item) => item !== json), json].slice(-32);
  postToHost({ type: 'replaceDraft', payload: { ops: plain } });
}

function save(): void {
  const current = state.value;
  if (!current || current.busy || !current.plan.canSave || ops.value.length === 0) return;
  postToHost({ type: 'save' });
}

function discard(): void {
  const current = state.value;
  if (!current || current.busy) return;
  // 宿主会先弹出确认框。这里不能提前清空本地 ops：用户取消时会造成
  // webview 已清空、宿主草稿仍在的状态分叉。等宿主成功丢弃后回推空草稿。
  postToHost({ type: 'discard' });
}

function reload(): void {
  const current = state.value;
  if (!current || current.busy) return;
  postToHost({ type: 'reload' });
}

/** 请求宿主用 VS Code 原生编辑器打开程序源文件。 */
function openProgram(id: number): void {
  postToHost({ type: 'openProgram', payload: { id } });
}

function start(): void {
  if (started) return;
  started = true;
  subscribeHost(handleMessage);
  postToHost({ type: 'ready' });
}

export function useEditor() {
  return {
    state,
    ops,
    notices,
    activeTab,
    start,
    commitOps,
    save,
    discard,
    reload,
    openProgram,
    dismissNotice,
  };
}
