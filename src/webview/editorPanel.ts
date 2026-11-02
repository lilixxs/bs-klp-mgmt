import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { HostToWebMessage, WebToHostMessage } from '../shared/types.ts';
import type { SessionController } from '../ui/controller.ts';

let current: vscode.WebviewPanel | undefined;
let controllerListener: vscode.Disposable | undefined;

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const distDir = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  let html: string;
  try {
    html = readFileSync(vscode.Uri.joinPath(distDir, 'index.html').fsPath, 'utf8');
  } catch {
    return [
      '<!doctype html><html lang="zh-CN"><body>',
      '<p>未找到 dist/webview/index.html。</p>',
      '<p>先执行 <code>npm run build</code>，再重新打开面板。</p>',
      '</body></html>',
    ].join('');
  }

  const nonce = randomBytes(16).toString('base64');
  const withUris = html.replace(/(src|href)="\.\/([^"]+)"/g, (_match, attribute: string, relative: string) => {
    const uri = webview.asWebviewUri(vscode.Uri.joinPath(distDir, relative));
    return `${attribute}="${uri}"`;
  });
  const withNonce = withUris.replace(/<script /g, `<script nonce="${nonce}" `);
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return withNonce.replace(
    '<head>',
    `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`,
  );
}

function post(message: HostToWebMessage): void {
  if (!current) {
    return;
  }
  void current.webview.postMessage(message);
}

function pushState(controller: SessionController): void {
  const state = controller.viewState;
  if (!state) {
    return;
  }
  post({ type: 'state', payload: state });
}

export function hasPanel(): boolean {
  return Boolean(current);
}

export function showEditorPanel(
  context: vscode.ExtensionContext,
  controller: SessionController,
  options: { tab?: string; focus?: { kind: string; id?: number } } = {},
): void {
  if (!controller.hasProject) {
    void vscode.window.showWarningMessage('先执行「KLP: 打开项目」。');
    return;
  }
  if (options.tab) {
    controller.setActiveView(options.tab as never, options.focus);
  }

  if (current) {
    current.reveal();
    pushState(controller);
    return;
  }

  const snapshot = controller.currentSnapshot;
  const panel = vscode.window.createWebviewPanel(
    'klp.editor',
    snapshot ? `KLP: ${snapshot.project.name}` : 'KLP',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
    },
  );
  panel.webview.html = renderHtml(panel.webview, context.extensionUri);

  panel.webview.onDidReceiveMessage((message: WebToHostMessage) => {
    switch (message.type) {
      case 'ready':
        pushState(controller);
        break;
      case 'replaceDraft':
        controller.setDraft(message.payload.ops);
        break;
      case 'save':
        void vscode.commands.executeCommand('klp.save');
        break;
      case 'discard':
        void vscode.commands.executeCommand('klp.discardDraft');
        break;
      case 'reload':
        void vscode.commands.executeCommand('klp.reloadProject');
        break;
      case 'openProgram':
        void vscode.commands.executeCommand('klp.openProgram', message.payload.id);
        break;
      default:
        break;
    }
  });

  controllerListener?.dispose();
  controllerListener = controller.onDidChange(() => pushState(controller));

  panel.onDidDispose(() => {
    controllerListener?.dispose();
    controllerListener = undefined;
    current = undefined;
  });

  current = panel;
}

export function updatePanelTitle(title: string): void {
  if (current) {
    current.title = title;
  }
}

export function disposePanel(): void {
  current?.dispose();
  current = undefined;
}
