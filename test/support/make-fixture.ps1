param(
  [Parameter(Mandatory = $true)][string]$RequestPath
)
# Build a synthetic Jet 3 database with the KLP schema subset used by media/mdb-helper.ps1.
# Request JSON: { "dbPath": "...", "rows": { "Table": [ { "Column": value, ... } ] } }
# ASCII only; all text arrives as UTF-8 JSON.
$ErrorActionPreference = 'Stop'
$request = [System.IO.File]::ReadAllText($RequestPath, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
$dbPath = [string]$request.dbPath
$result = [ordered]@{ ok = $false }

function SqlStr($value) {
  if ($null -eq $value) { return 'NULL' }
  return "'" + ([string]$value).Replace("'", "''") + "'"
}
function SqlNum($value) {
  if ($null -eq $value) { return 'NULL' }
  return [string]([double]$value)
}
function SqlBool($value) {
  if ($null -eq $value) { return 'NULL' }
  if ([bool]$value) { return 'True' }
  return 'False'
}

$ddl = @(
  "CREATE TABLE [Project] ([Name] TEXT(128))",
  "CREATE TABLE [Configurations] ([RefConfiguration] COUNTER, [Name] TEXT(128))",
  "CREATE TABLE [Resources] ([RefResource] COUNTER, [RefConfiguration] LONG, [Name] TEXT(128), [Address] TEXT(255))",
  "CREATE TABLE [Group] ([RefGroup] COUNTER, [RefResource] LONG, [Name] TEXT(128), [SingleTextLine] TEXT(255), [Order] LONG)",
  "CREATE TABLE [Definition type] ([RefDefType] COUNTER, [Name] TEXT(128), [RefDataType] LONG, [StringSize] LONG, [CRC] LONG, [RefLibrary] LONG)",
  "CREATE TABLE [VarInstance] ([RefVarInstance] LONG, [Name] TEXT(50))",
  "CREATE TABLE [Scopes] ([RefScope] COUNTER, [Name] TEXT(128))",
  "CREATE TABLE [Direction] ([RefDirection] COUNTER, [Name] TEXT(128), [SingleTextLine] TEXT(255))",
  "CREATE TABLE [Attributes] ([RefAttribute] COUNTER, [Name] TEXT(128), [SingleTextLine] TEXT(255))",
  "CREATE TABLE [Languages] ([RefLanguage] COUNTER, [Name] TEXT(128), [SingleTextLine] TEXT(255))",
  "CREATE TABLE [POUs] ([RefPOUs] COUNTER, [Name] TEXT(128), [SingleTextLine] TEXT(255), [Comment] MEMO, [RefLanguage] LONG, [RefResource] LONG, [Order] LONG, [RefPOUtype] LONG, [ReadOnly] YESNO, [GenerateSymbMon] YESNO, [Encrypted] YESNO, [RefPOUGroup] LONG, [RefLocalization] LONG, [GenerateDebugInfo] YESNO, [Is1499] YESNO, [VSCStatus] TEXT(1))",
  "CREATE TABLE [Programs] ([RefPOUs] LONG, [Order] LONG, [RefFather] LONG)",
  "CREATE TABLE [Symbols] ([RefSymbols] COUNTER, [Name] TEXT(128), [SingleTextLine] TEXT(255), [Alias] TEXT(128), [RefVarInstance] LONG, [RefResourcePOU] LONG, [RefScope] LONG, [RefDefType] LONG, [StringSize] LONG, [RefAttribute] LONG, [RefDirection] LONG, [RefGroup] LONG, [UserAddress] TEXT(255), [Wiring] TEXT(50), [IsRetain] YESNO, [Order] LONG, [HasDimension] YESNO, [InitialValue] MEMO, [RefLibrary] LONG, [Hook] LONG, [CRCInitValueDim] LONG, [CRCInitValueType] LONG, [RefStatus] TEXT(50))",
  "CREATE TABLE [I/O Symbols] ([RefSymbols] LONG, [RefInstance] LONG, [RefDevice] LONG, [PhysicalOrder] LONG, [Order] LONG)",
  "CREATE TABLE [GWChannel] ([RefChannel] LONG, [PortNum] LONG, [Name] TEXT(64), [Protocol] TEXT(64), [Interval] LONG, [Timeout] LONG, [Retry] LONG, [Watchtime] LONG, [DestIP] TEXT(32), [DestPort] LONG, [Tcpudp] LONG, [Baudrate] TEXT(32), [Databits] TEXT(32), [Parity] TEXT(32), [Stopbits] TEXT(32), [Reserved1] LONG, [Reserved2] LONG, [Comments] TEXT(255))",
  "CREATE TABLE [GWDevice] ([RefDevice] LONG, [RefChannel] LONG, [Name] TEXT(64), [Protocol] TEXT(64), [Interval] LONG, [Reserved1] LONG, [Comments] TEXT(255))",
  "CREATE TABLE [GWDeviceModbus] ([RefDevice] LONG, [TransMode] LONG, [Station] LONG, [TransDelay] LONG, [ShortFormat] LONG, [LongFormat] LONG, [FloatFormat] LONG, [LongLongFormat] LONG, [DoubleFloatFormat] LONG, [SingleCmg] LONG, [BoolBlockSize] LONG, [RegBlockSize] LONG, [Reserved1] LONG, [Reserved2] LONG)",
  "CREATE TABLE [GWVariableMap] ([RefVariable] LONG, [RefDevice] LONG, [RefSymbol] LONG, [Address] TEXT(128), [Access] LONG)"
)

$indexes = @(
  "CREATE UNIQUE INDEX [PrimaryKey] ON [Symbols] ([RefSymbols])",
  "CREATE UNIQUE INDEX [SymbolsName] ON [Symbols] ([Name])",
  "CREATE UNIQUE INDEX [ProgramsPOUs] ON [Programs] ([RefPOUs])",
  "CREATE UNIQUE INDEX [POUsName] ON [POUs] ([Name])"
)

try {
  if (Test-Path -LiteralPath $dbPath) { Remove-Item -LiteralPath $dbPath -Force }
  $cat = New-Object -ComObject ADOX.Catalog
  $cat.Create("Provider=Microsoft.Jet.OLEDB.4.0;Data Source=$dbPath;Jet OLEDB:Engine Type=5;")
  $conn = $cat.ActiveConnection
  $conn.BeginTrans()
  foreach ($sql in $ddl) { $conn.Execute($sql) | Out-Null }
  foreach ($sql in $indexes) { $conn.Execute($sql) | Out-Null }

  $tables = $request.rows
  if ($null -ne $tables) {
    foreach ($tableProp in $tables.PSObject.Properties) {
      $table = $tableProp.Name
      foreach ($row in $tableProp.Value) {
        $names = New-Object System.Collections.ArrayList
        $values = New-Object System.Collections.ArrayList
        foreach ($colProp in $row.PSObject.Properties) {
          [void]$names.Add('[' + $colProp.Name + ']')
          $value = $colProp.Value
          if ($value -is [bool]) { [void]$values.Add((SqlBool $value)) }
          elseif ($value -is [int] -or $value -is [long] -or $value -is [double] -or $value -is [decimal]) { [void]$values.Add((SqlNum $value)) }
          else { [void]$values.Add((SqlStr $value)) }
        }
        $sql = "INSERT INTO [$table] (" + ($names -join ',') + ') VALUES (' + ($values -join ',') + ')'
        $conn.Execute($sql) | Out-Null
      }
    }
  }
  $conn.CommitTrans()
  $conn.Close()
  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
}
$json = $result | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($RequestPath + '.out', $json, (New-Object System.Text.UTF8Encoding($false)))
