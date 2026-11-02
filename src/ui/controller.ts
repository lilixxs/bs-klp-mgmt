import * as vscode from 'vscode';
import type { Draft, DraftOp, DraftPlan, ProjectSnapshot, ViewState } from '../shared/types.ts';
import { JetBridge } from '../mdb/jet.ts';
import { buildPlan } from '../project/plan.ts';
import { SaveConflictError, SavePlanError, saveProject } from '../project/save.ts';
import { openProject } from '../project/session.ts';

export type SaveOutcome =
  | { kind: 'ok'; warnings: string[] }
  | { kind: 'conflict'; files: string[]; message: string }
  | { kind: 'planError'; message: string }
  | { kind: 'error'; message: string };

export interface OpenResult {
  snapshot: ProjectSnapshot;
}

export class SessionController {
  private snapshot?: ProjectSnapshot;
  private draft: Draft = { ops: [] };
  private plan?: DraftPlan;
  private busy = false;
  private busyMessage?: string;
  private activeTab: ViewState['activeTab'];
  private focus: ViewState['focus'];

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly bridge: JetBridge) {}

  get hasProject(): boolean {
    return Boolean(this.snapshot);
  }

  get currentSnapshot(): ProjectSnapshot | undefined {
    return this.snapshot;
  }

  get pendingCount(): number {
    return this.draft.ops.length;
  }

  get dbAvailable(): boolean {
    return Boolean(this.snapshot?.db);
  }

  setActiveView(tab: ViewState['activeTab'], focus?: ViewState['focus']): void {
    this.activeTab = tab;
    this.focus = focus;
    this.changed.fire();
  }

  get viewState(): ViewState | undefined {
    if (!this.snapshot) {
      return undefined;
    }
    return {
      snapshot: this.snapshot,
      draft: this.draft,
      plan: this.plan ?? buildPlan({ snapshot: this.snapshot, draft: this.draft }),
      busy: this.busy,
      busyMessage: this.busyMessage,
      activeTab: this.activeTab,
      focus: this.focus,
    };
  }

  async open(entryPath: string): Promise<ProjectSnapshot> {
    this.setBusy(true, '正在读取工程…');
    try {
      const snapshot = await openProject(entryPath, this.bridge);
      this.snapshot = snapshot;
      this.draft = { ops: [] };
      this.plan = buildPlan({ snapshot, draft: this.draft });
      return snapshot;
    } finally {
      this.setBusy(false);
      this.changed.fire();
    }
  }

  async reload(): Promise<void> {
    if (!this.snapshot) {
      return;
    }
    const entry = this.snapshot.entryPath;
    this.setBusy(true, '正在重新读取工程…');
    try {
      const snapshot = await openProject(entry, this.bridge);
      this.snapshot = snapshot;
      this.draft = { ops: [] };
      this.plan = buildPlan({ snapshot, draft: this.draft });
    } finally {
      this.setBusy(false);
      this.changed.fire();
    }
  }

  setDraft(ops: DraftOp[]): void {
    this.draft = { ops };
    this.recompute();
  }

  addOp(op: DraftOp): void {
    this.draft = { ops: [...this.draft.ops, op] };
    this.recompute();
  }

  discard(): void {
    if (!this.snapshot) {
      return;
    }
    this.draft = { ops: [] };
    this.recompute();
  }

  private recompute(): void {
    if (!this.snapshot) {
      return;
    }
    this.plan = buildPlan({ snapshot: this.snapshot, draft: this.draft });
    this.changed.fire();
  }

  private setBusy(busy: boolean, message?: string): void {
    this.busy = busy;
    this.busyMessage = message;
    this.changed.fire();
  }

  async save(options: { force?: boolean } = {}): Promise<SaveOutcome> {
    if (!this.snapshot) {
      return { kind: 'error', message: '尚未打开工程。' };
    }
    if (this.draft.ops.length === 0) {
      return { kind: 'error', message: '没有待保存的修改。' };
    }
    this.setBusy(true, '正在保存…');
    try {
      const result = await saveProject({
        snapshot: this.snapshot,
        draft: this.draft,
        bridge: this.bridge,
        force: options.force,
      });
      this.snapshot = result.snapshot;
      this.draft = { ops: [] };
      this.plan = buildPlan({ snapshot: result.snapshot, draft: this.draft });
      return { kind: 'ok', warnings: result.warnings };
    } catch (error) {
      if (error instanceof SaveConflictError) {
        return { kind: 'conflict', files: error.files, message: error.message };
      }
      if (error instanceof SavePlanError) {
        return { kind: 'planError', message: error.message };
      }
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.setBusy(false);
      this.changed.fire();
    }
  }
}
