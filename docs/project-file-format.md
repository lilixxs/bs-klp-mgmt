# KLP 项目文件格式与解析原理

适用版本：KLP `1.03.00.006`（本仓库参考工程）。未在其他版本验证。
证据来源：`docs/klp-research-2026-11-01-local/`（调研归档，只读）与本仓库实现/测试。文中区分三类结论：

- **观察**：直接读取文件或数据库得到。
- **运行验证**：在本机 VSCode 扩展宿主/测试中实际执行。
- **待验证**：尚未取得运行证据，实现按保守假设处理。

---

## 1. 工程 = 一个文件夹

```text
<工程目录>/
├─ <工程名>.mgp             工程入口（UTF-8 XML，CRLF，单行）
└─ <DataDir>/               设备数据目录（示例 ECP_1）
   ├─ PrjLibrary.mdb        Jet 3 数据库（本仓库的读写对象）
   ├─ Prjlibrary.bak        另一份 Jet 库（插件不读不写）
   ├─ project.gpm           Configuration/Resource/Connect/Network 文本
   ├─ Symbol.txt            编译符号表（二进制头 + 文本；插件只读）
   └─ <ConfigName>/<ResourceName>/
      ├─ <程序名>.stf       ST 源码（GBK + CRLF）
      ├─ *.IC_ *.vmc *.xct *.xtc   编译产物（插件不写）
      └─ ...
```

**观察**：参考工程根目录只有 `<工程名>.mgp` 和 `ECP_1/`；`ECP_1/Config1/Resource1/` 下有 `JNMOD.stf`、`JNMOD.IC_`、`JNMOD.vmc`、`ECS.xct`、`Symbol.txt` 等文件。

插件把“入口 `.mgp` 所在目录”视为工程根目录；`DataDir` 只用于定位设备子目录，不做路径重写。

---

## 2. `.mgp` 入口文件

**观察**（参考工程 3572 字节）：

```xml
<?xml version='1.0' encoding='utf-8'?>
<Project Name="示例工程"><Version>4</Version><IDEVersion>V1.03.00.006</IDEVersion>
  <Description>…</Description><Buses /><Devices><Device Name="ECP" ID="1" RefFamily="6" PN="…">
  <ConfigurationData><StationNumber>1</StationNumber><DataDir>ECP_1</DataDir>…</ConfigurationData>
  <PhyPorts><PhyPort ID="2" Name="Eth1" …><PortData …><IPAddr>…</IPAddr></PortData>…</PhyPort>…</PhyPorts>
  </Device></Devices><RootDevices><RootDevice ID="1" SLID="201" Name="ECP" /></RootDevices></Project>
```

要点：

- 整个文件压成 1 行，CRLF 结尾，`<Buses />` 这类空元素保留 ` />`（斜杠前有空格）。
- 工程名在 `<Project Name="…">` 的 **属性** 上，不是子元素。
- 设备节点属性：`Name ID RefFamily PN`；`ConfigurationData/DataDir` 指设备子目录；`PhyPorts/PhyPort` 是物理端口，`SupportedProtocol` 是协议与角色。
- `.mgp` 不含变量、POU、网关设备清单；这些在数据库里。

写入策略（**运行验证**，见 `test/mgp.test.ts`）：只对 `<Project …>` 起始标签内的 `Name` 属性做文本定点替换，其余字节原样保留；工程改名 = 改属性 + 改名 `.mgp` + 改名根目录，`DataDir` 与设备名不变。

---

## 3. `PrjLibrary.mdb`（Jet 3）

**观察**：文件头为 `Standard Jet DB`，header 偏移 `0x14 = 0`（Jet 3），页大小 2048（3,020,800 字节 = 1475 页；参考工程副本 3,309,568 字节）。

### 3.1 读取/写入通道

- 扩展不直接解析 Jet 页，而是调用随扩展分发的 `media/mdb-helper.ps1`。
- 该脚本由 **32 位 Windows PowerShell** 执行，使用 **Windows 自带 Jet 4.0 Provider + ADO**（`Microsoft.Jet.OLEDB.4.0`）。VSCode 扩展宿主是 64 位，无法直接加载 32 位 Jet，因此必须跨进程。
- 文件与扩展之间只交换 UTF-8 JSON，避免命令行转义与控制台代码页问题。
- 每次调用在临时目录复制一份工作组文件（`System.mdw` 的副本）再打开数据库。原因（**运行验证**）：复用用户共享的 `%APPDATA%\Microsoft\Access\System.mdw` 时，Jet 可能因残留的库锁返回 `Not a valid password`；换成新的工作组副本后同一数据库可正常打开。临时副本随调用目录一起删除。
- 读：`Mode=Read`；写：先复制数据库到同目录临时文件，在临时文件上执行事务，提交后回读校验，再用临时文件替换原库。失败时删除临时文件，原库不变。

