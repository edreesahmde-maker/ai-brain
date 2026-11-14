// App control helper for AI Brain: lets the brain see and use the ONE program that is in the
// middle of AI Brain (docked). The desktop window compiles this once (with the C# compiler that
// comes with Windows) and runs it once per step; every run prints one JSON line.
//
// It only ever acts on the program it is given (window + process id), and it refuses when:
//   - the window is gone or belongs to another process now,
//   - the spot to click is covered by a window of another program,
//   - the program cannot be brought to the front (keys would land somewhere else),
//   - the mouse is not where the brain left it (you moved it: you are taking over),
//   - a key would leave the program (Windows key, Alt+Tab, Ctrl+Esc, Ctrl+Alt+Del...).
// Text in password boxes is never read.
//
// Usage: app-control <command> <hwnd> <pid> [args...]   (all positions are screen pixels)
//   look   <hwnd> <pid> <png path> <max side>        picture + numbered list of things on screen
//   click  <hwnd> <pid> <x> <y> <left|right|middle|none> <count> <expX> <expY>   (none = only move)
//   drag   <hwnd> <pid> <x1> <y1> <x2> <y2> <left|right|middle> <expX> <expY>
//   scroll <hwnd> <pid> <x> <y> <notches, + = up> <horizontal 0|1> <expX> <expY>
//   type   <hwnd> <pid> <text as base64 UTF-8> <expX> <expY>
//   key    <hwnd> <pid> <combo, e.g. ctrl+s> <times> <expX> <expY>
// expX/expY = where the brain left the mouse last time, or -99999 to skip that check.
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging;
using System.Runtime.InteropServices; using System.Text; using System.Threading; using System.Windows.Automation;

