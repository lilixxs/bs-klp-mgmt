# bs-klp-mgmt（KLP 项目管理）

VSCode 扩展，用于管理与编辑 KLP 工控软件的单机项目文件夹。KLP 工程是一个文件夹：入口为根目录下的 `<工程名>.mgp`（UTF-8 XML），设备数据目录由 `ConfigurationData/DataDir` 指定，其中 `PrjLibrary.mdb` 是 Jet 3 数据库（变量、程序注册、通讯网关配置、物理 I/O），ST 源码为资源目录下的 `.stf` 文件（GBK + CRLF）。格式细节见 `docs/project-file-format.md`。

## 当前状态

- 功能按既定方案实现；核心写入路径有合成工程的 `node:test` 回归，并在真实 VSCode 扩展宿主 + 原版 KLP 副本上做过内容级回读核对（改名/新增/删除后在 KLP 中核对界面与树节点，不是只看“打开无报错”）。
- **“无需额外运行环境”的干净 Windows 验证尚未完成，标注为待验证。** 验收步骤已写入 `docs/clean-windows-vsix-acceptance.md`，但该文档只规定可复跑的检查项，不代表已通过；不得据此宣称“已通过 / 完全可用”。
- 数据库写入中仍有若干字段规则未证实（如 `CRCInitValue*`、`Hook`、`RefStatus`、`GWDevice.RefDevice` 的生成与 KLP 是否重算），见 `docs/project-file-format.md` 第 6 节。

## 功能

| 功能 | 说明 |
| --- | --- |
| 打开工程 | 「KLP: 打开项目」选择 `.mgp`（支持多选）；另有「打开工程文件夹」「打开当前工作区工程」 |
| 项目树 | 资源管理器侧边栏 `KLP 项目` 视图，含刷新 / 重新读取 |
| 变量 | 新增、删除、改名（改名同时更新数据库与全部 ST 源文件） |
| ST 程序 | 新增、删除、改名；**仅限 ST 语言**，非 ST 源文件只读，禁止写 / 删 / 改名 |
| 通讯配置 | 网关通道、网关设备、变量映射的增删改 |
| 工程整体改名 | 同步改目录名、`.mgp` 文件名与 `<Project Name>` 属性；`DataDir` 与设备名不变 |
| 保存 / 放弃 | 草稿 → 校验 → 写计划 → 冲突检测 → 事务写入；可整体放弃未保存修改 |
| ST 编辑 | `klp-st` 语言（TextMate 语法、诊断、补全、悬停、定义），经 `klp-st:` 文件系统按 GBK 读写 `.stf` |

保存层使用临时数据库副本执行事务，提交并回读校验后替换原库；失败不留下半写状态，必要时回滚并报告未恢复现场。

## 不做的事

- 不连接设备、不编译、不下载。
- 不写二进制编译产物（`.IC_` `.vmc` `.xct` `.xtc`）与 `Symbol.txt`。
- 不写 `Prjlibrary.bak`。
- 不写 `project.gpm`、`DDCconf.ini`、`Dic.Ini` 等配置文件。

## 依赖与前提

- Windows（依赖 32 位 Windows PowerShell + 系统自带 Jet 4.0 / ADO 读写 `.mdb`）。
- VSCode 扩展宿主是 64 位，无法直接加载 32 位 Jet，因此数据库访问由 `media/mdb-helper.ps1` 跨进程完成，双方以 UTF-8 JSON 临时文件通信；每次调用使用临时的 `System.mdw` 工作组副本。
- 当前开发机满足 32 位 Jet / ADO / PowerShell 条件；**干净机器是否自带这些组件未经验证**，属“无需额外安装”交付条件的主要不确定性。

## 开发命令

本机只有 npm，没有 pnpm / yarn。

```bash
npm install         # 安装依赖
npm run check       # tsc + vue-tsc 类型检查
npm test            # node --test 回归（含 Jet 集成测试，需 32 位 Jet + PowerShell）
npm run build       # esbuild 打包扩展 + vite 构建 webview
npm run package     # 生成 dist/bs-klp-mgmt-<版本>.vsix（离线）
```

验证顺序：`check` → `test` → `build` → `package`。改 webview 后需 `npm run build:webview` 再重开面板；扩展宿主不会热更新 `dist/`。调试用 F5（`.vscode/launch.json`，`preLaunchTask` 自动 build）。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `src/extension.ts` | 入口：命令、树、状态栏、ST 语言服务与文件系统注册 |
| `src/project/mgpParser.ts` | 解析 `.mgp`；工程改名做属性定点替换 |
| `src/project/session.ts` | 打开工程：目录定位、数据库读取、`.stf` 读取、诊断 |
| `src/project/plan.ts` | 草稿 → 校验 → 写计划（纯函数） |
| `src/project/save.ts` | 执行写计划：冲突检测、临时库事务、文件回滚、工程改名 |
| `src/mdb/jet.ts` | 32 位 PowerShell 助手桥（JSON 协议、临时工作组） |
| `src/st/` | ST 分析、语言提供器、`klp-st:` 文件系统、变量说明虚拟文档 |
| `src/shared/types.ts` | 扩展与 webview 共用模型（不 import `vscode` 或 DOM） |
| `src/tree/projectTree.ts` | 项目树 |
| `src/ui/controller.ts` | 快照 / 草稿 / 保存状态 |
| `src/webview/editorPanel.ts` | 面板宿主（CSP nonce、资源 URI 重写） |
| `media/mdb-helper.ps1` | Jet 读写助手（ASCII，UTF-8 JSON 协议） |
| `syntaxes/klp-st.tmLanguage.json` | ST TextMate 语法 |
| `language-configuration.json` | ST 注释 / 括号 / 缩进 / 折叠 |
| `webview/` | Vue 3 前端（Vite root） |
| `test/` | `node:test` 回归；`test/support/` 为合成工程与 Jet fixture 生成器 |
| `scripts/package-vsix.mjs` | 离线生成可安装 `.vsix` |
| `docs/` | 项目文件格式说明、验收步骤等文档 |
| `dist/` | 构建产物，不进版本库 |

## 数据与隐私

- 仓库不含真实工程文件、客户名称、内网 IP 或网络配置。
- 参考工程与调研归档保存在仓库外，不入库；文档中的示例均为脱敏/合成内容。
- 测试使用 `test/fixtures/` 或测试运行时生成的合成工程，不拷贝真实工程。

## 许可证

待定。
