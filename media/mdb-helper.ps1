param(
  [Parameter(Mandatory = $true)][string]$RequestPath,
  [Parameter(Mandatory = $true)][string]$ResponsePath
)
# KLP project database bridge for 32-bit Windows Jet 4.0 (ADO).
# All data crosses the boundary as UTF-8 JSON; this file stays ASCII-only.
$ErrorActionPreference = 'Stop'
$script:result = [ordered]@{ ok = $false }

function Write-Response {
  $json = $script:result | ConvertTo-Json -Depth 12 -Compress
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($ResponsePath, $json, $utf8)
}

function Fail([string]$stage, [string]$message) {
  $script:result.ok = $false
  $script:result.stage = $stage
  $script:result.error = $message
  Write-Response
  exit 0
}

function SqlStr($value) {
  if ($null -eq $value -or ($value -is [System.DBNull])) { return 'NULL' }
  $text = [string]$value
  return "'" + $text.Replace("'", "''") + "'"
}

function SqlNum($value) {
  if ($null -eq $value -or ($value -is [System.DBNull])) { return 'NULL' }
  if ($value -is [string] -and $value.Trim() -eq '') { return 'NULL' }
  return [string]([double]$value)
}

function SqlBool($value) {
  if ($null -eq $value) { return 'NULL' }
  if ([bool]$value) { return 'True' }
  return 'False'
}

function SqlId($value) {
  if ($null -eq $value -or ($value -is [System.DBNull])) { return 'NULL' }
  if ($value -is [string] -and $value.Trim() -eq '') { return 'NULL' }
  return [string][long]$value
}

function Get-SystemDbCandidates {
  $list = New-Object System.Collections.ArrayList
  if ($script:workgroupPath -and (Test-Path -LiteralPath $script:workgroupPath)) {
    [void]$list.Add($script:workgroupPath)
  }
  if ($env:APPDATA) {
    [void]$list.Add((Join-Path $env:APPDATA 'Microsoft\Access\System.mdw'))
  }
  [void]$list.Add('C:\Windows\SysWOW64\system.mdw')
  [void]$list.Add('C:\Windows\System32\system.mdw')
  return $list
}

function Initialize-Workgroup([string]$path) {
  if (-not $path) { return }
  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  if (-not (Test-Path -LiteralPath $path)) {
    $source = Join-Path $env:APPDATA 'Microsoft\Access\System.mdw'
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination $path -Force
    }
  }
  $ldb = [System.IO.Path]::ChangeExtension($path, '.ldb')
  if (Test-Path -LiteralPath $ldb) {
    Remove-Item -LiteralPath $ldb -Force -ErrorAction SilentlyContinue
  }
}

function Open-Db([string]$dbPath, [bool]$readOnly) {
  $attempts = New-Object System.Collections.ArrayList
  foreach ($sysdb in (Get-SystemDbCandidates)) {
    if (Test-Path -LiteralPath $sysdb) {
      $mode = if ($readOnly) { 'Mode=Read;' } else { '' }
      [void]$attempts.Add(@{
        cs = "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=$dbPath;Jet OLEDB:System database=$sysdb;User ID=Admin;Password=;$mode"
        systemDb = $sysdb
      })
    }
  }
  $mode = if ($readOnly) { 'Mode=Read;' } else { '' }
  [void]$attempts.Add(@{ cs = "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=$dbPath;User ID=Admin;Password=;$mode"; systemDb = '' })
  [void]$attempts.Add(@{ cs = "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=$dbPath;$mode"; systemDb = '' })

  $errors = New-Object System.Collections.ArrayList
  foreach ($attempt in $attempts) {
    try {
      $conn = New-Object -ComObject ADODB.Connection
      $conn.Open($attempt.cs)
      return @{ conn = $conn; systemDb = $attempt.systemDb }
    } catch {
      [void]$errors.Add($_.Exception.Message)
      try { if ($conn) { $conn.Close() } } catch {}
    }
  }
  throw ("Unable to open database. appdata=" + $env:APPDATA + "; user=" + [System.Environment]::UserName + "; cwd=" + (Get-Location).Path + "; " + ($errors -join ' | '))
}

