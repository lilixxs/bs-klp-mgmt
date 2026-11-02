# 干净 Windows 上的 VSIX 安装与运行验收（脱敏）

本材料用于验证“只安装 VS Code 与本插件即可读写 KLP 工程”，不要求 Office、Access、ACE 驱动或 Java。它不包含真实工程、客户名称或网络配置；执行时请使用自己创建的独立工程副本。

## 1. 环境记录

在目标 Windows 机器上以普通用户运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-runtime.ps1
```

脚本只读检查：

- 是否为 64 位 Windows，是否存在 32 位 Windows PowerShell；
- `SysWOW64\msjet40.dll`、`SysWOW64\msjetoledb40.dll` 与 32 位 ADO `msado15.dll`；
- 是否能创建 32 位 `ADODB.Connection` COM 对象；Jet provider 的 DLL 是否存在；
- `System.mdw` 候选位置是否存在；
- 仅记录 Office/Java 是否存在，不作为依赖判据。

把输出保存为 JSON 或文本，记录 Windows 版本、机器是否装有 Office/Access/ACE/Java。当前开发机的探查结果在 `PROGRESS.md` I.7 与临时证据目录中，不能代替干净机结果。

## 2. 安装

```powershell
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" --install-extension .\bs-klp-mgmt-0.1.0.vsix
```

在隔离的 VSCode 用户数据/扩展目录中重复安装时，需先完全退出该 VSCode 实例；必要时使用新的 `--user-data-dir`/`--extensions-dir`。

## 3. 工程副本

1. 在目标机器上新建/复制一个独立 KLP 工程目录，入口 `.mgp`、`DataDir` 与 `PrjLibrary.mdb` 齐全。
2. 打开 VSCode，执行「KLP: 打开项目」或「KLP: 打开当前工作区工程」。
3. 记录状态栏、变量/程序/通讯数量与诊断。
4. 在副本上做变量改名、程序改名、通道新增（仅已有通道占用的端口）、映射新增/删除、工程改名；每一步保存后重新打开工程，必要时用原版 KLP 重新打开核对。

## 4. 失败判据

- 缺少 32 位 Jet/ADO/PowerShell 或 `ADODB.Connection` 无法设置 Jet Provider：记录错误与系统版本，**不要安装组件或提权绕过**；该环境不满足“无需额外安装”的交付条件。
- `Not a valid password`：确认插件使用临时工作组副本并重试；记录 `System.mdw` 位置与是否被 KLP 占用。
- 工程物理路径包含 junction/symlink 指向工程外：插件应报告 `path.outsideProject` 并禁止保存；不要通过改权限绕过。
- 任何写入失败都必须核对数据库、`.stf`、入口和目录没有部分提交；保留失败日志和原始副本哈希。

## 5. 证据边界

本材料只规定可复跑的检查步骤。干净 Windows 的实际退出码、脚本输出、VSIX 哈希、VSCode/KLP 截图与文件差异必须由目标机产生；本仓库不把开发机结果或“打开无报错”截图当作干净机证明。
