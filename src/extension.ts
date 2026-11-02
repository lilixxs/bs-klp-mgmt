import * as path from 'node:path';
import * as vscode from 'vscode';
import { JetBridge } from './mdb/jet.ts';
import { discoverEntries } from './project/discovery.ts';
import { buildPlan } from './project/plan.ts';
import { dbDeviceLayout } from './project/session.ts';
import { validateProjectName } from './shared/validation.ts';
import { StLanguageFeatures } from './st/providers.ts';
import { SymbolDocProvider } from './st/symbolDoc.ts';
import { filePathOf, StFileSystemProvider, ST_SCHEME, uriForFile } from './st/fileProvider.ts';
import { buildProjectTree, ProjectTreeProvider } from './tree/projectTree.ts';
import { SessionController } from './ui/controller.ts';
import { encodeTextLike, toCrlf } from './util/encoding.ts';
import { readBytes, writeFileAtomic } from './util/fsx.ts';
import { showEditorPanel, updatePanelTitle } from './webview/editorPanel.ts';

const LAST_ENTRY_KEY = 'klp.lastEntry';

let controller: SessionController;
let tree: ProjectTreeProvider;
let statusBar: vscode.StatusBarItem;
let extensionUri: vscode.Uri;
let languageFeatures: StLanguageFeatures;

function createBridge(): JetBridge {
  return new JetBridge(path.join(extensionUri.fsPath, 'media', 'mdb-helper.ps1'));
}

function refreshTree(): void {
  const snapshot = controller.currentSnapshot;
  if (!snapshot) {
    tree.setTree([]);
    return;
  }
  tree.setProjectName(snapshot.project.name);
  tree.setTree(buildProjectTree(snapshot, 'klp.openEditor', 'klp.openFile'));
}

function updateStatusBar(): void {
  const count = controller.pendingCount;
  if (!controller.hasProject) {
    statusBar.text = '$(plug) KLP 未打开工程';
    statusBar.tooltip = '点击打开 KLP 工程';
    statusBar.command = 'klp.openProject';
    statusBar.backgroundColor = undefined;
    statusBar.show();
    return;
  }
  if (count === 0) {
    statusBar.text = '$(check) KLP 已保存';
    statusBar.tooltip = controller.currentSnapshot?.entryPath ?? '';
    statusBar.command = 'klp.openEditor';
    statusBar.backgroundColor = undefined;
  } else {
    statusBar.text = `$(edit) KLP ${count} 项未保存`;
    statusBar.tooltip = '点击保存';
    statusBar.command = 'klp.save';
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  statusBar.show();
}

async function chooseEntry(inputPath: string): Promise<string | undefined> {
  const entries = await discoverEntries(inputPath);
  if (entries.length === 0) {
    void vscode.window.showErrorMessage('所选位置没有 .mgp 项目入口文件。');
    return undefined;
  }
  if (entries.length === 1) {
    return entries[0]?.path;
  }
  const picked = await vscode.window.showQuickPick(
    entries.map((entry) => ({
      label: entry.name,
      description: `${Math.round(entry.size / 1024)} KB`,
      detail: entry.path,
      path: entry.path,
    })),
    { title: '选择 KLP 项目入口', placeHolder: '该文件夹包含多个 .mgp 文件' },
  );
  return picked?.path;
}

async function loadProject(entryPath: string): Promise<void> {
  try {
    const snapshot = await controller.open(entryPath);
    await extensionContext.globalState.update(LAST_ENTRY_KEY, entryPath);
    await vscode.commands.executeCommand('setContext', 'klp.hasProject', true);
    refreshTree();
    updateStatusBar();
    updatePanelTitle(`KLP: ${snapshot.project.name}`);
    languageFeatures.refreshAll();
    if (snapshot.db) {
      void vscode.window.showInformationMessage(
        `已打开 ${snapshot.project.name}：${snapshot.db.variables.length} 个变量、${snapshot.db.programs.length} 个程序、${snapshot.db.channels.length} 个通讯通道。`,
      );
    } else {
      const errors = snapshot.diagnostics.filter((item) => item.severity === 'error');
      void vscode.window.showErrorMessage(
        `工程已打开，但数据库不可用：${errors[0]?.message ?? '未知原因'}。变量与程序编辑已禁用。`,
      );
    }
    await vscode.commands.executeCommand('setContext', 'klp.dbAvailable', Boolean(snapshot.db));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`打开项目失败：${message}`);
  }
}

async function openProjectFile(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: '选择 KLP 项目入口文件（*.mgp）',
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { 'KLP 项目入口': ['mgp'] },
  });
  if (picked?.[0]) {
    await loadProject(picked[0].fsPath);
  }
}

async function openProjectFolder(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: '选择 KLP 工程文件夹',
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
  });
  if (!picked?.[0]) {
    return;
  }
  const entry = await chooseEntry(picked[0].fsPath);
  if (entry) {
    await loadProject(entry);
  }
}