function Read-Rows($conn, [string]$sql, [string[]]$columns) {
  $rows = New-Object System.Collections.ArrayList
  $rs = $conn.Execute($sql)
  while (-not $rs.EOF) {
    $row = [ordered]@{}
    foreach ($c in $columns) {
      $row[$c] = $rs.Fields.Item($c).Value
    }
    [void]$rows.Add($row)
    $rs.MoveNext()
  }
  $rs.Close()
  return , $rows
}

function Get-Variables($conn) {
  $cols = @('RefSymbols','Name','SingleTextLine','Alias','RefVarInstance','RefResourcePOU','RefScope','RefDefType','StringSize','RefAttribute','RefDirection','RefGroup','UserAddress','Wiring','IsRetain','Order','HasDimension','InitialValue','RefLibrary','Hook','CRCInitValueDim','CRCInitValueType','RefStatus')
  $raw = Read-Rows $conn 'SELECT * FROM [Symbols] ORDER BY [RefSymbols]' $cols
  $out = New-Object System.Collections.ArrayList
  foreach ($r in $raw) {
    [void]$out.Add([ordered]@{
      id = [long]$r.RefSymbols
      name = [string]$r.Name
      comment = [string]$r.SingleTextLine
      alias = [string]$r.Alias
      varInstanceId = [long]$r.RefVarInstance
      resourcePouId = [long]$r.RefResourcePOU
      scopeId = [long]$r.RefScope
      defTypeId = [long]$r.RefDefType
      stringSize = [long]$r.StringSize
      attributeId = [long]$r.RefAttribute
      directionId = [long]$r.RefDirection
      groupId = [long]$r.RefGroup
      userAddress = [string]$r.UserAddress
      wiring = [string]$r.Wiring
      isRetain = [bool]$r.IsRetain
      order = [long]$r.Order
      hasDimension = [bool]$r.HasDimension
      initialValue = [string]$r.InitialValue
      refLibrary = if ($null -eq $r.RefLibrary -or $r.RefLibrary -is [System.DBNull]) { $null } else { [long]$r.RefLibrary }
      hook = if ($null -eq $r.Hook -or $r.Hook -is [System.DBNull]) { $null } else { [long]$r.Hook }
      crcInitValueDim = [long]$r.CRCInitValueDim
      crcInitValueType = [long]$r.CRCInitValueType
      status = if ($null -eq $r.RefStatus -or $r.RefStatus -is [System.DBNull]) { $null } else { [string]$r.RefStatus }
    })
  }
  return , $out
}

function Get-IdNames($conn, [string]$table, [string]$idColumn) {
  $raw = Read-Rows $conn ("SELECT [$idColumn] AS Id, [Name] AS Name FROM [$table]") @('Id','Name')
  $out = New-Object System.Collections.ArrayList
  foreach ($r in $raw) { [void]$out.Add([ordered]@{ id = [long]$r.Id; name = [string]$r.Name }) }
  return , $out
}

function Get-DefinitionTypes($conn) {
  $cols = @('RefDefType','Name','RefDataType','StringSize','CRC','RefLibrary')
  $raw = Read-Rows $conn 'SELECT * FROM [Definition type] ORDER BY [RefDefType]' $cols
  $out = New-Object System.Collections.ArrayList
  foreach ($r in $raw) {
    [void]$out.Add([ordered]@{
      id = [long]$r.RefDefType
      name = [string]$r.Name
      dataType = [long]$r.RefDataType
      stringSize = [long]$r.StringSize
      crc = [long]$r.CRC
      refLibrary = if ($null -eq $r.RefLibrary -or $r.RefLibrary -is [System.DBNull]) { $null } else { [long]$r.RefLibrary }
    })
  }
  return , $out
}

