# 贡献指南

## 环境要求

- **Windows**：数据库访问依赖 32 位 Windows PowerShell + Jet 4.0/ADO，当前只实现 Windows 路径。
- **Node.js 22 及以上**。
- **npm**：仓库只有 `package-lock.json`，不要引入 pnpm/yarn 锁文件。

## 本地开发

```bash
git clone https://github.com/lilixxs/bs-klp-mgmt.git
cd bs-klp-mgmt
npm install
npm run check
npm test
npm run build
```

按 F5 启动扩展开发宿主，命令面板执行「KLP: 打开项目」选择 `*.mgp`。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run check` | `tsc` + `vue-tsc` 类型检查 |
| `npm test` | `node --test` 运行 `test/*.test.ts` |
| `npm run build` | esbuild 打包扩展、vite 打包 webview |
| `npm run package` | 生成 `dist/bs-klp-mgmt-<版本>.vsix` |
| `npm run watch:ext` / `npm run watch:webview` | 分别监听构建 |

提交前按 `check → test → build` 顺序执行。

## 测试前提

- `npm test` 需要 32 位 Jet 4.0/ADO 与 32 位 PowerShell。缺少组件的机器会失败，**不要用跳过用例、放宽断言或删除测试来通过**。
- 测试只使用合成工程（`test/support/` 与运行时临时目录），不要引入真实工程作为 fixture。
- 回滚与保存一致性改动必须补回归；仅靠类型检查不算验证。

## 代码约定

1. 保存逻辑在 `src/project/plan.ts`（计划）与 `src/project/save.ts`（执行）两层都要校验，缺一层会留下不一致状态。
2. `.mgp` 只做属性定点替换，保留单行布局、CRLF 与 `<Buses />` 写法，不要整树重写。
3. `.stf` 磁盘保持 GBK + CRLF；通过 `klp-st:` 文件系统访问，不要用普通 `file:` 文档编辑。
4. 不写二进制产物：`.IC_` `.vmc` `.xct` `.xtc` `Symbol.txt` `Prjlibrary.bak`。
5. 未证实的字段规则（`CRCInitValue*`、`Hook`、`RefStatus`、`GWDevice.RefDevice`、`RefLocalization`）只允许在工程副本上实验。
6. 所有写入必须限制在工程物理根目录内；新增路径拼接要经过 `src/project/pathSafety.ts` 校验。

## 提交与分支

- 主分支 `main`，通过 Pull Request 合并。
- 提交信息使用前缀：`feat:`、`fix:`、`docs:`、`test:`、`chore:`。
- 不要提交真实工程、客户信息、内网地址、截图证据或本地进度记录；相关内容已被 `.gitignore` 排除。

## 发布

发布使用 VS Code Marketplace 的 Trusted Publishing（OIDC），不需要保存 PAT。

### 自动发布（默认）

推送到 `main` 会触发 `.github/workflows/publish.yml`：

1. `npm run check`、`npm test`、`npm run build`；
2. 全部通过后自动提升补丁版本；
3. `npx @vscode/vsce publish --oidc` 发布；
4. 提交版本号并推送 `v<版本>` 标签。

提交信息包含 `[skip release]` 时只做验证，不升版本、不发布。纯文档改动（`**.md`、`docs/**`）不会触发该工作流。

### 按标签发布（手动）

同一个工作流在推送 `v*` 标签时执行，要求标签与 `package.json` 版本一致，只发布该版本，不升版本。注意：工作流用 `GITHUB_TOKEN` 推送的标签不会再次触发自身，因此自动流程在同一次运行内直接发布。

发布失败的排查顺序：Actions 日志 → 发布者 ID 是否等于 `package.json` 的 `publisher` → 版本是否已被占用。

Marketplace 侧需要在发布者的 **Trusted Publishing** 中创建策略：

- Repository owner：`lilixxs`
- Repository：`bs-klp-mgmt`
- Workflow：`publish.yml`（只有这一个工作流）
- Environment：留空（工作流未使用环境）

同一版本号不能重复发布；发布失败修正后需提升版本或使用新标签。

