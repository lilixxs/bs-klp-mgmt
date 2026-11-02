# AGENTS.md

VSCode 扩展：管理、编辑 KLP 工控软件的项目文件夹。

## 范围边界

- 只改本地项目文件：项目树、项目改名、程序编辑器、变量编辑器、通讯配置编辑器。
- ST 源码用 VS Code 原生编辑器打开（`klp-st:` 自定义文件系统 + `klp-st` 语言），插件提供语法/诊断/补全/悬停/定义等语言能力；不另做富文本编辑器。
- 不做设备连接、编译、下载。
- 未列出的功能先问，不要顺手实现。

## 数据事实（已在真实工程上验证）

- 项目 = 一个文件夹。入口是文件夹根目录下的 `<项目名>.mgp`。
- `.mgp` 是 UTF-8 XML：声明 `encoding='utf-8'`，CRLF，全文件压成 1 行。工程名是 `<Project Name="…">` 的**属性**；结构为 `Version` / `IDEVersion` / `Description` / `Buses` / `Devices` / `RootDevices`。
- `Device` 带属性 `Name ID RefFamily PN`；`ConfigurationData/DataDir` 给出设备子目录名；`PhyPorts/PhyPort` 存物理端口，`SupportedProtocols/SupportedProtocol` 存协议与角色。
- 设备子目录里：`PrjLibrary.mdb`（Jet 3，页大小 2048）、`Prjlibrary.bak`、`project.gpm`（纯文本）、`Config1/Resource1/` 下的 `.stf`（GBK + CRLF 的 ST 源码）与 `.IC_` `.vmc` `.xct` `.xtc`（编译产物）、`Symbol.txt`（NUL 填充头 + 文本）。
- 数据库：`Symbols` 存变量，`POUs`/`Programs` 存程序注册，`GWChannel`/`GWDevice`/`GWDeviceModbus`/`GWVariableMap` 存网关配置，`I/O Symbols`/`Instance of device`/`I/O device` 存物理 I/O。详见 `docs/project-file-format.md`。
- 编码不统一：`.mgp` 是 UTF-8；`.stf`、`DDCconf.ini`、`Dic.Ini` 是 GBK。按原编码读写。

## 数据访问方式（重要）

- 数据库由 `media/mdb-helper.ps1` 经 **32 位 Windows PowerShell + Windows 自带 Jet 4.0/ADO** 读写；扩展宿主是 64 位，不能直接加载 32 位 Jet。
- 请求/响应都是 UTF-8 JSON 临时文件，不经命令行传文本。
- **每次调用**在临时目录复制一份 Jet 工作组文件（`System.mdw` 副本）：复用用户共享的 `System.mdw` 会因残留库锁报 `Not a valid password`（已实测）。不要改回共享工作组。
- 读取用只读打开；写入先复制数据库到临时文件，事务提交并回读校验后用临时文件替换原库。失败不得留下半写状态。
- 依赖前提：目标 Windows 存在 32 位 Jet/ADO 与 32 位 PowerShell。当前开发机满足，干净机未验证，不要在文档或答复中把它说成已证明。
- `.stf` 通过 `klp-st:` 文件系统提供器读写：磁盘保持 GBK；VSCode 文档用 `[klp-st].files.encoding=gbk` 解释。不要在普通 `file:` 文档里编辑 `.stf`（会按 UTF-8 解码损坏中文）。

## 硬性约束

1. 写回保真。读可以解析成摘要；写不能用解析结果重建 XML。要保留单行布局、CRLF、`<Buses />` 这类自闭合写法（注意 ` />` 前有空格）。只做文本定点替换。
2. 二进制文件（`.mdb` 除外的 `.bak` `.vmc` `.xct` `.IC_` `.xtc` `Symbol.txt`）默认只读。拿不到格式证据就不写。
3. 每个格式结论都要能在参考工程里复现。没验证的写进文档时标 `待验证`。
4. 测试用合成 fixture（`test/fixtures/` 或测试运行时生成的临时工程）。不要把真实工程文件、客户名称、内网 IP 拷进仓库。
5. `package.json` 不设 `"type": "module"`。扩展打包成 CJS，webview 单独按 ESM 构建。
6. 新增记录时 KLP 专用字段（`CRCInitValue*`、`Hook`、`RefStatus`、`GWDevice.RefDevice`）仍属未证实规则：只允许在副本上实验，不得当作已证实的写入协议。
7. KLP 的上位自动化受完整性/UIPI 限制；不要把“KLP 打开无报错截图”当成内容级回读证据。

## 目录

