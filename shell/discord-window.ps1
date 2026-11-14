# Window helper for AI Brain: finds the Discord app's main window and moves it.
# It only changes the window's position and size (and un-minimizes it). It never reparents
# the window, never makes it topmost, never sets an owner, and never reads anything inside it.
#   info                     -> where the window is now
#   place <x> <y> <w> <h>    -> move the window there (screen pixels, the visible frame)
#   restore <x> <y> <w> <h> <state>  -> put it back; state is normal | max | min
#   front                    -> un-minimize it and bring it to the front (you clicked the button in AI Brain)
# Answers with one JSON line.
param([string]$Do = 'info', [int]$ToX = 0, [int]$ToY = 0, [int]$ToW = 0, [int]$ToH = 0, [string]$ToState = 'normal')
# (PowerShell names ignore case, so these must not clash with the names used below.)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class DW {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static bool Front(IntPtr h) {
    if (SetForegroundWindow(h) && GetForegroundWindow() == h) return true;
    // Windows refuses unless we share input with the window you are using; do that for a moment.
    uint pid; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint me = GetCurrentThreadId();
    bool joined = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
    BringWindowToTop(h); SetForegroundWindow(h);
    if (joined) AttachThreadInput(me, fg, false);
    if (GetForegroundWindow() == h) return true;
    // Last resort: a quick Alt tap lifts the lock (AI Brain has no menu bar for it to open).
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
    return GetForegroundWindow() == h;
  }
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
  public static List<IntPtr> Find(HashSet<uint> pids) {
    var found = new List<IntPtr>();
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid) || !IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true; // 4 = GW_OWNER: skip owned popups
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      if (c.ToString() == "Chrome_WidgetWin_1" && t.Length > 0) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
# Work in real screen pixels on every monitor.
[DW]::SetThreadDpiAwarenessContext([IntPtr]-4) | Out-Null

function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)) }
function Frame($h) {
  $r = New-Object DW+RECT
  if ([DW]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -ne 0) { [DW]::GetWindowRect($h, [ref]$r) | Out-Null }
  return $r
}

try {
  $pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
  foreach ($p in @(Get-Process -Name Discord -ErrorAction SilentlyContinue)) { [void]$pids.Add([uint32]$p.Id) }
  if ($pids.Count -eq 0) { Out-Json @{ ok = $false; why = 'not-running' }; exit 0 }
  $list = [DW]::Find($pids)
  if ($list.Count -eq 0) { Out-Json @{ ok = $false; why = 'no-window' }; exit 0 }
  # The main window is the biggest one.
  $hwnd = $list | Sort-Object { $r = Frame $_; ($r.R - $r.L) * ($r.B - $r.T) } -Descending | Select-Object -First 1
  $was = if ([DW]::IsIconic($hwnd)) { 'min' } elseif ([DW]::IsZoomed($hwnd)) { 'max' } else { 'normal' }

  if ($Do -eq 'info') {
    $f = Frame $hwnd
    Out-Json @{ ok = $true; x = $f.L; y = $f.T; w = $f.R - $f.L; h = $f.B - $f.T; state = $was; hwnd = [int64]$hwnd; front = ([DW]::GetForegroundWindow() -eq $hwnd) }
    exit 0
  }
  if ($Do -eq 'front') {
    if ($was -eq 'min') { [DW]::ShowWindow($hwnd, 9) | Out-Null }   # SW_RESTORE
    # HWND_TOP with NOMOVE (0x2) and NOSIZE (0x1): above other normal windows, never topmost.
    [DW]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0200 -bor 0x0040) | Out-Null
    $t = New-Object System.Text.StringBuilder 256; [DW]::GetWindowText([DW]::GetForegroundWindow(), $t, 256) | Out-Null
    $ok = [DW]::Front($hwnd)
    Out-Json @{ ok = $ok; was = "$t" }
    exit 0
  }
  if ($Do -ne 'place' -and $Do -ne 'restore') { Out-Json @{ ok = $false; why = 'unknown command' }; exit 0 }
  if ($ToW -lt 200 -or $ToH -lt 200) { Out-Json @{ ok = $false; why = 'bad size' }; exit 0 }

  # Remember where it was (as a normal window) before this move.
  if ($was -ne 'normal') { [DW]::ShowWindow($hwnd, 9) | Out-Null; Start-Sleep -Milliseconds 250 } # 9 = SW_RESTORE
  $before = Frame $hwnd

  # Windows adds invisible borders around most windows; aim the visible frame at the target.
  $wr = New-Object DW+RECT; [DW]::GetWindowRect($hwnd, [ref]$wr) | Out-Null
  $f = Frame $hwnd
  $padL = $f.L - $wr.L; $padT = $f.T - $wr.T; $padR = $wr.R - $f.R; $padB = $wr.B - $f.B
  # place: HWND_TOP (0) brings it above other normal windows so it can be seen - never topmost.
  # restore: 0x0004 NOZORDER, 0x0010 NOACTIVATE leave the stacking alone. 0x0200 NOOWNERZORDER, 0x0040 SHOWWINDOW.
  $flags = if ($Do -eq 'place') { 0x0200 -bor 0x0040 } else { 0x0004 -bor 0x0010 -bor 0x0200 }
  [DW]::SetWindowPos($hwnd, [IntPtr]::Zero, $ToX - $padL, $ToY - $padT, $ToW + $padL + $padR, $ToH + $padT + $padB, $flags) | Out-Null
  Start-Sleep -Milliseconds 150
  $now = Frame $hwnd
  if ($Do -eq 'restore') {
    if ($ToState -eq 'max') { [DW]::ShowWindow($hwnd, 3) | Out-Null }       # SW_MAXIMIZE
    elseif ($ToState -eq 'min') { [DW]::ShowWindow($hwnd, 7) | Out-Null }   # SW_SHOWMINNOACTIVE
  }
  Out-Json @{ ok = $true; before = @{ x = $before.L; y = $before.T; w = $before.R - $before.L; h = $before.B - $before.T; state = $was }; now = @{ x = $now.L; y = $now.T; w = $now.R - $now.L; h = $now.B - $now.T } }
} catch {
  Out-Json @{ ok = $false; why = $_.Exception.Message }
}
