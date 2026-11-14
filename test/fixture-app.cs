// TEST ONLY. A small window for the app control tests: a button, a text box, a check box, a long
// list and a drag area. Everything that happens is written to the state file given as the first
// argument, so the test can check what the brain's mouse and keyboard really did.
using System; using System.Drawing; using System.IO; using System.Windows.Forms;

public class Fixture : Form {
  string stateFile; int clicks, rights, doubles, wheel, drags, keys; string lastKey = ""; Point dragFrom, dragTo; bool down;
  TextBox box; CheckBox check; ListBox list; Panel pad; Label info;

  public Fixture(string file) {
    stateFile = file;
    Text = "AIB Fixture"; ClientSize = new Size(760, 520); StartPosition = FormStartPosition.Manual; Location = new Point(120, 120);
    var press = new Button { Text = "Press me", Location = new Point(20, 20), Size = new Size(140, 40) };
    press.Click += (s, e) => { clicks++; Save(); };
    press.MouseUp += (s, e) => { if (e.Button == MouseButtons.Right) { rights++; Save(); } };
    box = new TextBox { Name = "Notes", Location = new Point(180, 26), Size = new Size(300, 28), AccessibleName = "Notes" };
    box.TextChanged += (s, e) => Save();
    box.KeyDown += (s, e) => { keys++; lastKey = e.KeyData.ToString(); Save(); };
    var secret = new TextBox { Location = new Point(500, 26), Size = new Size(200, 28), UseSystemPasswordChar = true, Text = "hunter2", AccessibleName = "Secret" };
    check = new CheckBox { Text = "Remember", Location = new Point(20, 76), Size = new Size(140, 28) };
    check.CheckedChanged += (s, e) => Save();
    list = new ListBox { Location = new Point(20, 120), Size = new Size(220, 360), IntegralHeight = false };
    for (int i = 1; i <= 200; i++) list.Items.Add("Item " + i);
    list.MouseWheel += (s, e) => { wheel += e.Delta / 120; Save(); };
    list.DoubleClick += (s, e) => { doubles++; Save(); };
    pad = new Panel { Location = new Point(270, 120), Size = new Size(460, 360), BackColor = Color.FromArgb(40, 60, 90), AccessibleName = "Drag area", AccessibleRole = AccessibleRole.PushButton };
    pad.MouseDown += (s, e) => { down = true; dragFrom = e.Location; };
    pad.MouseUp += (s, e) => { if (down) { down = false; dragTo = e.Location; if (Math.Abs(dragTo.X - dragFrom.X) + Math.Abs(dragTo.Y - dragFrom.Y) > 20) drags++; Save(); } };
    info = new Label { Text = "ready", Location = new Point(180, 80), Size = new Size(540, 24), AccessibleName = "Status" };
    Controls.AddRange(new Control[] { press, box, secret, check, list, pad, info });
    Shown += (s, e) => Save();
  }

  void Save() {
    string esc = (box.Text ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    string json = "{\"clicks\":" + clicks + ",\"rights\":" + rights + ",\"doubles\":" + doubles + ",\"wheel\":" + wheel + ",\"top\":" + list.TopIndex
      + ",\"checked\":" + (check.Checked ? "true" : "false") + ",\"text\":\"" + esc + "\",\"keys\":" + keys + ",\"lastKey\":\"" + lastKey + "\""
      + ",\"drags\":" + drags + ",\"from\":[" + dragFrom.X + "," + dragFrom.Y + "],\"to\":[" + dragTo.X + "," + dragTo.Y + "]}";
    info.Text = "clicks " + clicks + ", text " + box.Text.Length + " chars";
    try { File.WriteAllText(stateFile + ".tmp", json); File.Copy(stateFile + ".tmp", stateFile, true); } catch { }
  }

  [STAThread] public static void Main(string[] a) {
    Application.EnableVisualStyles();
    Application.Run(new Fixture(a.Length > 0 ? a[0] : Path.Combine(Path.GetTempPath(), "aib-fixture.json")));
  }
}
