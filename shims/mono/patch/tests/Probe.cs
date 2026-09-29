// Test probe for patched helper copies (used by ../../test-helpers.sh). It loads UctoShim.dll
// and a patched assembly and exercises code that needs a user at the keyboard otherwise.
//   mono Probe.exe <UctoShim.dll> static  <patched asm> <Type> <Method> [string args...]
//   mono Probe.exe <UctoShim.dll> mapi    <patched UEmail17.exe> <to> <cc> <subject> <body> [attachments...]
//   mono Probe.exe <UctoShim.dll> form    <patched asm> <Form type> [string ctor args...]
//   mono Probe.exe <UctoShim.dll> doctext <patched asm> <Form type> <field> <html>
// Prints "RESULT <value>" lines; exit code 0 on success.
using System;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;

static class Probe {
  const BindingFlags All = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance;

  static int Main(string[] a) {
    try {
      Assembly.LoadFrom(a[0]);
      var asm = Assembly.LoadFrom(a[2]);
      switch (a[1]) {
        case "static": {
          var t = asm.GetType(a[3], true);
          var m = t.GetMethods(All).First(x => x.Name == a[4] && x.GetParameters().Length == a.Length - 5);
          var ps = m.GetParameters();
          var r = m.Invoke(null, a.Skip(5).Select((s, k) => Convert.ChangeType(s, ps[k].ParameterType, System.Globalization.CultureInfo.InvariantCulture)).ToArray());
          Console.WriteLine("RESULT " + r);
          return 0;
        }
        case "mapi": {
          var t = asm.GetType("UEmail3.BL.SimpleMapi", true);
          var o = Activator.CreateInstance(t);
          t.GetMethod("AddRecipient").Invoke(o, new object[] { a[3], null, false });
          if (a[4].Length > 0) t.GetMethod("AddRecipient").Invoke(o, new object[] { a[4], null, true });
          foreach (var f in a.Skip(7)) t.GetMethod("Attach").Invoke(o, new object[] { f });
          var ok = (bool)t.GetMethod("Send").Invoke(o, new object[] { a[5], a[6], true });
          Console.WriteLine("RESULT " + ok + " " + t.GetMethod("Error").Invoke(o, null));
          return ok ? 0 : 1;
        }
        case "form":
        case "doctext": {
          var t = asm.GetType(a[3], true);
          Form f;
          if (a[1] == "form") {
            var args = a.Skip(4).Cast<object>().ToArray();
            f = (Form)t.GetConstructors(All).First(c => c.GetParameters().Length == args.Length).Invoke(args);
          } else {
            f = (Form)t.GetConstructors(All).First(c => c.GetParameters().Length == 0).Invoke(null);
          }
          f.Show();
          Application.DoEvents();
          if (a[1] == "doctext") {
            var wb = t.GetField(a[4], All).GetValue(f);
            wb.GetType().GetProperty("DocumentText").SetValue(wb, a[5], null);
          }
          Application.DoEvents();
          foreach (var c in Descendants(f)) {
            if (c.GetType().FullName == "UctoShim.Forms.WebBrowser" || c.GetType().FullName == "System.Windows.Forms.WebBrowser") {
              Console.WriteLine("RESULT browser " + c.GetType().FullName);
              var tb = c.Controls.OfType<TextBox>().FirstOrDefault();
              if (tb != null) Console.WriteLine("RESULT text " + tb.Text.Replace("\r\n", " | "));
            }
          }
          f.Close();
          Application.DoEvents();
          return 0;
        }
      }
      Console.Error.WriteLine("unknown command " + a[1]);
      return 2;
    } catch (Exception e) {
      Console.Error.WriteLine((e is TargetInvocationException ? e.InnerException : e).ToString());
      return 1;
    }
  }

  static System.Collections.Generic.IEnumerable<Control> Descendants(Control c) {
    foreach (Control x in c.Controls) { yield return x; foreach (var y in Descendants(x)) yield return y; }
  }
}