async function openWorkspaceProject(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const entries = await discoverEntries(folder.uri.fsPath).catch(() => []);
    if (entries.length === 0) {
      continue;
    }
    const entry = entries.length === 1 ? entries[0]?.path : await chooseEntry(folder.uri.fsPath);
    if (entry) {
      await loadProject(entry);
      return;
    }
  }
  void vscode.window.showWarningMessage('当前工作区没有 .mgp 项目入口文件。请先打开 KLP 工程文件夹。');
}

function dirtyStTargets(): string[] {
  const snapshot = controller.currentSnapshot;
  const draft = controller.viewState?.draft;
  if (!snapshot || !draft) {
    return [];
  }
  const plan = buildPlan({ snapshot, draft });
  const targets = new Set(
    [
      ...plan.programWrites.map((item) => item.path),
      ...plan.programMoves.flatMap((item) => [item.fromPath, item.toPath]),
      ...plan.programDeletes.map((item) => item.path),
    ]
      .filter(Boolean)
      .map((item) => item.toLowerCase()),
  );
  return vscode.workspace.textDocuments
    .filter((document) => document.isDirty)
    .filter((document) => {
      const target = document.uri.scheme === ST_SCHEME ? filePathOf(document.uri) : document.uri.fsPath;
      return targets.has(target.toLowerCase());
    })
    .map((document) => (document.uri.scheme === ST_SCHEME ? filePathOf(document.uri) : document.uri.fsPath));
}

async function saveWithUi(force = false): Promise<void> {
  if (!controller.hasProject) {
    void vscode.window.showWarningMessage('先打开 KLP 工程。');
    return;
  }
  const dirty = dirtyStTargets();
  if (dirty.length > 0) {
    void vscode.window.showWarningMessage(
      `以下 ST 文件在编辑器中有未保存修改，请先在 VS Code 中保存（Ctrl+S）再执行插件保存：\n${dirty.join('\n')}`,
    );
    return;
  }
  const outcome = await controller.save({ force });
  switch (outcome.kind) {
    case 'ok': {
      refreshTree();
      updateStatusBar();
      updatePanelTitle(`KLP: ${controller.currentSnapshot?.project.name ?? ''}`);
      languageFeatures.refreshAll();
      const message = ['保存成功。', ...outcome.warnings].join('\n');
      void vscode.window.showInformationMessage(message);
      break;
    }
    case 'conflict': {
      const choice = await vscode.window.showWarningMessage(
        outcome.message,
        { modal: true },
        '重新加载',
        '覆盖保存',
      );
      if (choice === '重新加载') {
        await controller.reload();
        refreshTree();
        updateStatusBar();
        languageFeatures.refreshAll();
      } else if (choice === '覆盖保存') {
        await saveWithUi(true);
      }
      break;
    }
    case 'planError': {
      void vscode.window.showErrorMessage(`无法保存：${outcome.message}`);
      break;
    }
    default: {
      void vscode.window.showErrorMessage(`保存失败：${outcome.message}`);
    }
  }
}

async function discardDraft(): Promise<void> {
  if (controller.pendingCount === 0) {
    void vscode.window.showInformationMessage('没有未保存的修改。');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `放弃 ${controller.pendingCount} 项未保存的修改？`,
    { modal: true },
    '放弃修改',
  );
  if (choice === '放弃修改') {
    controller.discard();
    updateStatusBar();
  }
}

async function renameProject(): Promise<void> {
  const snapshot = controller.currentSnapshot;
  if (!snapshot) {
    void vscode.window.showWarningMessage('先打开 KLP 工程。');
    return;
  }
  const currentName = snapshot.project.name;
  const value = await vscode.window.showInputBox({
    title: 'KLP: 工程改名',
    prompt: '将同时修改项目名称、.mgp 文件名和工程根目录名；设备 DataDir 与设备内部名称保持不变。',
    value: currentName,
    validateInput: (input) => {
      const issue = validateProjectName(input);
      return issue?.message;
    },
  });
  if (!value || value.trim() === currentName) {
    return;
  }
  const ops = controller.viewState?.draft.ops.filter((op) => op.kind !== 'project.rename') ?? [];
  controller.setDraft([...ops, { kind: 'project.rename', newName: value.trim() }]);
  updateStatusBar();
  showEditorPanel(extensionContext, controller, { tab: 'project' });
}

async function openEditor(tab?: string, id?: number): Promise<void> {
  if (!controller.hasProject) {
    void vscode.window.showWarningMessage('先执行「KLP: 打开项目」。');
    return;
  }
  const focus = id !== undefined ? { kind: tab ?? 'variables', id } : undefined;
  showEditorPanel(extensionContext, controller, { tab, focus });
}