| 路径 | 作用 |
| --- | --- |
| `src/extension.ts` | 入口：命令、树、状态栏、ST 语言服务与文件系统注册 |
| `src/project/mgpParser.ts` | 解析 `.mgp`；`renameProjectInMgp` 做属性定点替换 |
| `src/project/session.ts` | 打开工程：目录定位、数据库读取、`.stf` 读取、诊断、文件戳 |
| `src/project/plan.ts` | 草稿 → 校验 → 写计划（纯函数，可单测） |
| `src/project/save.ts` | 执行写计划：冲突检测、临时库事务、文件回滚、工程改名 |
| `src/mdb/jet.ts` | 32 位 PowerShell 助手桥（JSON 协议、临时工作组） |
| `src/st/` | ST 分析、语言提供器、`klp-st:` 文件系统、变量说明虚拟文档 |
| `src/shared/types.ts` | 扩展与 webview 共用的模型；禁止 import `vscode` 或 DOM |
| `src/tree/projectTree.ts` | 项目树 |
| `src/ui/controller.ts` | 快照/草稿/保存状态 |
| `src/webview/editorPanel.ts` | 面板宿主：读 `dist/webview/index.html`，重写资源 URI、注入 CSP nonce |
| `media/mdb-helper.ps1` | Jet 读写助手（ASCII，UTF-8 JSON 协议） |
| `syntaxes/klp-st.tmLanguage.json` | ST TextMate 语法 |
| `language-configuration.json` | ST 注释/括号/缩进/折叠 |
| `webview/` | Vue 3 前端，Vite 的 root |
| `test/` | `node:test` 回归；`test/support/` 为合成工程与 Jet fixture 生成器 |
| `scripts/package-vsix.mjs` | 离线生成可安装 `.vsix` |
| `dist/` | 构建产物，不进版本库 |

## 命令

本机只有 npm，没有 pnpm/yarn。

- `npm run check`：`tsc` + `vue-tsc` 类型检查。改完先跑。
- `npm test`：`node --test` + 类型剥离，跑 `test/*.test.ts`（含 Jet 集成测试；需要 32 位 Jet + PowerShell）。
- `npm run build`：双端构建。esbuild → `dist/extension.js`；vite → `dist/webview/`。
- `npm run package`：生成 `dist/bs-klp-mgmt-<版本>.vsix`。
- `npm run watch:ext` / `npm run watch:webview`：分别监听。

验证顺序：`check` → `test` → `build` → `package`。F5 走 `.vscode/launch.json`，`preLaunchTask` 会自动 build。

## 调试要点

- 命令面板执行「KLP: 打开项目」选 `*.mgp`，或用「KLP: 打开工程文件夹」「KLP: 打开当前工作区工程」。
- 改 webview 后必须 `npm run build:webview` 再重开面板。扩展宿主不会热更新 `dist/`。
- 测试文件必须用显式 `.ts` 后缀导入源码（如 `../src/project/mgpParser.ts`），Node 类型剥离不支持省略扩展名。
- PATH 上的 `code` 指向 `C:\Program Files (x86)\Microsoft VS Code`（1.32.3 旧版）。用 `npm run` 和 F5，不要依赖 `code` CLI 装扩展；安装 VSIX 用 `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd`。
- 用 Playwright 连 `--remote-debugging-port=9333` 驱动 VSCode 时，webview 是 `vscode-webview://` 里的 `active-frame`；命令面板需要先点一下编辑器区域获得焦点。
- KLP 进程若以 High 完整性运行，Medium 权限无法关闭或发送输入；`__COMPAT_LAYER=RunAsInvoker` 可让 KLP 以 Medium 启动（本机实测可打开工程，但自绘界面上的像素点击不一定生效）。

## 参考工程（只读，不在仓库内）

本地保存一份已脱敏的参考工程，结构为：入口 <工程名>.mgp，设备 ECP，DataDir 指向设备目录，含 9 个端口（3 个以太网口、6 个串口）。具体路径、工程名与网络参数不写入仓库。

## 本轮补充（2026-11-02，副本 + KLP 重开验证）

- 新增程序除常规 POU 字段外，必须从同资源现有 ST 程序克隆 `RefPOUGroup`、`RefLocalization`、`GenerateDebugInfo`、`Is1499`。固定 `RefLocalization=0` 时 KLP 程序树不显示新增程序（数据库记录存在）。
- `Symbols.RefStatus` 的 NULL 必须保留为 NULL；不要用空字符串替代。
- `klp-st:` 只允许数据库已注册的程序源文件；非 ST 只读，禁止写/删除/改名；UTF-8 BOM 写回保留。
- 保存层对临时库 open 阶段偶发 `Not a valid password` 会换新临时库重试，仍失败则整体回滚。

### 后续补充（2026-11-02 晚）

- 新增/改名程序的目标文件必须做存在性校验；变量改名只能更新文本，不能清除写入项的 `fromPath` 来源标记，否则未注册 `.stf` 会被覆盖。
- 工程打开、保存前和 `klp-st:` 读写都要用 realpath 校验数据目录/资源目录/库/源文件在工程物理根内；DataDir 只接受单层目录名。项目根 rename 是父目录操作，但根自身是 junction 时不能整体 rename。
- `Programs` 表缺行时拒绝 program.update/delete；端口没有既有网关通道时拒绝新增/改指，避免 KLP 不显示。
- 新增/改名程序目标冲突的规则在 plan 与 save 两层都要有；回滚失败必须报告未恢复的数据库/源码现场。
