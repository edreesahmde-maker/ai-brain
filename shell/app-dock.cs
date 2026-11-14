// App dock helper for AI Brain. The desktop window compiles this once (with the C# compiler that
// comes with Windows) and keeps it running while a program is docked.
// It keeps one program's window (Blender, Godot, Chrome, ...) glued to the middle of AI Brain:
// it follows when AI Brain moves, sits just above AI Brain (never above other programs),
// goes down with AI Brain when it is minimized, and goes back where it was when released.
// It only moves windows and changes their stacking. It never makes a window a child or an
// owned window of AI Brain (so an AI Brain crash can never take the program down with it),
// never makes anything topmost and never reads what is inside a window.
// If AI Brain goes away (this helper's input closes), the program is put back first.
//
// Commands, one per line on stdin:  <id> <command> [args...]
//   brain <hwnd>                  the AI Brain window
//   list                          programs' main windows that can be docked
//   dock <hwnd>                   start keeping this window in the slot (remembers where it was)
//   slot <x> <y> <w> <h> <show>   the slot in screen pixels; show 0 = keep it under AI Brain
//   release                       stop and put the window back where it was
//   put <hwnd> <show> <l> <t> <r> <b>   put a window back to a saved place (after a crash)
//   front                         let the user work in the docked program
//   info                          where things are
// Answers: {"id":..,...} lines. Unasked news: {"ev":"ready"|"closed"|"moved-away"|"error",...}
using System; using System.Collections.Generic; using System.IO; using System.Runtime.InteropServices; using System.Text; using System.Threading;
public static class AD {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct WP { public int length, flags, showCmd; public POINT minPos, maxPos; public RECT normal; }
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public delegate void EventProc(IntPtr hook, uint ev, IntPtr h, int obj, int child, uint thread, uint time);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr h, ref WP p);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPlacement(IntPtr h, ref WP p);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, EventProc f, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr p, int flags, StringBuilder s, ref int n);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  const uint NOSIZE = 0x1, NOMOVE = 0x2, NOZORDER = 0x4, NOACTIVATE = 0x10, NOOWNERZORDER = 0x200, ASYNC = 0x4000;
  static readonly object sync = new object();
  static readonly object outLock = new object();
  static IntPtr brain = IntPtr.Zero, app = IntPtr.Zero;
  static uint brainPid = 0;
  static WP before; static bool haveBefore = false;
  static bool hasSlot = false, show = false, userMoving = false, downByUs = false;
  static int offX, offY, slotW, slotH;     // the slot, from the top-left of AI Brain's window
  static RECT target;                      // where the window was last put (its visible frame)
  static int snaps = 0; static DateTime snapAt = DateTime.MinValue;
  static EventProc keep;                   // the hooks must stay alive
  static Timer watch;                      // the stacking check (kept alive here)

  // ---------- small helpers ----------
  static string Esc(string s) {
    var b = new StringBuilder();
    foreach (char c in s) {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.ToString();
  }
  static readonly StreamWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
  public static void Say(string json) { lock (outLock) { try { output.WriteLine(json); } catch { /* AI Brain is gone */ } } }
  static RECT Frame(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) GetWindowRect(h, out r);
    return r;
  }
  static string RectJson(RECT r) { return "{\"x\":" + r.L + ",\"y\":" + r.T + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) + "}"; }
  static string ExePath(uint pid) {
    IntPtr p = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (p == IntPtr.Zero) return "";
    var s = new StringBuilder(1024); int n = 1024;
    string r = QueryFullProcessImageName(p, 0, s, ref n) ? s.ToString() : "";
    CloseHandle(p);
    return r;
  }
  static string Title(IntPtr h) { var t = new StringBuilder(512); GetWindowText(h, t, 512); return t.ToString(); }
  static string Cls(IntPtr h) { var c = new StringBuilder(256); GetClassName(h, c, 256); return c.ToString(); }

  // A program's main window that may be docked: visible, not a popup or tool window, not hidden
  // by Windows, not the desktop or taskbar, not AI Brain, and never Discord.
  static string Refusal(IntPtr h) {
    if (!IsWindow(h)) return "gone";
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (pid == brainPid || h == brain) return "ai-brain";
    if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return "not-a-main-window";
    if ((GetWindowLong(h, -20) & 0x80) != 0) return "not-a-main-window";       // WS_EX_TOOLWINDOW
    int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return "not-a-main-window";
    if (GetWindowTextLength(h) == 0) return "not-a-main-window";
    string c = Cls(h);
    if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd") return "not-a-main-window";
    string exe = ExePath(pid);
    string name = System.IO.Path.GetFileName(exe).ToLowerInvariant();
    if (name.StartsWith("discord")) return "discord";
    return null;
  }

  public static string List() {
    var sb = new StringBuilder("[");
    lock (sync) {
      EnumWindows((h, p) => {
        if (Refusal(h) != null) return true;
        uint pid; GetWindowThreadProcessId(h, out pid);
        RECT f = Frame(h);
        if (sb.Length > 1) sb.Append(',');
        sb.Append("{\"hwnd\":").Append((long)h).Append(",\"pid\":").Append(pid)
          .Append(",\"title\":\"").Append(Esc(Title(h))).Append("\",\"exe\":\"").Append(Esc(ExePath(pid)))
          .Append("\",\"w\":").Append(f.R - f.L).Append(",\"h\":").Append(f.B - f.T)
          .Append(",\"min\":").Append(IsIconic(h) ? "true" : "false").Append('}');
        return true;
      }, IntPtr.Zero);
    }
    return sb.Append(']').ToString();
  }

  // ---------- stacking ----------
  // Just above AI Brain, and never above a third program's window.
  static void Raise() {
    if (app == IntPtr.Zero || brain == IntPtr.Zero) return;
    if (GetForegroundWindow() == app) {
      // You are working in the program: AI Brain comes up right behind it.
      SetWindowPos(brain, app, 0, 0, 0, 0, NOMOVE | NOSIZE | NOACTIVATE | NOOWNERZORDER | ASYNC);
      return;
    }
    IntPtr prev = GetWindow(brain, 3); // the window right above AI Brain
    while (prev == app) prev = GetWindow(prev, 3);
    IntPtr after = (prev == IntPtr.Zero || (GetWindowLong(prev, -20) & 0x8) != 0) ? IntPtr.Zero : prev; // 0x8 = topmost
    SetWindowPos(app, after, 0, 0, 0, 0, NOMOVE | NOSIZE | NOACTIVATE | NOOWNERZORDER | ASYNC);
  }
  // Right under AI Brain, so AI Brain covers it (a question or menu is open over the slot).
  static void Lower() {
    if (app == IntPtr.Zero || brain == IntPtr.Zero) return;
    SetWindowPos(app, brain, 0, 0, 0, 0, NOMOVE | NOSIZE | NOACTIVATE | NOOWNERZORDER | ASYNC);
  }

  // Is the program right above AI Brain, with no visible window in between?
  static bool RightAbove() {
    for (IntPtr w = GetWindow(app, 2); w != IntPtr.Zero; w = GetWindow(w, 2)) {
      if (w == brain) return true;
      if (IsWindowVisible(w) && !IsIconic(w)) return false;
    }
    return false; // AI Brain is above the program
  }
  // Windows does not always say when AI Brain comes to the front (typing in it, for one), so a
  // few times a second: if the program should show but slipped under AI Brain, put it back on top.
  static void Watch(object _) {
    lock (sync) {
      try {
        if (app == IntPtr.Zero || brain == IntPtr.Zero || !hasSlot || !show || userMoving) return;
        if (!IsWindow(app) || IsIconic(app) || IsIconic(brain) || !IsWindowVisible(brain)) return;
        if (!RightAbove()) Raise();
      } catch { /* try again on the next tick */ }
    }
  }

  // Puts the window's visible frame on the slot, then stacks it.
  static void Place() {
    if (app == IntPtr.Zero || !hasSlot || userMoving) return;
    if (IsIconic(brain)) return;
    if (IsHungAppWindow(app)) return; // busy program: try again on the next change
    RECT b; GetWindowRect(brain, out b);
    int x = b.L + offX, y = b.T + offY;
    if (IsIconic(app) || IsZoomed(app)) {
      // Back to a normal window without stealing the keyboard.
      WP p = new WP(); p.length = Marshal.SizeOf(typeof(WP));
      GetWindowPlacement(app, ref p);
      p.showCmd = 4; // SW_SHOWNOACTIVATE
      SetWindowPlacement(app, ref p);
    }
    RECT wr; GetWindowRect(app, out wr);
    RECT f = Frame(app);
    int pl = f.L - wr.L, pt = f.T - wr.T, pr = wr.R - f.R, pb = wr.B - f.B;
    target.L = x; target.T = y; target.R = x + slotW; target.B = y + slotH;
    SetWindowPos(app, IntPtr.Zero, x - pl, y - pt, slotW + pl + pr, slotH + pt + pb, NOZORDER | NOACTIVATE | NOOWNERZORDER | ASYNC);
    if (show) Raise(); else Lower();
  }

  static string Release() {
    IntPtr h = app;
    app = IntPtr.Zero; hasSlot = false; userMoving = false; downByUs = false;
    if (h == IntPtr.Zero || !IsWindow(h)) { haveBefore = false; return "{\"ok\":true}"; }
    if (haveBefore) {
      WP p = before;
      p.showCmd = p.showCmd == 2 ? 7 : p.showCmd == 3 ? 3 : 4; // minimized stays down, others without taking the keyboard
      SetWindowPlacement(h, ref p);
      haveBefore = false;
    }
    return "{\"ok\":true}";
  }

  // ---------- what happens on screen ----------
  static void OnEvent(IntPtr hook, uint ev, IntPtr h, int obj, int child, uint thread, uint time) {
    if (obj != 0 || child != 0 || h == IntPtr.Zero) return;
    lock (sync) {
      if (app == IntPtr.Zero) return;
      try {
        if (h == brain) {
          if (ev == 0x800B) Place();                                   // moved or resized
          else if (ev == 0x0003) { if (show) Raise(); }                // you clicked AI Brain
          else if (ev == 0x0016) { ShowWindow(app, 7); downByUs = true; }   // AI Brain minimized: so is the program
          else if (ev == 0x0017 && downByUs) { downByUs = false; Place(); } // and back
        } else if (h == app) {
          if (ev == 0x8001) { app = IntPtr.Zero; hasSlot = false; haveBefore = false; Say("{\"ev\":\"closed\"}"); }
          else if (ev == 0x0003) Raise();                              // you clicked the program
          else if (ev == 0x000A) userMoving = true;                    // you started dragging it
          else if (ev == 0x000B) {                                     // you let go
            userMoving = false;
            RECT f = Frame(app);
            int cx = (f.L + f.R) / 2, cy = (f.T + f.B) / 2;
            bool inside = cx > target.L && cx < target.R && cy > target.T && cy < target.B;
            if (inside) Place();
            else {
              // Dragged out of AI Brain: it stays where you dropped it.
              app = IntPtr.Zero; hasSlot = false; haveBefore = false;
              Say("{\"ev\":\"moved-away\"}");
            }
          }
          else if (ev == 0x0017 && !downByUs) Place();                 // you un-minimized it
          else if (ev == 0x800B && !userMoving && !IsIconic(app)) {
            // The program moved itself (or was maximized). Put it back, but do not fight a
            // program that keeps a bigger size than the slot.
            RECT f = Frame(app);
            bool atSlot = Math.Abs(f.L - target.L) <= 2 && Math.Abs(f.T - target.T) <= 2;
            if (atSlot && !IsZoomed(app)) return;
            if ((DateTime.Now - snapAt).TotalSeconds > 2) snaps = 0;
            snapAt = DateTime.Now;
            if (++snaps <= 6) Place();
          }
        }
      } catch (Exception e) { Say("{\"ev\":\"error\",\"why\":\"" + Esc(e.Message) + "\"}"); }
    }
  }

  // "Destroyed" and "location changed" fire for every window, menu, caret and mouse pointer on the
  // PC (thousands a second while anything moves). Listen to them only from AI Brain's and the
  // program's processes, so the events that matter are not stuck in a queue behind the others.
  const uint WM_REHOOK = 0x8000 + 1; // WM_APP + 1
  static uint hooksThread = 0, hookedBrainPid = 0, hookedAppPid = 0;
  static readonly System.Collections.Generic.List<IntPtr> pidHooks = new System.Collections.Generic.List<IntPtr>();
  static void Rehook() { // on the hooks thread only
    uint bp, ap = 0;
    lock (sync) { bp = brainPid; if (app != IntPtr.Zero) GetWindowThreadProcessId(app, out ap); }
    if (bp == hookedBrainPid && ap == hookedAppPid && pidHooks.Count > 0) return;
    foreach (IntPtr hk in pidHooks) UnhookWinEvent(hk);
    pidHooks.Clear();
    hookedBrainPid = bp; hookedAppPid = ap;
    foreach (uint pid in new uint[] { bp, ap == bp ? 0 : ap }) {
      if (pid == 0) continue;
      pidHooks.Add(SetWinEventHook(0x8001, 0x8001, IntPtr.Zero, keep, pid, 0, 0)); // destroyed
      pidHooks.Add(SetWinEventHook(0x800B, 0x800B, IntPtr.Zero, keep, pid, 0, 0)); // location changed
    }
  }
  static void AskRehook() { if (hooksThread != 0) PostThreadMessage(hooksThread, WM_REHOOK, IntPtr.Zero, IntPtr.Zero); }

  static void Hooks() {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    keep = OnEvent;
    SetWinEventHook(0x0003, 0x0017, IntPtr.Zero, keep, 0, 0, 0);   // foreground, move/size, minimize
    hooksThread = GetCurrentThreadId();
    Rehook();
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {
      if (m.hwnd == IntPtr.Zero && m.message == WM_REHOOK) { Rehook(); continue; }
      TranslateMessage(ref m); DispatchMessage(ref m);
    }
  }

  static bool Front(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    if (SetForegroundWindow(h) && GetForegroundWindow() == h) return true;
    uint pid; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint me = GetCurrentThreadId();
    bool joined = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
    BringWindowToTop(h); SetForegroundWindow(h);
    if (joined) AttachThreadInput(me, fg, false);
    if (GetForegroundWindow() == h) return true;
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
    return GetForegroundWindow() == h;
  }

  // ---------- commands ----------
  static string Handle(string[] a) {
    string cmd = a.Length > 1 ? a[1] : "";
    if (cmd == "list") return "{\"ok\":true,\"windows\":" + List() + "}";
    lock (sync) {
      if (cmd == "brain") {
        brain = new IntPtr(long.Parse(a[2]));
        GetWindowThreadProcessId(brain, out brainPid);
        AskRehook();
        return "{\"ok\":" + (IsWindow(brain) ? "true" : "false") + "}";
      }
      if (cmd == "dock") {
        IntPtr h = new IntPtr(long.Parse(a[2]));
        if (brain == IntPtr.Zero) return "{\"ok\":false,\"why\":\"no-brain\"}";
        string no = Refusal(h);
        if (no != null) return "{\"ok\":false,\"why\":\"" + no + "\"}";
        if (app != IntPtr.Zero && app != h) Release();
        WP p = new WP(); p.length = Marshal.SizeOf(typeof(WP));
        GetWindowPlacement(h, ref p);
        // A program run as administrator cannot be moved by AI Brain: find out now.
        if (!SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, NOMOVE | NOSIZE | NOZORDER | NOACTIVATE | 0x20) && Marshal.GetLastWin32Error() == 5)
          return "{\"ok\":false,\"why\":\"admin\"}";
        if (app != h) { before = p; haveBefore = true; }
        app = h; snaps = 0; userMoving = false; downByUs = false;
        uint pid; GetWindowThreadProcessId(h, out pid);
        AskRehook();
        string pl = "{\"show\":" + p.showCmd + ",\"l\":" + p.normal.L + ",\"t\":" + p.normal.T + ",\"r\":" + p.normal.R + ",\"b\":" + p.normal.B + "}";
        if (hasSlot) Place();
        return "{\"ok\":true,\"hwnd\":" + (long)h + ",\"pid\":" + pid + ",\"title\":\"" + Esc(Title(h)) + "\",\"exe\":\"" + Esc(ExePath(pid)) + "\",\"before\":" + pl + "}";
      }
      if (cmd == "slot") {
        int x = int.Parse(a[2]), y = int.Parse(a[3]), w = int.Parse(a[4]), hh = int.Parse(a[5]);
        show = a[6] == "1";
        if (w < 80 || hh < 60) { show = false; }
        RECT b; GetWindowRect(brain, out b);
        offX = x - b.L; offY = y - b.T; slotW = Math.Max(80, w); slotH = Math.Max(60, hh); hasSlot = true;
        snaps = 0;
        Place();
        return "{\"ok\":true}";
      }
      if (cmd == "release") return Release();
      if (cmd == "put") {
        IntPtr h = new IntPtr(long.Parse(a[2]));
        if (!IsWindow(h)) return "{\"ok\":false,\"why\":\"gone\"}";
        WP p = new WP(); p.length = Marshal.SizeOf(typeof(WP));
        GetWindowPlacement(h, ref p);
        int sc = int.Parse(a[3]);
        p.showCmd = sc == 2 ? 7 : sc == 3 ? 3 : 4;
        p.normal.L = int.Parse(a[4]); p.normal.T = int.Parse(a[5]); p.normal.R = int.Parse(a[6]); p.normal.B = int.Parse(a[7]);
        return "{\"ok\":" + (SetWindowPlacement(h, ref p) ? "true" : "false") + "}";
      }
      if (cmd == "front") {
        if (app == IntPtr.Zero) return "{\"ok\":false,\"why\":\"none\"}";
        bool ok = Front(app);
        return "{\"ok\":" + (ok ? "true" : "false") + "}";
      }
      if (cmd == "info") {
        if (app == IntPtr.Zero || !IsWindow(app)) return "{\"ok\":true,\"docked\":false}";
        // Stacking: is the program right above AI Brain (no visible window in between)?
        string stack = "\"other\"";
        int between = 0;
        for (IntPtr w = GetWindow(app, 2); w != IntPtr.Zero; w = GetWindow(w, 2)) {
          if (w == brain) { stack = between == 0 ? "\"right-above\"" : "\"above\""; break; }
          if (IsWindowVisible(w) && !IsIconic(w)) between++;
        }
        if (stack == "\"other\"") for (IntPtr w = GetWindow(brain, 2); w != IntPtr.Zero; w = GetWindow(w, 2)) if (w == app) { stack = "\"below\""; break; }
        return "{\"ok\":true,\"docked\":true,\"hwnd\":" + (long)app + ",\"stack\":" + stack + ",\"frame\":" + RectJson(Frame(app)) + ",\"target\":" + RectJson(target)
          + ",\"show\":" + (show ? "true" : "false") + ",\"min\":" + (IsIconic(app) ? "true" : "false")
          + ",\"front\":" + (GetForegroundWindow() == app ? "true" : "false") + ",\"title\":\"" + Esc(Title(app)) + "\"}";
      }
    }
    return "{\"ok\":false,\"why\":\"unknown command\"}";
  }

  public static void Main() {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    var t = new Thread(Hooks); t.IsBackground = true; t.Start();
    watch = new Timer(Watch, null, 300, 300);
    Say("{\"ev\":\"ready\"}");
    try {
      string line;
      var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
      while ((line = input.ReadLine()) != null) {
        string[] a = line.Trim().Split(' ');
        long id;
        if (a.Length < 2 || !long.TryParse(a[0], out id)) continue;
        string answer;
        try { answer = Handle(a); } catch (Exception e) { answer = "{\"ok\":false,\"why\":\"" + Esc(e.Message) + "\"}"; }
        Say("{\"id\":" + id + "," + answer.Substring(1));
      }
    } catch { /* the pipe broke: AI Brain is gone */ }
    finally {
      // AI Brain is gone (or closed this helper): put the program back where it was.
      lock (sync) { try { Release(); } catch { } }
    }
  }
}