async function openFile(target: string | undefined): Promise<void> {
  if (!target) {
    return;
  }
  if (target.toLowerCase().endsWith('.stf')) {
    const document = await vscode.workspace.openTextDocument(uriForFile(target));
    if (document.languageId !== 'klp-st') {
      await vscode.languages.setTextDocumentLanguage(document, 'klp-st');
    }
    await vscode.window.showTextDocument(document, { preview: true });
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
  await vscode.window.showTextDocument(document, { preview: true });
}

async function openProgramById(id: number | undefined): Promise<void> {
  const snapshot = controller.currentSnapshot;
  if (!snapshot || id === undefined) {
    void vscode.window.showWarningMessage('先打开 KLP 工程并选择程序。');
    return;
  }
  const index = snapshot.db?.programs.findIndex((program) => program.id === id) ?? -1;
  const layout = dbDeviceLayout(snapshot);
  const source = index >= 0 ? layout?.programs[index] : undefined;
  if (!source?.path) {
    void vscode.window.showErrorMessage('该程序没有可打开的 .stf 源文件。');
    return;
  }
  const document = await vscode.workspace.openTextDocument(uriForFile(source.path));
  if (document.languageId !== 'klp-st') {
    await vscode.languages.setTextDocumentLanguage(document, 'klp-st');
  }
  await vscode.window.showTextDocument(document, { preview: false });
}

/**
 * ST 源文件保存后统一为 GBK + CRLF。
 * VSCode 可能按用户设置写成 UTF-8/LF；KLP 期望 GBK，故以编辑器文本为准回写。
 */
async function normalizeStFile(document: vscode.TextDocument): Promise<void> {
  // klp-st: 虚拟文档由 StFileSystemProvider 负责 GBK 编码；这里只兜底处理直接打开的真实文件。
  if (document.uri.scheme !== 'file' || document.languageId !== 'klp-st') {
    return;
  }
  const text = toCrlf(document.getText());
  const current = await readBytes(document.uri.fsPath).catch(() => undefined);
  let bytes: Uint8Array;
  try {
    bytes = encodeTextLike(current, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`ST 文件包含 GBK 无法表示的字符，未改写磁盘文件：${message}`);
    return;
  }
  if (current && current.length === bytes.length && current.every((byte, index) => byte === bytes[index])) {
    return;
  }
  await writeFileAtomic(document.uri.fsPath, bytes);
}

let extensionContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  extensionUri = context.extensionUri;
  controller = new SessionController(createBridge());
  tree = new ProjectTreeProvider();
  languageFeatures = new StLanguageFeatures(() => controller.currentSnapshot);

  context.subscriptions.push(
    languageFeatures,
    vscode.workspace.registerFileSystemProvider(ST_SCHEME, new StFileSystemProvider(() => controller.currentSnapshot), {
      isCaseSensitive: true,
    }),
    vscode.workspace.registerTextDocumentContentProvider(
      'klp-symbol',
      new SymbolDocProvider(() => controller.currentSnapshot),
    ),
    vscode.window.createTreeView('klp.projectTree', {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),
    vscode.commands.registerCommand('klp.openProject', openProjectFile),
    vscode.commands.registerCommand('klp.openProjectFolder', openProjectFolder),
    vscode.commands.registerCommand('klp.openWorkspaceProject', openWorkspaceProject),
    vscode.commands.registerCommand('klp.refreshProject', async () => {
      await controller.reload();
      refreshTree();
      updateStatusBar();
      languageFeatures.refreshAll();
    }),
    vscode.commands.registerCommand('klp.reloadProject', async () => {
      if (controller.pendingCount > 0) {
        const choice = await vscode.window.showWarningMessage(
          '重新读取工程会丢弃未保存的修改，继续？',
          { modal: true },
          '重新读取',
        );
        if (choice !== '重新读取') {
          return;
        }
      }
      await controller.reload();
      refreshTree();
      updateStatusBar();
      languageFeatures.refreshAll();
    }),
    vscode.commands.registerCommand('klp.openEditor', openEditor),
    vscode.commands.registerCommand('klp.openFile', openFile),
    vscode.commands.registerCommand('klp.openProgram', openProgramById),
    vscode.commands.registerCommand('klp.save', () => saveWithUi()),
    vscode.commands.registerCommand('klp.discardDraft', discardDraft),
    vscode.commands.registerCommand('klp.renameProject', renameProject),
    vscode.workspace.onDidSaveTextDocument((document) => {
      void normalizeStFile(document);
    }),
    controller.onDidChange(() => {
      updateStatusBar();
      languageFeatures.refreshAll();
    }),
  );

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);
  updateStatusBar();

  void vscode.commands.executeCommand('setContext', 'klp.hasProject', false);
  void vscode.commands.executeCommand('setContext', 'klp.dbAvailable', false);
}

export function deactivate(): void {
  // 所有资源已登记到 context.subscriptions。
}

export const lastEntryKey = LAST_ENTRY_KEY;
