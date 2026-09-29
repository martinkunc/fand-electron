// Test "helper" for the Process.Start redirection (../../test-helpers.sh copies it into the
// Účto test folder and runs it through UctoMonoHost, so it gets patched like a real helper):
//   StartChild.exe <other .NET helper (DOS path)> <its argument> <document (DOS path)>
// 1. starts the other helper with Process.Start(file, args) and waits for it (it must run
//    through the same host), 2. opens the document with Process.Start(file) (-> opener),
// 3. starts it again through a Process instance with ProcessStartInfo + Start().
using System;
using System.Diagnostics;

static class StartChild {
  static int Main(string[] a) {
    var p = Process.Start(a[0], a[1]);
    p.WaitForExit();
    Console.WriteLine("child exit " + p.ExitCode);
    var d = Process.Start(a[2]);
    if (d != null) d.WaitForExit();
    var q = new Process { StartInfo = new ProcessStartInfo(a[0]) { Arguments = a[1] + ".2", UseShellExecute = false } };
    q.Start();
    q.WaitForExit();
    Console.WriteLine("child2 exit " + q.ExitCode);
    return p.ExitCode == 0 && q.ExitCode == 0 ? 0 : 1;
  }
}
