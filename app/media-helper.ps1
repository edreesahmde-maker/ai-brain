# Music helper for AI Brain.
# Talks to the Windows media controls (the same ones the keyboard media keys use), so it can show
# what is playing and press play / pause / next / previous. No account, no keys, nothing leaves the PC.
# It reads one command per line on stdin and answers with one JSON line on stdout.
#   status | toggle | play | pause | next | prev | shuffle | repeat | seek <seconds> | art | quit
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

$asStreamForRead = ([System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1
  })[0]

function Await($op, [Type]$type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(4000)) { throw 'Windows did not answer in time.' }
  $task.Result
}

$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

function Pick-Session {
  $all = @($manager.GetSessions())
  $spotify = $all | Where-Object { $_.SourceAppUserModelId -match 'Spotify' } | Select-Object -First 1
  if ($spotify) { return $spotify }
  $cur = $manager.GetCurrentSession()
  if ($cur) { return $cur }
  $all | Select-Object -First 1
}

function App-Name($id) {
  if ($id -match 'Spotify') { return 'Spotify' }
  if ($id -match 'chrome') { return 'Chrome' }
  if ($id -match 'msedge|MicrosoftEdge') { return 'Edge' }
  if ($id -match 'firefox') { return 'Firefox' }
  if ($id -match 'Discord') { return 'Discord' }
  if ($id -match 'ZuneMusic|MediaPlayer') { return 'Media Player' }
  (($id -replace '\.exe$', '') -split '[!\\]')[0]
}

function Get-Status {
  $s = Pick-Session
  if (-not $s) { return @{ ok = $true; active = $false } }
  $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $info = $s.GetPlaybackInfo()
  $tl = $s.GetTimelineProperties()
  $c = $info.Controls
  $position = $tl.Position.TotalSeconds
  # Windows only updates the position now and then; add the time that passed since then while playing.
  if ("$($info.PlaybackStatus)" -eq 'Playing' -and $tl.LastUpdatedTime.Year -gt 2000) {
    $position += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds
  }
  $duration = $tl.EndTime.TotalSeconds
  if ($duration -gt 0 -and $position -gt $duration) { $position = $duration }
  @{
    ok = $true; active = $true
    app = (App-Name $s.SourceAppUserModelId)
    title = "$($props.Title)"; artist = "$($props.Artist)"; album = "$($props.AlbumTitle)"
    playing = ("$($info.PlaybackStatus)" -eq 'Playing')
    position = [math]::Round([math]::Max(0, $position), 1); duration = [math]::Round($duration, 1)
    shuffle = [bool]$info.IsShuffleActive
    repeat = "$($info.AutoRepeatMode)"
    can = @{
      toggle = [bool]($c.IsPlayPauseToggleEnabled -or $c.IsPlayEnabled -or $c.IsPauseEnabled)
      next = [bool]$c.IsNextEnabled; prev = [bool]$c.IsPreviousEnabled
      shuffle = [bool]$c.IsShuffleEnabled; repeat = [bool]$c.IsRepeatEnabled
      seek = [bool]$c.IsPlaybackPositionEnabled
    }
    hasArt = ($null -ne $props.Thumbnail)
  }
}

function Get-Art {
  $s = Pick-Session
  if (-not $s) { return @{ ok = $true; art = $null } }
  $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  if (-not $props.Thumbnail) { return @{ ok = $true; art = $null } }
  $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  # PowerShell cannot see the members of a WinRT stream, so read it through the .NET bridge.
  $net = $asStreamForRead.Invoke($null, @($stream))
  $mem = New-Object System.IO.MemoryStream
  try { $net.CopyTo($mem) } finally { $net.Dispose() }
  $bytes = $mem.ToArray()
  if ($bytes.Length -lt 8 -or $bytes.Length -gt 3000000) { return @{ ok = $true; art = $null } }
  $mime = 'image/jpeg'
  if ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) { $mime = 'image/png' }
  elseif ($bytes[0] -eq 0x47 -and $bytes[1] -eq 0x49) { $mime = 'image/gif' }
  elseif ($bytes[0] -eq 0x52 -and $bytes[8] -eq 0x57) { $mime = 'image/webp' }
  elseif ($bytes[0] -eq 0x42 -and $bytes[1] -eq 0x4d) { $mime = 'image/bmp' }
  @{ ok = $true; art = [Convert]::ToBase64String($bytes); mime = $mime }
}

function Do-Command($name, $arg) {
  $s = Pick-Session
  if (-not $s) { return @{ ok = $false; error = 'Nothing is playing. Open Spotify and start a song first.' } }
  $done = switch ($name) {
    'toggle'  { Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
    'play'    { Await ($s.TryPlayAsync()) ([bool]) }
    'pause'   { Await ($s.TryPauseAsync()) ([bool]) }
    'next'    { Await ($s.TrySkipNextAsync()) ([bool]) }
    'prev'    { Await ($s.TrySkipPreviousAsync()) ([bool]) }
    'shuffle' { Await ($s.TryChangeShuffleActiveAsync(-not [bool]$s.GetPlaybackInfo().IsShuffleActive)) ([bool]) }
    'repeat'  {
      $order = @('None', 'List', 'Track')
      $now = "$($s.GetPlaybackInfo().AutoRepeatMode)"
      $next = $order[([array]::IndexOf($order, $now) + 1) % 3]
      Await ($s.TryChangeAutoRepeatModeAsync([Windows.Media.MediaPlaybackAutoRepeatMode]::$next)) ([bool])
    }
    'seek'    { Await ($s.TryChangePlaybackPositionAsync([int64]([double]$arg * 10000000))) ([bool]) }
    default   { $false }
  }
  if (-not $done) { return @{ ok = $false; error = 'The player did not accept that.' } }
  Start-Sleep -Milliseconds 350
  Get-Status
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Trim() -split '\s+', 2
  $cmd = $parts[0]
  if (-not $cmd) { continue }
  if ($cmd -eq 'quit') { break }
  try {
    $out = switch ($cmd) {
      'status' { Get-Status }
      'art'    { Get-Art }
      default  { Do-Command $cmd $parts[1] }
    }
  } catch {
    $out = @{ ok = $false; error = "$($_.Exception.Message)" }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}
