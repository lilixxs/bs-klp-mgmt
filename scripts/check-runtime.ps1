# Read-only runtime probe for the KLP VS Code extension.
# It does not create, modify, or delete any project/database/workgroup file.
# Run from a normal (non-elevated) PowerShell on the target Windows machine.
$ErrorActionPreference = 'Continue'
$result = [ordered]@{
  os = [System.Environment]::OSVersion.VersionString
  is64BitOS = [Environment]::Is64BitOperatingSystem
  is64BitProcess = [Environment]::Is64BitProcess
  powershell32 = $null
  msjet40 = $null
  msjetoledb40 = $null
  msado15 = $null
  adoConnection = $null
  systemMdw = @()
  officeDetected = $false
  javaDetected = $false
}

$ps32 = Join-Path $env:SystemRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
$result.powershell32 = [ordered]@{ path = $ps32; exists = (Test-Path -LiteralPath $ps32) }

$dlls = @{
  msjet40 = Join-Path $env:SystemRoot 'SysWOW64\msjet40.dll'
  msjetoledb40 = Join-Path $env:SystemRoot 'SysWOW64\msjetoledb40.dll'
  msado15 = Join-Path ${env:ProgramFiles(x86)} 'Common Files\System\ado\msado15.dll'
}
foreach ($name in $dlls.Keys) {
  $path = $dlls[$name]
  $info = $null
  try { $info = Get-Item -LiteralPath $path -ErrorAction Stop } catch {}
  $result[$name] = [ordered]@{ path = $path; exists = [bool]$info; version = if ($info) { $info.VersionInfo.FileVersion } else { $null } }
}

try {
  $conn = New-Object -ComObject ADODB.Connection
  # Creating the COM object checks 32-bit ADO registration. Provider registration is
  # checked by the msjet40/msjetoledb40 DLL checks above; setting Provider on an
  # unopened ADO connection is not supported by all ADO builds.
  $result.adoConnection = [ordered]@{ ok = $true; note = 'ADODB.Connection COM object created' }
} catch {
  $result.adoConnection = [ordered]@{ ok = $false; error = $_.Exception.Message }
}

$mdwCandidates = @(
  (Join-Path $env:APPDATA 'Microsoft\Access\System.mdw'),
  (Join-Path $env:SystemRoot 'SysWOW64\system.mdw'),
  (Join-Path $env:SystemRoot 'System32\system.mdw')
)
foreach ($path in $mdwCandidates) {
  $result.systemMdw += [ordered]@{ path = $path; exists = (Test-Path -LiteralPath $path) }
}

$result.officeDetected = [bool]((Test-Path -LiteralPath (Join-Path ${env:ProgramFiles} 'Microsoft Office')) -or (Test-Path -LiteralPath (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Office')))
$result.javaDetected = [bool](Get-Command java.exe -ErrorAction SilentlyContinue)

$result | ConvertTo-Json -Depth 5