### 3.2 代码页与文本

**观察**：库内代码页为 936（中文 GBK）。Jet 通过 ADO 返回 Unicode 字符串；写入时由 Jet 按库代码页存储。`心跳位`、`累计流量`、`水温1` 等中文在读取与回写后保持一致（**运行验证**，`test/mdb.integration.test.ts`）。

### 3.3 使用到的表与字段

变量（`Symbols`）：

| 列 | 含义/用法 |
| --- | --- |
| `RefSymbols` | 自增主键，跨表引用 ID |
| `Name` / `SingleTextLine` / `Alias` | 名称 / 注释 / 别名（样本全空） |
| `RefVarInstance` | 1=普通变量，2=功能块实例（不能把实例的 `RefDefType` 当基本类型解释） |
| `RefResourcePOU` | 全局变量指资源 |
| `RefScope` | 作用域（Global/Local） |
| `RefDefType` | 普通变量 → `Definition type.RefDefType`；功能块实例 → `POUs.RefPOUs` |
| `StringSize` | 字符串长度；基本类型为 0 |
| `RefAttribute` / `RefDirection` | 属性（Read/Write/Free） / 方向（Input/Output/Internal） |
| `RefGroup` | 变量组 |
| `UserAddress` | 本机变量通讯地址（文本，样本为十六进制） |
| `Wiring` | 物理 I/O 组态（`%IR0.0` 等） |
| `IsRetain` / `Order` / `HasDimension` / `InitialValue` | 保持 / 排序 / 数组 / 初始值 |
| `RefLibrary` / `Hook` / `RefStatus` | 样本中多为空/NULL，插件新增时克隆同类型行 |
| `CRCInitValueDim` / `CRCInitValueType` | 初始值维度 / 类型 CRC；普通变量等于 `Definition type.CRC` |

其余表：`Group`、`Definition type`、`VarInstance`、`Scopes`、`Direction`、`Attributes`、`Languages`、`POUs`、`Programs`、`Configurations`、`Resources`、`I/O Symbols`、`GWChannel`、`GWDevice`、`GWDeviceModbus`、`GWVariableMap`、`Project`。

关键关系（调研报告已确认，插件只读/按 ID 维护）：

- 变量 → `I/O Symbols.RefSymbols`（物理 I/O）；`Instance of device` / `I/O device` 给出设备与通道。
- 网关：`GWChannel.RefChannel ← GWDevice.RefChannel`；`GWDevice.RefDevice ← GWDeviceModbus.RefDevice / GWVariableMap.RefDevice`；`Symbols.RefSymbols ← GWVariableMap.RefSymbol`。
- 程序：`POUs`（`RefPOUtype=1`、`RefLanguage=2` 即 ST） + `Programs`（`RefPOUs` 主键）；正文在外部 `.stf`。

### 3.4 写入约束（已实现）

- 所有写操作在一个 Jet 事务中执行；任一失败整体回滚（**运行验证**：重复变量名、删除不存在对象均导致整批回滚）。
- 新增变量/程序时自增 ID 由 Jet 分配，插入后用 `MAX(主键)` 在同一事务内取回。
- 新增变量时 `CRCInitValueType` 取所选 `Definition type.CRC`；`CRCInitValueDim`、`RefLibrary`、`Hook`、`RefStatus` 从同类型既有行克隆（**待验证**：KLP 是否在保存/编译时重算这些字段）。
- 通讯对象 ID：`GWChannel.RefChannel`、`GWVariableMap.RefVariable` 取当前最大值 +1；`GWDevice.RefDevice` 在样本中是很大的整数（203859669、239538309），生成规则**待验证**，插件同样取最大值 +1。KLP 是否接受该 ID 需要回读验证。
- 删除变量前检查：物理 I/O 绑定、`GWVariableMap` 引用、ST 源码引用；任一存在则阻止并给出原因。删除通道/设备、删除程序同理（设备引用、映射引用、功能块实例引用）。
- 不写 `Prjlibrary.bak`，不修改 `Symbol.txt`、`.IC_`、`.vmc`、`.xct`、`.xtc` 等二进制/编译产物。
- 悬空映射只报告，不自动清理。