function Get-Snapshot($conn) {
  $data = [ordered]@{}
  $script:block = 'variables'; $data.variables = Get-Variables $conn
  $script:block = 'groups'; $data.groups = Get-IdNames $conn 'Group' 'RefGroup'
  $script:block = 'definitionTypes'; $data.definitionTypes = Get-DefinitionTypes $conn
  $script:block = 'varInstances'; $data.varInstances = Get-IdNames $conn 'VarInstance' 'RefVarInstance'
  $script:block = 'scopes'; $data.scopes = Get-IdNames $conn 'Scopes' 'RefScope'
  $script:block = 'directions'; $data.directions = Get-IdNames $conn 'Direction' 'RefDirection'
  $script:block = 'attributes'; $data.attributes = Get-IdNames $conn 'Attributes' 'RefAttribute'
  $script:block = 'languages'; $data.languages = Get-IdNames $conn 'Languages' 'RefLanguage'

  $pouCols = @('RefPOUs','Name','SingleTextLine','Comment','RefLanguage','RefResource','Order','RefPOUtype','ReadOnly','GenerateSymbMon','Encrypted','RefPOUGroup','RefLocalization','GenerateDebugInfo','Is1499')
  $script:block = 'pous'; $pous = Read-Rows $conn 'SELECT * FROM [POUs] ORDER BY [RefPOUs]' $pouCols
  $programRows = Read-Rows $conn 'SELECT * FROM [Programs]' @('RefPOUs','Order','RefFather')
  $programMeta = @{}
  foreach ($p in $programRows) { $programMeta[[long]$p.RefPOUs] = $p }

  $programs = New-Object System.Collections.ArrayList
  $pouIndex = New-Object System.Collections.ArrayList
  foreach ($p in $pous) {
    [void]$pouIndex.Add([ordered]@{ id = [long]$p.RefPOUs; name = [string]$p.Name; typeId = [long]$p.RefPOUtype })
    if ([long]$p.RefPOUtype -eq 1) {
      $meta = $programMeta[[long]$p.RefPOUs]
      [void]$programs.Add([ordered]@{
        id = [long]$p.RefPOUs
        name = [string]$p.Name
        comment = [string]$p.Comment
        languageId = [long]$p.RefLanguage
        resourceId = [long]$p.RefResource
        order = if ($meta) { [long]$meta.Order } else { [long]$p.Order }
        fatherId = if ($meta) { [long]$meta.RefFather } else { 0 }
        readOnly = [bool]$p.ReadOnly
        generateSymbMon = [bool]$p.GenerateSymbMon
        encrypted = [bool]$p.Encrypted
        refLocalization = if ($null -eq $p.RefLocalization -or $p.RefLocalization -is [System.DBNull]) { 0 } else { [long]$p.RefLocalization }
        refPouGroup = if ($null -eq $p.RefPOUGroup -or $p.RefPOUGroup -is [System.DBNull]) { 0 } else { [long]$p.RefPOUGroup }
        generateDebugInfo = if ($null -eq $p.GenerateDebugInfo -or $p.GenerateDebugInfo -is [System.DBNull]) { $false } else { [bool]$p.GenerateDebugInfo }
        is1499 = if ($null -eq $p.Is1499 -or $p.Is1499 -is [System.DBNull]) { $false } else { [bool]$p.Is1499 }
        hasProgramRow = ($null -ne $meta)
      })
    }
  }
  $data.pous = $pouIndex
  $data.programs = $programs

  $chCols = @('RefChannel','PortNum','Name','Protocol','Interval','Timeout','Retry','Watchtime','DestIP','DestPort','Tcpudp','Baudrate','Databits','Parity','Stopbits','Comments')
  $script:block = 'channels'; $chRaw = Read-Rows $conn 'SELECT * FROM [GWChannel] ORDER BY [RefChannel]' $chCols
  $channels = New-Object System.Collections.ArrayList
  foreach ($r in $chRaw) {
    [void]$channels.Add([ordered]@{
      id = [long]$r.RefChannel; portNum = [long]$r.PortNum; name = [string]$r.Name; protocol = [string]$r.Protocol
      interval = [long]$r.Interval; timeout = [long]$r.Timeout; retry = [long]$r.Retry; watchtime = [long]$r.Watchtime
      destIp = [string]$r.DestIP; destPort = [long]$r.DestPort; tcpudp = [long]$r.Tcpudp
      baudrate = [string]$r.Baudrate; databits = [string]$r.Databits; parity = [string]$r.Parity; stopbits = [string]$r.Stopbits
      comments = [string]$r.Comments
    })
  }
  $data.channels = $channels

  $devCols = @('RefDevice','RefChannel','Name','Protocol','Interval','Comments')
  $script:block = 'devices'; $devRaw = Read-Rows $conn 'SELECT * FROM [GWDevice] ORDER BY [RefDevice]' $devCols
  $mbCols = @('RefDevice','TransMode','Station','TransDelay','ShortFormat','LongFormat','FloatFormat','LongLongFormat','DoubleFloatFormat','SingleCmg','BoolBlockSize','RegBlockSize','Reserved1')
  $mbRaw = Read-Rows $conn 'SELECT * FROM [GWDeviceModbus]' $mbCols
  $mbByDevice = @{}
  foreach ($m in $mbRaw) { $mbByDevice[[long]$m.RefDevice] = $m }
  $devices = New-Object System.Collections.ArrayList
  foreach ($r in $devRaw) {
    $modbus = $null
    $m = $mbByDevice[[long]$r.RefDevice]
    if ($m) {
      $modbus = [ordered]@{
        transMode = [long]$m.TransMode; station = [long]$m.Station; transDelay = [long]$m.TransDelay
        shortFormat = [long]$m.ShortFormat; longFormat = [long]$m.LongFormat; floatFormat = [long]$m.FloatFormat
        longLongFormat = [long]$m.LongLongFormat; doubleFloatFormat = [long]$m.DoubleFloatFormat
        singleCmg = [long]$m.SingleCmg; boolBlockSize = [long]$m.BoolBlockSize; regBlockSize = [long]$m.RegBlockSize
        reserved1 = if ($null -eq $m.Reserved1 -or $m.Reserved1 -is [System.DBNull]) { 0 } else { [long]$m.Reserved1 }
      }
    }
    [void]$devices.Add([ordered]@{
      id = [long]$r.RefDevice; channelId = [long]$r.RefChannel; name = [string]$r.Name
      protocol = [string]$r.Protocol; interval = [long]$r.Interval; comments = [string]$r.Comments; modbus = $modbus
    })
  }
  $data.devices = $devices

  $mapCols = @('RefVariable','RefDevice','RefSymbol','Address','Access')
  $script:block = 'maps'; $mapRaw = Read-Rows $conn 'SELECT * FROM [GWVariableMap] ORDER BY [RefVariable]' $mapCols
  $maps = New-Object System.Collections.ArrayList
  foreach ($r in $mapRaw) {
    [void]$maps.Add([ordered]@{ id = [long]$r.RefVariable; deviceId = [long]$r.RefDevice; symbolId = [long]$r.RefSymbol; address = [string]$r.Address; access = [long]$r.Access })
  }
  $data.maps = $maps

  $ioCols = @('RefSymbols','RefInstance','RefDevice','PhysicalOrder','Order')
  $script:block = 'io'; $ioRaw = Read-Rows $conn 'SELECT * FROM [I/O Symbols] ORDER BY [RefSymbols]' $ioCols
  $io = New-Object System.Collections.ArrayList
  foreach ($r in $ioRaw) {
    [void]$io.Add([ordered]@{ symbolId = [long]$r.RefSymbols; refInstance = [long]$r.RefInstance; refDevice = [long]$r.RefDevice; physicalOrder = [long]$r.PhysicalOrder; order = [long]$r.Order })
  }
  $data.ioBindings = $io

  $script:block = 'resources'; $resRaw = Read-Rows $conn 'SELECT * FROM [Resources] ORDER BY [RefResource]' @('RefResource','RefConfiguration','Name','Address')
  $resources = New-Object System.Collections.ArrayList
  foreach ($r in $resRaw) { [void]$resources.Add([ordered]@{ id = [long]$r.RefResource; configurationId = [long]$r.RefConfiguration; name = [string]$r.Name; address = [string]$r.Address }) }
  $data.resources = $resources

  $script:block = 'configurations'; $cfgRaw = Read-Rows $conn 'SELECT * FROM [Configurations] ORDER BY [RefConfiguration]' @('RefConfiguration','Name')
  $data.configurationName = if ($cfgRaw.Count -gt 0) { [string]$cfgRaw[0].Name } else { 'Config1' }
  $data.resourceName = if ($resources.Count -gt 0) { [string]$resources[0].name } else { 'Resource1' }

  $script:block = 'project'; $projRaw = Read-Rows $conn 'SELECT * FROM [Project]' @('Name')
  $data.dbProjectName = if ($projRaw.Count -gt 0) { [string]$projRaw[0].Name } else { '' }
  return $data
}

