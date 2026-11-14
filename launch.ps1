# Opens AI Brain. Uses the desktop window (full screen, Discord app beside it) when it is installed,
# otherwise starts the server and opens the app in a Chrome or Edge app window.
$port = 4777
$url  = "http://127.0.0.1:$port"
$dir  = Split-Path -Parent $MyInvocation.MyCommand.Path

$electron = Join-Path $dir "node_modules\electron\dist\electron.exe"
if (Test-Path $electron) {
  # The desktop window starts the server itself if needed.
  Start-Process -FilePath $electron -ArgumentList "`"$dir\shell\main.cjs`"" -WorkingDirectory $dir
  exit 0
}

function Test-Brain {
  try { return ((Invoke-RestMethod "$url/api/ping" -TimeoutSec 2).app -eq 'ai-brain') } catch { return $false }
}

if (-not (Test-Brain)) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("Node.js was not found. Install it from nodejs.org, then open AI Brain again.", "AI Brain") | Out-Null
    exit 1
  }
  Start-Process -FilePath $node -ArgumentList "`"$dir\app\app-server.mjs`"" -WorkingDirectory $dir -WindowStyle Hidden
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 250; if (Test-Brain) { break } }
}

$chrome = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue).'(default)'
if (-not $chrome) { $chrome = (Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue).'(default)' }
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"

if ($chrome -and (Test-Path $chrome)) {
  Start-Process $chrome "--app=$url --window-size=1680,980"
} elseif (Test-Path $edge) {
  Start-Process $edge "--app=$url --window-size=1680,980"
} else {
  Start-Process $url
}