---

## 4. `project.gpm` 与独立配置文件

**观察**：`project.gpm` 是纯文本（示例 168 字节），包含 `Configuration:`、`Resource:`、`Connect:`、`Network:` 段；`DDCconf.ini`、`Dic.Ini` 为 GBK。本次实现不写这些文件。

`.mgp` 的 COM 参数（`BaudRate=0`）、数据库网关通道参数（57600）、`PortNetwork.mcf`（9600）是不同位置的三套值，加载优先级未知；插件只改数据库网关通道，不动另外两处。

---

## 5. `.stf` ST 源文件

**观察**（参考工程 `JNMOD.stf`）：

```text
PROGRAM JNMOD\r\n
BLINK2(true,T#1000ms);\r\n
...
END_PROGRAM\r\n
```

- 纯文本、GBK、CRLF；文件名 `<程序名>.stf`，首行 `PROGRAM <程序名>` 必须与数据库注册名一致。
- 插件通过自定义文件系统 `klp-st:` 打开它：磁盘上是 GBK 原始字节；VSCode 端用语言默认 `files.encoding=gbk` 解码/编码；保存时由提供器统一规范为 GBK + CRLF。这样避免 VSCode 把 GBK 当 UTF-8 打开造成替换字符（**运行验证**：中文注释保存后字节为 GBK，内容与 CRLF 保持，原文件前缀逐字节不变）。
- 语言支持（`klp-st`）：TextMate 语法高亮、结构诊断（`PROGRAM` 头缺失/不匹配、`END_PROGRAM` 缺失、块注释/字符串未闭合、未知赋值目标）、变量补全、悬停、文档符号、`Go to Definition` 指向只读的 `klp-symbol:` 变量说明文档。重命名由变量面板统一执行（同时改数据库与全部源文件），语言服务里显式拒绝，避免只改一处。
- 程序新增：写 `PROGRAM <名>\r\n\r\nEND_PROGRAM\r\n` 模板；改名：读现有文件、改写 `PROGRAM` 头、移动文件；只改注释/属性不重写源码文件。

---

## 6. 已知未知项（不要当成已证实规则）

1. KLP 保存/编译时是否重算 `CRCInitValue*`、`Order`、`RefStatus`、`Hook`——未追踪写回路径。
2. `GWDevice.RefDevice` 大整数 ID 的生成规则——未确认；当前取最大 +1。
3. `Prjlibrary.bak` 的生成条件、覆盖范围与恢复能力——未知；插件不写。
4. `.mgp` 中 `Description` 等字段的中文编码与超长工程名行为——未测试。
5. KLP 对新增/删除记录后的数据库索引、统计信息、`.bak` 的处理——未在 KLP 内保存后对比。
6. 非 ST 语言程序的写入语义——插件禁止写入。
7. 干净 Windows 机器是否都带 32 位 Jet 4.0/ADO——本机存在（Windows 10.0.26100 版本组件），但没有干净机验证；这是“无需额外安装”交付条件的主要不确定性。


---

## 7. 本轮补充（2026-11-02 运行验证）

- 在独立副本上用原版 KLP 1.03.00.006 重新打开并做内容级核对：变量改名/新增/注释、程序改名/新增、通讯通道/设备/映射新增、设备和通道更新、变量/通道/设备删除、工程整体改名。核对的是 KLP 界面中的名称、类型、组、地址、注释、程序语言与树节点，不是只看“打开无报错”。
- 新增程序时，`POUs.RefLocalization` 不能固定写 0。实测从同资源现有 ST 程序克隆 `RefPOUGroup`、`RefLocalization`、`GenerateDebugInfo`、`Is1499` 后，KLP 程序树才显示新增程序；固定 0 时数据库有记录但 KLP 不显示。
- `Symbols.RefStatus` 的 NULL 必须保留为 NULL。读取时把 DBNull 转成空字符串，会让一次普通变量更新把 NULL 改写成 `''`。
- `klp-st:` 只允许访问数据库已注册的程序源文件；非 ST 源文件可只读打开，但禁止写、删除、改名。原文件带 UTF-8 BOM 时写回保留 BOM。
- 保存层对临时库 `open` 阶段的偶发 `Not a valid password` 会复制新临时库并重试；仍失败则走整体回滚。该现象与共享 `System.mdw`/KLP 占用有关，重试是实测有效的缓解，不是格式结论。
- 以上均为副本 + KLP 重开证据；不等于干净 Windows 依赖验证，也不证明编译或设备运行正确。
