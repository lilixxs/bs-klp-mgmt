import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ProjectSnapshot } from '../shared/types.ts';
import { analyzeSt, collectIdentifiers, ST_BUILTINS, ST_KEYWORDS, ST_TYPES, wordAt } from './analysis.ts';
import { filePathOf, ST_SCHEME } from './fileProvider.ts';
import { buildStContext, variableMarkdown } from './index.ts';

const LANGUAGE = 'klp-st';

export class StLanguageFeatures implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('klp-st');
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly getSnapshot: () => ProjectSnapshot | undefined) {
    this.registerProviders();
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => this.schedule(document)),
      vscode.workspace.onDidChangeTextDocument((event) => this.schedule(event.document)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.diagnostics.delete(document.uri);
      }),
    );
    for (const document of vscode.workspace.textDocuments) {
      this.schedule(document);
    }
  }

  /** 工程数据变化后重新计算所有打开的 ST 文件。 */
  refreshAll(): void {
    for (const document of vscode.workspace.textDocuments) {
      this.schedule(document, 0);
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.diagnostics.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private registerProviders(): void {
    const selector: vscode.DocumentSelector = [
      { language: LANGUAGE, scheme: 'file' },
      { language: LANGUAGE, scheme: ST_SCHEME },
    ];
    this.disposables.push(
      vscode.languages.registerCompletionItemProvider(selector, {
        provideCompletionItems: (document, position) => this.completions(document, position),
      }),
      vscode.languages.registerHoverProvider(selector, {
        provideHover: (document, position) => this.hover(document, position),
      }),
      vscode.languages.registerDefinitionProvider(selector, {
        provideDefinition: (document, position) => this.definition(document, position),
      }),
      vscode.languages.registerDocumentSymbolProvider(selector, {
        provideDocumentSymbols: (document) => this.documentSymbols(document),
      }),
      vscode.languages.registerRenameProvider(selector, {
        prepareRename: () => {
          throw new Error('KLP 变量改名请在「KLP 编辑器 → 变量」中执行，以便同步数据库与全部 ST 源文件。');
        },
        provideRenameEdits: () => {
          throw new Error('KLP 变量改名请在「KLP 编辑器 → 变量」中执行。');
        },
      }),
    );
  }

  private schedule(document: vscode.TextDocument, delay = 200): void {
    if (document.languageId !== LANGUAGE) {
      return;
    }
    if (document.uri.scheme !== 'file' && document.uri.scheme !== ST_SCHEME) {
      return;
    }
    const key = document.uri.toString();
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.update(document);
    }, delay);
    this.timers.set(key, timer);
  }

  private context(document: vscode.TextDocument) {
    const blockName = path.basename(filePathOf(document.uri), path.extname(filePathOf(document.uri)));
    return buildStContext(this.getSnapshot(), blockName);
  }

  private update(document: vscode.TextDocument): void {
    const context = this.context(document);
    const diagnostics = analyzeSt(document.getText(), context).map((item) => {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(document.positionAt(item.start), document.positionAt(item.end)),
        item.message,
        item.severity === 'error'
          ? vscode.DiagnosticSeverity.Error
          : item.severity === 'warning'
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Information,
      );
      diagnostic.code = item.code;
      diagnostic.source = 'KLP';
      return diagnostic;
    });
    this.diagnostics.set(document.uri, diagnostics);
  }

  private completions(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const context = this.context(document);
    const variables = [...context.variables.values()].map((variable) => {
      const item = new vscode.CompletionItem(variable.name, vscode.CompletionItemKind.Variable);
      item.detail = variable.typeName;
      if (variable.comment) {
        item.documentation = new vscode.MarkdownString(variableMarkdown(variable));
      }
      item.sortText = `0_${variable.name}`;
      return item;
    });
    const types = ST_TYPES.map((type) => {
      const item = new vscode.CompletionItem(type, vscode.CompletionItemKind.TypeParameter);
      item.detail = '基本类型';
      item.sortText = `2_${type}`;
      return item;
    });
    const keywords = ST_KEYWORDS.map((keyword) => {
      const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
      item.sortText = `3_${keyword}`;
      return item;
    });
    const builtins = ST_BUILTINS.map((name) => {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
      item.detail = '标准函数';
      item.sortText = `1_${name}`;
      return item;
    });
    const blocks = [...context.functionBlocks].map((name) => {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
      item.detail = '功能块';
      item.sortText = `1_${name}`;
      return item;
    });
    const localWords = collectIdentifiers(document.getText())
      .filter((word) => !context.variables.has(word.toLowerCase()))
      .map((word) => {
        const item = new vscode.CompletionItem(word, vscode.CompletionItemKind.Text);
        item.sortText = `4_${word}`;
        return item;
      });
    return [...variables, ...blocks, ...builtins, ...types, ...keywords, ...localWords];
  }

  private hover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const found = wordAt(document.getText(), document.offsetAt(position));
    if (!found) {
      return undefined;
    }
    const context = this.context(document);
    const variable = context.variables.get(found.word.toLowerCase());
    if (variable) {
      const range = new vscode.Range(document.positionAt(found.start), document.positionAt(found.end));
      return new vscode.Hover(new vscode.MarkdownString(variableMarkdown(variable)), range);
    }
    const keyword = ST_KEYWORDS.find((item) => item.toLowerCase() === found.word.toLowerCase());
    if (keyword) {
      return new vscode.Hover(new vscode.MarkdownString(`**${keyword}** · ST 关键字`));
    }
    return undefined;
  }

  private definition(document: vscode.TextDocument, position: vscode.Position): vscode.Location | undefined {
    const found = wordAt(document.getText(), document.offsetAt(position));
    if (!found) {
      return undefined;
    }
    const context = this.context(document);
    const variable = context.variables.get(found.word.toLowerCase());
    if (!variable) {
      return undefined;
    }
    const uri = vscode.Uri.parse(`klp-symbol:/${encodeURIComponent(variable.name)}`);
    return new vscode.Location(uri, new vscode.Position(0, 0));
  }

  private documentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const text = document.getText();
    const match = /^[ \t]*PROGRAM[ \t]+([A-Za-z_][A-Za-z0-9_]*)/im.exec(text);
    if (!match) {
      return [];
    }
    const name = match[1] ?? '';
    const start = document.positionAt(match.index);
    const end = document.positionAt(Math.min(text.length, match.index + match[0].length));
    const symbol = new vscode.DocumentSymbol(name, 'ST 程序', vscode.SymbolKind.Function, new vscode.Range(start, end), new vscode.Range(start, end));
    return [symbol];
  }
}