public static class AC {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTU { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTU u; }
  delegate bool EnumProc(IntPtr h, IntPtr p);

  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern short VkKeyScan(char c);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);

  static readonly IntPtr MARK = new IntPtr(0x42524149); // "BRAI": input sent by AI Brain
  const int SKIP = -99999;

  static string Esc(string s) {
    if (s == null) return "";
    var b = new StringBuilder(s.Length + 8);
    foreach (char c in s) {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c < 0x20) b.Append(' ');
      else b.Append(c);
    }
    return b.ToString();
  }
  static string Fail(string why) { return "{\"ok\":false,\"why\":\"" + Esc(why) + "\"}"; }
  static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  static string Title(IntPtr h) { var t = new StringBuilder(512); GetWindowText(h, t, 512); return t.ToString(); }
  // The visible frame (without the invisible resize borders Windows 10/11 adds).
  static RECT Frame(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) == 0 && r.R > r.L) return r;
    GetWindowRect(h, out r); return r;
  }
  static bool Cloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; }
  static POINT Cursor() { POINT p; GetCursorPos(out p); return p; }
  static string CursorJson() { POINT p = Cursor(); return "\"cursor\":{\"x\":" + p.X + ",\"y\":" + p.Y + "}"; }

  // The program's visible top-level windows: its main window first, then its dialogs and menus.
  static List<IntPtr> OwnWindows(IntPtr main, uint pid) {
    var list = new List<IntPtr>();
    list.Add(main);
    EnumWindows((h, p) => {
      if (h != main && PidOf(h) == pid && IsWindowVisible(h) && !IsIconic(h) && !Cloaked(h)) {
        RECT r = Frame(h);
        if (r.R - r.L >= 8 && r.B - r.T >= 8) list.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }

  static bool Front(IntPtr h, uint pid) {
    if (IsIconic(h)) ShowWindow(h, 9);
    if (PidOf(GetForegroundWindow()) == pid) return true;
    SetForegroundWindow(h);
    if (PidOf(GetForegroundWindow()) == pid) return true;
    uint other; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out other);
    uint me = GetCurrentThreadId();
    bool joined = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
    BringWindowToTop(h); SetForegroundWindow(h);
    if (joined) AttachThreadInput(me, fg, false);
    if (PidOf(GetForegroundWindow()) == pid) return true;
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); // Alt tap lets a program take the front
    SetForegroundWindow(h);
    Thread.Sleep(60);
    return PidOf(GetForegroundWindow()) == pid;
  }

  // Common checks before any input. Returns null when it is fine to go on.
  static string Ready(IntPtr h, uint pid, int expX, int expY) {
    if (!IsWindow(h) || PidOf(h) != pid) return "gone";
    if (expX != SKIP) {
      POINT c = Cursor();
      if (Math.Abs(c.X - expX) > 4 || Math.Abs(c.Y - expY) > 4) return "user-moved";
    }
    if (!Front(h, pid)) return "not-front";
    return null;
  }
  // Is this screen point on one of the program's own windows (not covered by another program)?
  static bool Ours(int x, int y, uint pid) {
    POINT p; p.X = x; p.Y = y;
    IntPtr w = WindowFromPoint(p);
    if (w == IntPtr.Zero) return false;
    IntPtr root = GetAncestor(w, 2); // GA_ROOT
    return PidOf(root == IntPtr.Zero ? w : root) == pid;
  }

  // ---------- input ----------
  static void Send(params INPUT[] list) { SendInput((uint)list.Length, list, Marshal.SizeOf(typeof(INPUT))); }
  static INPUT Mouse(uint flags, int dx = 0, int dy = 0, uint data = 0) {
    var i = new INPUT(); i.type = 0; i.u.mi.flags = flags; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.data = data; i.u.mi.extra = MARK; return i;
  }
  static INPUT Key(ushort vk, bool up, ushort scan = 0, bool unicode = false) {
    var i = new INPUT(); i.type = 1; i.u.ki.vk = vk; i.u.ki.scan = scan; i.u.ki.extra = MARK;
    uint f = up ? 2u : 0u;
    if (unicode) f |= 4;
    else if ((vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x6F || vk == 0x90) f |= 1; // extended keys
    i.u.ki.flags = f; return i;
  }
  // Moves the mouse like a real one (programs that read raw mouse input see it too), then exactly.
  static void MoveTo(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = Math.Max(2, GetSystemMetrics(78)), vh = Math.Max(2, GetSystemMetrics(79));
    int nx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1)), ny = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
    Send(Mouse(0x0001 | 0x8000 | 0x4000, nx, ny)); // MOVE | ABSOLUTE | VIRTUALDESK
    SetCursorPos(x, y);
  }
  static uint DownFlag(string b) { return b == "right" ? 0x0008u : b == "middle" ? 0x0020u : 0x0002u; }
  static uint UpFlag(string b) { return b == "right" ? 0x0010u : b == "middle" ? 0x0040u : 0x0004u; }

  static string Click(IntPtr h, uint pid, string[] a) {
    int x = int.Parse(a[3]), y = int.Parse(a[4]); string button = a[5]; int count = Math.Max(1, Math.Min(3, int.Parse(a[6])));
    string no = Ready(h, pid, int.Parse(a[7]), int.Parse(a[8]));
    if (no != null) return Fail(no);
    if (!Ours(x, y, pid)) return Fail("covered");
    MoveTo(x, y);
    if (button != "none") {
      Thread.Sleep(40);
      for (int i = 0; i < count; i++) { Send(Mouse(DownFlag(button))); Thread.Sleep(30); Send(Mouse(UpFlag(button))); if (i + 1 < count) Thread.Sleep(70); }
    }
    return "{\"ok\":true," + CursorJson() + "}";
  }

  static string Drag(IntPtr h, uint pid, string[] a) {
    int x1 = int.Parse(a[3]), y1 = int.Parse(a[4]), x2 = int.Parse(a[5]), y2 = int.Parse(a[6]); string button = a[7];
    string no = Ready(h, pid, int.Parse(a[8]), int.Parse(a[9]));
    if (no != null) return Fail(no);
    if (!Ours(x1, y1, pid)) return Fail("covered");
    MoveTo(x1, y1); Thread.Sleep(60);
    Send(Mouse(DownFlag(button))); Thread.Sleep(80);
    const int steps = 20;
    for (int i = 1; i <= steps; i++) { MoveTo(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps); Thread.Sleep(15); }
    Thread.Sleep(80);
    Send(Mouse(UpFlag(button)));
    return "{\"ok\":true," + CursorJson() + "}";
  }

  static string Scroll(IntPtr h, uint pid, string[] a) {
    int x = int.Parse(a[3]), y = int.Parse(a[4]), n = Math.Max(-50, Math.Min(50, int.Parse(a[5]))); bool horiz = a[6] == "1";
    string no = Ready(h, pid, int.Parse(a[7]), int.Parse(a[8]));
    if (no != null) return Fail(no);
    if (!Ours(x, y, pid)) return Fail("covered");
    MoveTo(x, y); Thread.Sleep(40);
    int step = n > 0 ? 1 : -1;
    for (int i = 0; i != n; i += step) { Send(Mouse(horiz ? 0x1000u : 0x0800u, 0, 0, (uint)(120 * (horiz ? -step : step)))); Thread.Sleep(25); }
    return "{\"ok\":true," + CursorJson() + "}";
  }

  static string TypeText(IntPtr h, uint pid, string[] a) {
    string text = Encoding.UTF8.GetString(Convert.FromBase64String(a[3]));
    string no = Ready(h, pid, int.Parse(a[4]), int.Parse(a[5]));
    if (no != null) return Fail(no);
    if (text.Length > 20000) return Fail("too-long");
    int n = 0;
    for (int i = 0; i < text.Length; i++) {
      char c = text[i];
      if (c == '\r') continue;
      if ((n & 31) == 0 && PidOf(GetForegroundWindow()) != pid) return Fail("lost-front"); // something else came up: stop typing there
      if (c == '\n') { Send(Key(0x0D, false), Key(0x0D, true)); }
      else if (c == '\t') { Send(Key(0x09, false), Key(0x09, true)); }
      else if (char.IsHighSurrogate(c) && i + 1 < text.Length) {
        char d = text[++i];
        Send(Key(0, false, c, true), Key(0, false, d, true), Key(0, true, c, true), Key(0, true, d, true));
      } else Send(Key(0, false, c, true), Key(0, true, c, true));
      n++;
      Thread.Sleep(4);
    }
    return "{\"ok\":true,\"typed\":" + n + "," + CursorJson() + "}";
  }

  static readonly Dictionary<string, ushort> Names = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
    {"enter",0x0D},{"return",0x0D},{"tab",0x09},{"esc",0x1B},{"escape",0x1B},{"backspace",0x08},{"delete",0x2E},{"del",0x2E},{"insert",0x2D},
    {"home",0x24},{"end",0x23},{"pageup",0x21},{"pagedown",0x22},{"up",0x26},{"down",0x28},{"left",0x25},{"right",0x27},{"space",0x20},
    {"ctrl",0x11},{"control",0x11},{"shift",0x10},{"alt",0x12},{"menu",0x5D},{"capslock",0x14},{"numlock",0x90},{"printscreen",0x2C},
    {"plus",0xBB},{"minus",0xBD},{"comma",0xBC},{"period",0xBE},
    {"num0",0x60},{"num1",0x61},{"num2",0x62},{"num3",0x63},{"num4",0x64},{"num5",0x65},{"num6",0x66},{"num7",0x67},{"num8",0x68},{"num9",0x69},
    {"num*",0x6A},{"num+",0x6B},{"num-",0x6D},{"num.",0x6E},{"num/",0x6F},
  };
  static string Combo(IntPtr h, uint pid, string[] a) {
    string combo = a[3].Trim().ToLowerInvariant(); int times = Math.Max(1, Math.Min(50, int.Parse(a[4])));
    var keys = new List<ushort>();
    foreach (string raw in combo.Split('+')) {
      string k = raw.Trim();
      if (k == "" && combo.EndsWith("+")) k = "plus";
      if (k == "") continue;
      if (k == "win" || k == "windows" || k == "lwin" || k == "rwin" || k == "super" || k == "cmd") return Fail("blocked-key");
      ushort vk;
      if (Names.TryGetValue(k, out vk)) { keys.Add(vk); continue; }
      if (k.Length >= 2 && k.Length <= 3 && k[0] == 'f') { int f; if (int.TryParse(k.Substring(1), out f) && f >= 1 && f <= 24) { keys.Add((ushort)(0x70 + f - 1)); continue; } }
      if (k.Length == 1) {
        short s = VkKeyScan(k[0]);
        if (s == -1) return Fail("unknown-key:" + k);
        if ((s & 0x100) != 0 && !keys.Contains(0x10)) keys.Insert(0, 0x10); // the character needs Shift
        keys.Add((ushort)(s & 0xFF)); continue;
      }
      return Fail("unknown-key:" + k);
    }
    if (keys.Count == 0) return Fail("unknown-key:");
    bool ctrl = keys.Contains(0x11), alt = keys.Contains(0x12), shift = keys.Contains(0x10);
    // Keys that would leave the program or reach Windows itself.
    if ((alt && (keys.Contains(0x09) || keys.Contains(0x1B))) || (ctrl && keys.Contains(0x1B)) || (ctrl && alt && keys.Contains(0x2E)) || (ctrl && shift && keys.Contains(0x1B)))
      return Fail("blocked-key");
    string no = Ready(h, pid, int.Parse(a[5]), int.Parse(a[6]));
    if (no != null) return Fail(no);
    for (int t = 0; t < times; t++) {
      if (PidOf(GetForegroundWindow()) != pid) return Fail("lost-front");
      foreach (ushort k in keys) { Send(Key(k, false)); Thread.Sleep(15); }
      for (int i = keys.Count - 1; i >= 0; i--) { Send(Key(keys[i], true)); Thread.Sleep(10); }
      Thread.Sleep(40);
    }
    return "{\"ok\":true," + CursorJson() + "}";
  }

  // ---------- looking ----------
  static readonly HashSet<ControlType> Wanted = new HashSet<ControlType> {
    ControlType.Button, ControlType.CheckBox, ControlType.ComboBox, ControlType.Edit, ControlType.Hyperlink, ControlType.ListItem,
    ControlType.MenuItem, ControlType.RadioButton, ControlType.Slider, ControlType.Spinner, ControlType.SplitButton, ControlType.TabItem,
    ControlType.TreeItem, ControlType.DataItem, ControlType.HeaderItem, ControlType.Document, ControlType.ScrollBar,
  };
  static string Kind(ControlType t) {
    string n = t.ProgrammaticName; int i = n.LastIndexOf('.'); return (i >= 0 ? n.Substring(i + 1) : n).ToLowerInvariant();
  }

  class Item { public string kind, name, value; public bool on, pw; public System.Windows.Rect r; }
  class Node { public AutomationElement el; public int depth; public System.Windows.Rect clip; }
  // Containers that scroll: what lies outside them cannot be seen.
  static readonly HashSet<ControlType> Clips = new HashSet<ControlType> { ControlType.List, ControlType.Tree, ControlType.DataGrid, ControlType.Table, ControlType.Document };

  // Walks the program's windows with UI Automation (what screen readers use). Some programs
  // (Blender, games) draw everything themselves and show almost nothing here: the picture still works.
  static void Walk(List<IntPtr> wins, Rectangle area, List<Item> outList, object gate) {
    try {
      var cr = new CacheRequest();
      cr.Add(AutomationElement.NameProperty); cr.Add(AutomationElement.ControlTypeProperty); cr.Add(AutomationElement.BoundingRectangleProperty);
      cr.Add(AutomationElement.IsOffscreenProperty); cr.Add(AutomationElement.IsEnabledProperty); cr.Add(AutomationElement.IsPasswordProperty);
      cr.Add(AutomationElement.IsKeyboardFocusableProperty); cr.Add(ValuePattern.ValueProperty); cr.Add(AutomationElement.IsInvokePatternAvailableProperty);
      cr.TreeScope = TreeScope.Element;
      var walker = TreeWalker.ControlViewWalker;
      int visited = 0;
      var all = new System.Windows.Rect(area.Left, area.Top, area.Width, area.Height);
      foreach (IntPtr w in wins) {
        AutomationElement root;
        using (cr.Activate()) root = AutomationElement.FromHandle(w);
        var stack = new Stack<Node>();
        stack.Push(new Node { el = root, depth = 0, clip = all });
        while (stack.Count > 0 && visited < 4000) {
          var top = stack.Pop(); visited++;
          var el = top.el;
          var clip = top.clip;
          try {
            var c = el.Cached;
            var r = c.BoundingRectangle;
            bool off = c.IsOffscreen;
            ControlType t = c.ControlType;
            // Only the part that can be seen: lists, trees, tables and pages hide what is scrolled out of them
            // (some still report those rows as on screen).
            var vis = r.IsEmpty ? r : System.Windows.Rect.Intersect(r, clip);
            if (!off && !vis.IsEmpty && vis.Width >= 3 && vis.Height >= 3) {
              string name = (c.Name ?? "").Trim();
              bool invoke = false; try { invoke = (bool)el.GetCachedPropertyValue(AutomationElement.IsInvokePatternAvailableProperty); } catch { }
              if (Wanted.Contains(t) || (name != "" && (invoke || (t == ControlType.Text && name.Length <= 120)))) {
                var it = new Item { kind = Kind(t), name = name, on = c.IsEnabled, r = vis };
                try { it.pw = c.IsPassword; } catch { }
                if (!it.pw && (t == ControlType.Edit || t == ControlType.ComboBox || t == ControlType.Document || t == ControlType.Slider || t == ControlType.Spinner)) {
                  try { object v = el.GetCachedPropertyValue(ValuePattern.ValueProperty); it.value = v as string; } catch { }
                }
                lock (gate) { outList.Add(it); if (outList.Count >= 220) return; }
              }
            }
            if (Clips.Contains(t) && !r.IsEmpty) { clip = System.Windows.Rect.Intersect(clip, r); if (clip.IsEmpty) continue; } // nothing inside can be seen
          } catch { /* the element went away */ }
          if (top.depth >= 40) continue;
          // children in screen order (pushed reversed so the first child is handled first)
          var kids = new List<AutomationElement>();
          try {
            for (var k = walker.GetFirstChild(el, cr); k != null && kids.Count < 400; k = walker.GetNextSibling(k, cr)) kids.Add(k);
          } catch { }
          for (int i = kids.Count - 1; i >= 0; i--) stack.Push(new Node { el = kids[i], depth = top.depth + 1, clip = clip });
        }
      }
    } catch (Exception e) { walkError = e.GetType().Name + ": " + e.Message; /* UI Automation is not available for this program */ }
  }
  static string walkError = "";

  static string Look(IntPtr h, uint pid, string[] a) {
    if (!IsWindow(h) || PidOf(h) != pid) return Fail("gone");
    string png = a[3]; int maxSide = Math.Max(400, Math.Min(2400, int.Parse(a[4])));
    bool front = Front(h, pid);
    Thread.Sleep(120); // let it draw after coming to the front
    var wins = OwnWindows(h, pid);
    // The picture covers the main window plus any dialog or menu of the program that sticks out of it.
    RECT f = Frame(h);
    int L = f.L, T = f.T, R = f.R, B = f.B;
    var pops = new StringBuilder();
    foreach (IntPtr w in wins) {
      if (w == h) continue;
      RECT r = Frame(w);
      L = Math.Min(L, r.L); T = Math.Min(T, r.T); R = Math.Max(R, r.R); B = Math.Max(B, r.B);
      if (pops.Length > 0) pops.Append(',');
      pops.Append("{\"title\":\"" + Esc(Title(w)) + "\",\"x\":" + r.L + ",\"y\":" + r.T + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) + "}");
    }
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    L = Math.Max(L, vx); T = Math.Max(T, vy); R = Math.Min(R, vx + vw); B = Math.Min(B, vy + vh);
    if (R - L < 8 || B - T < 8) return Fail("off-screen");
    var area = new Rectangle(L, T, R - L, B - T);
    double scale = Math.Min(1.0, (double)maxSide / Math.Max(area.Width, area.Height));
    int iw = Math.Max(1, (int)Math.Round(area.Width * scale)), ih = Math.Max(1, (int)Math.Round(area.Height * scale));

    // Things on screen, read while the picture is taken; at most 4 seconds.
    var items = new List<Item>(); object gate = new object();
    var th = new Thread(() => Walk(wins, area, items, gate)); th.IsBackground = true; th.Start();

    using (var shot = new Bitmap(area.Width, area.Height, PixelFormat.Format24bppRgb)) {
      using (var g = Graphics.FromImage(shot)) g.CopyFromScreen(area.Left, area.Top, 0, 0, area.Size, CopyPixelOperation.SourceCopy);
      if (scale < 1.0) {
        using (var small = new Bitmap(iw, ih, PixelFormat.Format24bppRgb)) {
          using (var g = Graphics.FromImage(small)) { g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.PixelOffsetMode = PixelOffsetMode.HighQuality; g.DrawImage(shot, 0, 0, iw, ih); }
          small.Save(png, ImageFormat.Png);
        }
      } else shot.Save(png, ImageFormat.Png);
    }
    bool complete = th.Join(4000);
    List<Item> got; lock (gate) got = new List<Item>(items);

    var sb = new StringBuilder();
    sb.Append("{\"ok\":true,\"front\":" + (front ? "true" : "false") + ",\"title\":\"" + Esc(Title(h)) + "\"");
    sb.Append(",\"area\":{\"x\":" + area.Left + ",\"y\":" + area.Top + ",\"w\":" + area.Width + ",\"h\":" + area.Height + "}");
    sb.Append(",\"main\":{\"x\":" + f.L + ",\"y\":" + f.T + ",\"w\":" + (f.R - f.L) + ",\"h\":" + (f.B - f.T) + "}");
    sb.Append(",\"image\":{\"w\":" + iw + ",\"h\":" + ih + "},\"scale\":" + scale.ToString("R", System.Globalization.CultureInfo.InvariantCulture));
    sb.Append(",\"popups\":[" + pops + "],\"complete\":" + (complete ? "true" : "false") + (walkError != "" ? ",\"uiaError\":\"" + Esc(walkError) + "\"" : "") + "," + CursorJson() + ",\"items\":[");
    for (int i = 0; i < got.Count; i++) {
      var it = got[i];
      // screen pixels, clipped to the picture
      int x = (int)Math.Max(area.Left, it.r.Left), y = (int)Math.Max(area.Top, it.r.Top);
      int x2 = (int)Math.Min(area.Right, it.r.Right), y2 = (int)Math.Min(area.Bottom, it.r.Bottom);
      if (x2 - x < 2 || y2 - y < 2) continue;
      if (i > 0 && sb[sb.Length - 1] != '[') sb.Append(',');
      sb.Append("{\"kind\":\"" + it.kind + "\",\"name\":\"" + Esc(it.name.Length > 120 ? it.name.Substring(0, 120) + "..." : it.name) + "\"");
      if (it.pw) sb.Append(",\"password\":true");
      else if (it.value != null) sb.Append(",\"value\":\"" + Esc(it.value.Length > 200 ? it.value.Substring(0, 200) + "..." : it.value) + "\"");
      if (!it.on) sb.Append(",\"disabled\":true");
      sb.Append(",\"x\":" + x + ",\"y\":" + y + ",\"w\":" + (x2 - x) + ",\"h\":" + (y2 - y) + "}");
    }
    sb.Append("]}");
    return sb.ToString();
  }

  public static void Main(string[] a) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { }
    string answer;
    try {
      if (a.Length < 3) answer = Fail("usage");
      else {
        IntPtr h = new IntPtr(long.Parse(a[1])); uint pid = uint.Parse(a[2]);
        switch (a[0]) {
          case "look": answer = Look(h, pid, a); break;
          case "click": answer = Click(h, pid, a); break;
          case "drag": answer = Drag(h, pid, a); break;
          case "scroll": answer = Scroll(h, pid, a); break;
          case "type": answer = TypeText(h, pid, a); break;
          case "key": answer = Combo(h, pid, a); break;
          default: answer = Fail("unknown command"); break;
        }
      }
    } catch (Exception e) { answer = Fail(e.GetType().Name + ": " + e.Message); }
    var o = new System.IO.StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    o.WriteLine(answer); o.Flush();
    Environment.Exit(0); // a UI Automation walk that ran out of time must not keep this running
  }
}