function Resolve-Ref($refs, $ref, [string]$label) {
  if ($null -eq $ref) { throw "missing reference for $label" }
  $kind = [string]$ref.kind
  if ($kind -eq 'existing') { return [long]$ref.id }
  if ($kind -eq 'new') {
    $key = [string]$ref.tempId
    if (-not $refs.ContainsKey($key)) { throw "unresolved new reference $key for $label" }
    return [long]$refs[$key]
  }
  throw "invalid reference for $label"
}

function Exec([string]$sql) {
  $affected = 0
  $script:conn.Execute($sql, [ref]$affected, 128) | Out-Null
  return $affected
}

function LastId([string]$table, [string]$column) {
  $rs = $script:conn.Execute("SELECT MAX([$column]) AS Id FROM [$table]")
  $value = $rs.Fields.Item('Id').Value
  $rs.Close()
  if ($null -eq $value -or $value -is [System.DBNull]) { throw "cannot read new identity from $table" }
  return [long]$value
}

$request = [System.IO.File]::ReadAllText($RequestPath, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
$dbPath = [string]$request.dbPath
$script:workgroupPath = [string]$request.workgroupPath
Initialize-Workgroup $script:workgroupPath

try {
  if (-not (Test-Path -LiteralPath $dbPath)) { Fail 'open' "database not found: $dbPath" }
  $readOnly = ($request.action -eq 'probe' -or $request.action -eq 'snapshot')
  $opened = Open-Db $dbPath $readOnly
  $script:conn = $opened.conn
  $script:result.systemDb = $opened.systemDb
} catch {
  Fail 'open' $_.Exception.Message
}

try {
  switch ([string]$request.action) {
    'probe' {
      $script:result.ok = $true
      $script:result.data = [ordered]@{ provider = 'Microsoft.Jet.OLEDB.4.0'; version = [string]$script:conn.Version }
    }
    'snapshot' {
      $script:result.ok = $true
      $script:result.data = Get-Snapshot $script:conn
    }
    'apply' {
      $refs = @{}
      $counts = [ordered]@{}
      $script:conn.BeginTrans()
      try {
        foreach ($op in $request.ops) {
          switch ([string]$op.op) {
            'variable.insert' {
              $r = $op.row
              $sql = "INSERT INTO [Symbols] ([Name],[RefVarInstance],[RefResourcePOU],[RefScope],[SingleTextLine],[Alias],[RefDefType],[StringSize],[RefAttribute],[RefDirection],[RefGroup],[UserAddress],[Wiring],[IsRetain],[Order],[HasDimension],[InitialValue],[RefLibrary],[Hook],[CRCInitValueDim],[CRCInitValueType],[RefStatus]) VALUES (" +
                (SqlStr $r.name) + ',' + (SqlId $r.varInstanceId) + ',' + (SqlId $r.resourcePouId) + ',' + (SqlId $r.scopeId) + ',' +
                (SqlStr $r.comment) + ',' + (SqlStr $r.alias) + ',' + (SqlId $r.defTypeId) + ',' + (SqlId $r.stringSize) + ',' +
                (SqlId $r.attributeId) + ',' + (SqlId $r.directionId) + ',' + (SqlId $r.groupId) + ',' + (SqlStr $r.userAddress) + ',' +
                (SqlStr $r.wiring) + ',' + (SqlBool $r.isRetain) + ',' + (SqlId $r.order) + ',' + (SqlBool $r.hasDimension) + ',' +
                (SqlStr $r.initialValue) + ',' + (SqlId $r.refLibrary) + ',' + (SqlId $r.hook) + ',' + (SqlId $r.crcInitValueDim) + ',' +
                (SqlId $r.crcInitValueType) + ',' + (SqlStr $r.status) + ')'
              [void](Exec $sql)
              $refs[[string]$op.tempId] = LastId 'Symbols' 'RefSymbols'
              $counts[[string]$op.tempId] = $refs[[string]$op.tempId]
            }
            'variable.update' {
              $r = $op.row
              $sql = "UPDATE [Symbols] SET [Name]=" + (SqlStr $r.name) + ",[RefVarInstance]=" + (SqlId $r.varInstanceId) +
                ",[RefResourcePOU]=" + (SqlId $r.resourcePouId) + ",[RefScope]=" + (SqlId $r.scopeId) +
                ",[SingleTextLine]=" + (SqlStr $r.comment) + ",[Alias]=" + (SqlStr $r.alias) + ",[RefDefType]=" + (SqlId $r.defTypeId) +
                ",[StringSize]=" + (SqlId $r.stringSize) + ",[RefAttribute]=" + (SqlId $r.attributeId) + ",[RefDirection]=" + (SqlId $r.directionId) +
                ",[RefGroup]=" + (SqlId $r.groupId) + ",[UserAddress]=" + (SqlStr $r.userAddress) + ",[Wiring]=" + (SqlStr $r.wiring) +
                ",[IsRetain]=" + (SqlBool $r.isRetain) + ",[Order]=" + (SqlId $r.order) + ",[HasDimension]=" + (SqlBool $r.hasDimension) +
                ",[InitialValue]=" + (SqlStr $r.initialValue) + ",[CRCInitValueDim]=" + (SqlId $r.crcInitValueDim) +
                ",[CRCInitValueType]=" + (SqlId $r.crcInitValueType) + ",[RefStatus]=" + (SqlStr $r.status) +
                " WHERE [RefSymbols]=" + (SqlId $op.id)
              $n = Exec $sql
              if ($n -ne 1) { throw "variable.update affected $n rows for id $($op.id)" }
            }
            'variable.delete' {
              $n = Exec ("DELETE FROM [Symbols] WHERE [RefSymbols]=" + (SqlId $op.id))
              if ($n -ne 1) { throw "variable.delete affected $n rows for id $($op.id)" }
            }
            'program.insert' {
              $r = $op.row
              $sql = "INSERT INTO [POUs] ([Name],[RefPOUtype],[RefLanguage],[RefResource],[Order],[Comment],[ReadOnly],[GenerateSymbMon],[Encrypted],[RefPOUGroup],[RefLocalization],[GenerateDebugInfo],[Is1499],[VSCStatus]) VALUES (" +
                (SqlStr $r.name) + ",1," + (SqlId $r.languageId) + ',' + (SqlId $r.resourceId) + ',' + (SqlId $r.order) + ',' +
                (SqlStr $r.comment) + ',' + (SqlBool $r.readOnly) + ',' + (SqlBool $r.generateSymbMon) + ',False,' +
                (SqlId $r.refPouGroup) + ',' + (SqlId $r.refLocalization) + ',' + (SqlBool $r.generateDebugInfo) + ',' +
                (SqlBool $r.is1499) + ',' + (SqlStr 'N') + ')'
              [void](Exec $sql)
              $pouId = LastId 'POUs' 'RefPOUs'
              [void](Exec ("INSERT INTO [Programs] ([RefPOUs],[Order],[RefFather]) VALUES (" + (SqlId $pouId) + ',' + (SqlId $r.order) + ',0)'))
              $refs[[string]$op.tempId] = $pouId
              $counts[[string]$op.tempId] = $pouId
            }
            'program.update' {
              $r = $op.row
              $sql = "UPDATE [POUs] SET [Name]=" + (SqlStr $r.name) + ",[RefLanguage]=" + (SqlId $r.languageId) +
                ",[RefResource]=" + (SqlId $r.resourceId) + ",[Order]=" + (SqlId $r.order) + ",[Comment]=" + (SqlStr $r.comment) +
                ",[ReadOnly]=" + (SqlBool $r.readOnly) + ",[GenerateSymbMon]=" + (SqlBool $r.generateSymbMon) +
                ",[RefPOUGroup]=" + (SqlId $r.refPouGroup) + ",[RefLocalization]=" + (SqlId $r.refLocalization) +
                ",[GenerateDebugInfo]=" + (SqlBool $r.generateDebugInfo) + ",[Is1499]=" + (SqlBool $r.is1499) +
                " WHERE [RefPOUs]=" + (SqlId $op.id) + " AND [RefPOUtype]=1"
              $n = Exec $sql
              if ($n -ne 1) { throw "program.update affected $n rows for id $($op.id)" }
              $n = Exec ("UPDATE [Programs] SET [Order]=" + (SqlId $r.order) + " WHERE [RefPOUs]=" + (SqlId $op.id))
              if ($n -ne 1) { throw "program.update (Programs) affected $n rows for id $($op.id)" }
            }
            'program.delete' {
              $n = Exec ("DELETE FROM [Programs] WHERE [RefPOUs]=" + (SqlId $op.id))
              if ($n -ne 1) { throw "program.delete (Programs) affected $n rows for id $($op.id)" }
              $n = Exec ("DELETE FROM [POUs] WHERE [RefPOUs]=" + (SqlId $op.id) + " AND [RefPOUtype]=1")
              if ($n -ne 1) { throw "program.delete (POUs) affected $n rows for id $($op.id)" }
            }
            'channel.insert' {
              $r = $op.row
              $sql = "INSERT INTO [GWChannel] ([RefChannel],[PortNum],[Name],[Protocol],[Interval],[Timeout],[Retry],[Watchtime],[DestIP],[DestPort],[Tcpudp],[Baudrate],[Databits],[Parity],[Stopbits],[Reserved1],[Reserved2],[Comments]) VALUES (" +
                (SqlId $r.id) + ',' + (SqlId $r.portNum) + ',' + (SqlStr $r.name) + ',' + (SqlStr $r.protocol) + ',' + (SqlId $r.interval) + ',' +
                (SqlId $r.timeout) + ',' + (SqlId $r.retry) + ',' + (SqlId $r.watchtime) + ',' + (SqlStr $r.destIp) + ',' + (SqlId $r.destPort) + ',' +
                (SqlId $r.tcpudp) + ',' + (SqlStr $r.baudrate) + ',' + (SqlStr $r.databits) + ',' + (SqlStr $r.parity) + ',' + (SqlStr $r.stopbits) + ',0,0,' + (SqlStr $r.comments) + ')'
              [void](Exec $sql)
              $refs[[string]$op.tempId] = [long]$r.id
              $counts[[string]$op.tempId] = [long]$r.id
            }
            'channel.update' {
              $r = $op.row
              $sql = "UPDATE [GWChannel] SET [PortNum]=" + (SqlId $r.portNum) + ",[Name]=" + (SqlStr $r.name) + ",[Protocol]=" + (SqlStr $r.protocol) +
                ",[Interval]=" + (SqlId $r.interval) + ",[Timeout]=" + (SqlId $r.timeout) + ",[Retry]=" + (SqlId $r.retry) + ",[Watchtime]=" + (SqlId $r.watchtime) +
                ",[DestIP]=" + (SqlStr $r.destIp) + ",[DestPort]=" + (SqlId $r.destPort) + ",[Tcpudp]=" + (SqlId $r.tcpudp) + ",[Baudrate]=" + (SqlStr $r.baudrate) +
                ",[Databits]=" + (SqlStr $r.databits) + ",[Parity]=" + (SqlStr $r.parity) + ",[Stopbits]=" + (SqlStr $r.stopbits) + ",[Comments]=" + (SqlStr $r.comments) +
                " WHERE [RefChannel]=" + (SqlId $op.id)
              $n = Exec $sql
              if ($n -ne 1) { throw "channel.update affected $n rows for id $($op.id)" }
            }
            'channel.delete' {
              $n = Exec ("DELETE FROM [GWChannel] WHERE [RefChannel]=" + (SqlId $op.id))
              if ($n -ne 1) { throw "channel.delete affected $n rows for id $($op.id)" }
            }
            'device.insert' {
              $r = $op.row
              $channelId = Resolve-Ref $refs $r.channelRef 'GWDevice.RefChannel'
              $sql = "INSERT INTO [GWDevice] ([RefDevice],[RefChannel],[Name],[Protocol],[Interval],[Reserved1],[Comments]) VALUES (" +
                (SqlId $r.id) + ',' + (SqlId $channelId) + ',' + (SqlStr $r.name) + ',' + (SqlStr $r.protocol) + ',' + (SqlId $r.interval) + ',0,' + (SqlStr $r.comments) + ')'
              [void](Exec $sql)
              $m = $r.modbus
              $sql = "INSERT INTO [GWDeviceModbus] ([RefDevice],[TransMode],[Station],[TransDelay],[ShortFormat],[LongFormat],[FloatFormat],[LongLongFormat],[DoubleFloatFormat],[SingleCmg],[BoolBlockSize],[RegBlockSize],[Reserved1],[Reserved2]) VALUES (" +
                (SqlId $r.id) + ',' + (SqlId $m.transMode) + ',' + (SqlId $m.station) + ',' + (SqlId $m.transDelay) + ',' + (SqlId $m.shortFormat) + ',' +
                (SqlId $m.longFormat) + ',' + (SqlId $m.floatFormat) + ',' + (SqlId $m.longLongFormat) + ',' + (SqlId $m.doubleFloatFormat) + ',' +
                (SqlId $m.singleCmg) + ',' + (SqlId $m.boolBlockSize) + ',' + (SqlId $m.regBlockSize) + ',' + (SqlId $m.reserved1) + ',NULL)'
              [void](Exec $sql)
              $refs[[string]$op.tempId] = [long]$r.id
              $counts[[string]$op.tempId] = [long]$r.id
            }
            'device.update' {
              $r = $op.row
              $channelId = Resolve-Ref $refs $r.channelRef 'GWDevice.RefChannel'
              $n = Exec ("UPDATE [GWDevice] SET [RefChannel]=" + (SqlId $channelId) + ",[Name]=" + (SqlStr $r.name) + ",[Protocol]=" + (SqlStr $r.protocol) + ",[Interval]=" + (SqlId $r.interval) + ",[Comments]=" + (SqlStr $r.comments) + " WHERE [RefDevice]=" + (SqlId $op.id))
              if ($n -ne 1) { throw "device.update affected $n rows for id $($op.id)" }
              $m = $r.modbus
              $n = Exec ("UPDATE [GWDeviceModbus] SET [TransMode]=" + (SqlId $m.transMode) + ",[Station]=" + (SqlId $m.station) + ",[TransDelay]=" + (SqlId $m.transDelay) +
                ",[ShortFormat]=" + (SqlId $m.shortFormat) + ",[LongFormat]=" + (SqlId $m.longFormat) + ",[FloatFormat]=" + (SqlId $m.floatFormat) +
                ",[LongLongFormat]=" + (SqlId $m.longLongFormat) + ",[DoubleFloatFormat]=" + (SqlId $m.doubleFloatFormat) + ",[SingleCmg]=" + (SqlId $m.singleCmg) +
                ",[BoolBlockSize]=" + (SqlId $m.boolBlockSize) + ",[RegBlockSize]=" + (SqlId $m.regBlockSize) + " WHERE [RefDevice]=" + (SqlId $op.id))
              if ($n -ne 1) { throw "device.update (Modbus) affected $n rows for id $($op.id)" }
            }
            'device.delete' {
              [void](Exec ("DELETE FROM [GWDeviceModbus] WHERE [RefDevice]=" + (SqlId $op.id)))
              $n = Exec ("DELETE FROM [GWDevice] WHERE [RefDevice]=" + (SqlId $op.id))
              if ($n -ne 1) { throw "device.delete affected $n rows for id $($op.id)" }
            }
            'map.insert' {
              $r = $op.row
              $deviceId = Resolve-Ref $refs $r.deviceRef 'GWVariableMap.RefDevice'
              $symbolId = Resolve-Ref $refs $r.symbolRef 'GWVariableMap.RefSymbol'
              $sql = "INSERT INTO [GWVariableMap] ([RefVariable],[RefDevice],[RefSymbol],[Address],[Access]) VALUES (" +
                (SqlId $r.id) + ',' + (SqlId $deviceId) + ',' + (SqlId $symbolId) + ',' + (SqlStr $r.address) + ',' + (SqlId $r.access) + ')'
              [void](Exec $sql)
              $refs[[string]$op.tempId] = [long]$r.id
              $counts[[string]$op.tempId] = [long]$r.id
            }
            'map.update' {
              $r = $op.row
              $deviceId = Resolve-Ref $refs $r.deviceRef 'GWVariableMap.RefDevice'
              $symbolId = Resolve-Ref $refs $r.symbolRef 'GWVariableMap.RefSymbol'
              $n = Exec ("UPDATE [GWVariableMap] SET [RefDevice]=" + (SqlId $deviceId) + ",[RefSymbol]=" + (SqlId $symbolId) + ",[Address]=" + (SqlStr $r.address) + ",[Access]=" + (SqlId $r.access) + " WHERE [RefVariable]=" + (SqlId $op.id))
              if ($n -ne 1) { throw "map.update affected $n rows for id $($op.id)" }
            }
            'map.delete' {
              $n = Exec ("DELETE FROM [GWVariableMap] WHERE [RefVariable]=" + (SqlId $op.id))
              if ($n -ne 1) { throw "map.delete affected $n rows for id $($op.id)" }
            }
            default { throw "unknown op: $($op.op)" }
          }
        }
        $script:conn.CommitTrans()
      } catch {
        try { $script:conn.RollbackTrans() } catch {}
        throw
      }
      $script:result.ok = $true
      $script:result.ids = $refs
      $script:result.counts = $counts
      $script:result.data = Get-Snapshot $script:conn
    }
    default { throw "unknown action: $($request.action)" }
  }
} catch {
  Fail 'execute' ("[" + $script:block + "] " + $_.Exception.Message)
} finally {
  try { if ($script:conn) { $script:conn.Close() } } catch {}
}

Write-Response
