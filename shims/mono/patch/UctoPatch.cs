// UctoPatch: makes patched copies of an original Účto .NET helper (and the private DLLs of
// its folder that need it) so it runs under Mono on Linux/macOS. The originals are never
// modified; copies go to a cache keyed by SHA-256. The rewritten calls land in UctoShim.dll
// (../shimlib). What is rewritten:
//   * Environment.GetCommandLineArgs/OSVersion/GetFolderPath/NewLine, Assembly.GetEntryAssembly,
//     Assembly.Location/CodeBase, Application.StartupPath/ExecutablePath -> UctoShim.Env
//     (argv[0] and locations are the original exe, the OS reports Windows 10, CRLF);
//   * every string argument named like a path (path, fileName, destFileName, ...) of a
//     framework method, constructor (newobj FileInfo(...)) or instance method
//     (fi.CopyTo(dest)) -> UctoShim.PathFix.Fix (backslashes, X:\ via $UCTO_DRIVE_X, case);
//     System.IO.Path.* arguments -> PathFix.Norm;
//   * StreamWriter/StringWriter/XmlWriterSettings/File.WriteAllLines/StringBuilder.AppendLine -> CRLF;
//   * Process.Start -> UctoShim.Os (documents/URLs: xdg-open/open; .NET helpers: same host);
//   * FileDialog/FolderBrowserDialog paths -> UctoShim.Forms.Dialogs (DOS paths back to Účto);
//   * [DllImport] methods of user32/kernel32/gdi32/mapi32 that UctoShim.Win32 implements
//     become managed methods calling it; (int)IntPtr/(IntPtr)int -> UctoShim.Ptr there;
//   * type redirects: System.Data.OleDb.* -> UctoShim.Data.* (DBF reader),
//     System.Windows.Forms.WebBrowser -> UctoShim.Forms.WebBrowser.
//
// Usage:
//   mono UctoPatch.exe <in.exe|dll> <out> <UctoShim.dll>          patch one assembly
//   mono UctoPatch.exe --prepare <helper.exe> --shim <UctoShim.dll> [--cache <dir>] [--exclude a;b]
//        prints "dir=<patched folder>" and "config=<APP_CONFIG_FILE name>" (cached, idempotent)
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

[assembly: AssemblyTitle("UctoPatch")]
[assembly: AssemblyDescription("Patches copies of Účto's .NET helpers to run under Mono on Linux/macOS")]
[assembly: AssemblyVersion("2.0.0.0")]

namespace UctoPatch {
  /// Cache handling. Nothing here touches Mono.Cecil, so a cache hit never loads it.
  public static class Patcher {
    /// Bump when the rewriting changes: it is part of the cache key.
    public const string Version = "2";
    public const string ManifestName = "uctopatch.manifest";

    public static string DefaultCacheRoot() {
      var env = Environment.GetEnvironmentVariable("UCTO_PATCH_CACHE");
      if (!string.IsNullOrEmpty(env)) return env;
      string home = Environment.GetEnvironmentVariable("HOME") ?? Path.GetTempPath();
      if (Directory.Exists("/System/Library") && File.Exists("/usr/bin/open")) return Path.Combine(home, "Library/Caches/ucto/mono-patch");
      var xdg = Environment.GetEnvironmentVariable("XDG_CACHE_HOME");
      return Path.Combine(string.IsNullOrEmpty(xdg) ? Path.Combine(home, ".cache") : xdg, "ucto/mono-patch");
    }

    public static string Sha256(string file) {
      using (var s = File.OpenRead(file)) using (var h = SHA256.Create())
        return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant();
    }

    /// Returns { patched folder, config file name or "" }. The folder holds the patched exe
    /// (same file name) and the patched private DLLs; unlisted DLLs load from the original folder.
    public static string[] Prepare(string exe, string cacheRoot, string shimDll, string[] exclude, TextWriter log) {
      exe = Path.GetFullPath(exe);
      if (string.IsNullOrEmpty(cacheRoot)) cacheRoot = DefaultCacheRoot();
      string key = Sha256Text(Version + "\n" + Sha256(shimDll) + "\n" + Sha256(exe));
      string dir = Path.Combine(Path.GetFullPath(cacheRoot), Path.GetFileNameWithoutExtension(exe) + "-" + key.Substring(0, 20));
      var hit = ReadManifest(dir, Path.GetDirectoryName(exe));
      if (hit != null) return hit;
      Directory.CreateDirectory(cacheRoot);
      string tmp = dir + ".tmp" + System.Diagnostics.Process.GetCurrentProcess().Id;
      if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
      Directory.CreateDirectory(tmp);
      try {
        string manifest = Folder.Patch(exe, tmp, shimDll, exclude ?? new string[0], log ?? TextWriter.Null);
        File.WriteAllText(Path.Combine(tmp, ManifestName), manifest);
        if (Directory.Exists(dir)) Directory.Delete(dir, true);   // stale (a dependency changed)
        try { Directory.Move(tmp, dir); }
        catch (IOException) { if (ReadManifest(dir, Path.GetDirectoryName(exe)) == null) throw; }   // lost a race: use the winner's
      } finally {
        if (Directory.Exists(tmp)) try { Directory.Delete(tmp, true); } catch (Exception) { }
      }
      var r = ReadManifest(dir, Path.GetDirectoryName(exe));
      if (r == null) throw new IOException("UctoPatch: cache entry " + dir + " is not valid after patching");
      return r;
    }

    static string Sha256Text(string s) {
      using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(Encoding.UTF8.GetBytes(s))).Replace("-", "").ToLowerInvariant();
    }

    /// Valid when complete and every private DLL it was built from is unchanged.
    static string[] ReadManifest(string dir, string exeDir) {
      string mf = Path.Combine(dir, ManifestName);
      if (!File.Exists(mf)) return null;
      string config = "";
      foreach (var line in File.ReadAllLines(mf)) {
        int eq = line.IndexOf('=');
        if (eq < 0) continue;
        string k = line.Substring(0, eq), v = line.Substring(eq + 1);
        if (k == "config") config = v;
        else if (k == "dep") {
          var parts = v.Split(' ');
          string f = Path.Combine(exeDir, parts[0]);
          if (!File.Exists(f) || Sha256(f) != parts[1]) return null;
        } else if (k == "version" && v != Version) return null;
      }
      return new[] { dir, config };
    }
  }

  public static class Program {
    public static int Main(string[] a) {
      try {
        if (a.Length > 0 && a[0] == "--prepare") {
          string exe = null, cache = null, shim = null; string[] exclude = new string[0];
          for (int i = 1; i < a.Length; i++) {
            switch (a[i]) {
              case "--cache": cache = a[++i]; break;
              case "--shim": shim = a[++i]; break;
              case "--exclude": exclude = a[++i].Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries); break;
              default: exe = a[i]; break;
            }
          }
          if (exe == null || shim == null) return Usage();
          var r = Patcher.Prepare(exe, cache, shim, exclude, Console.Error);
          Console.WriteLine("dir=" + r[0]);
          Console.WriteLine("config=" + r[1]);
          return 0;
        }
        if (a.Length != 3) return Usage();
        var stats = Folder.PatchOne(a[0], a[1], a[2], true);
        Console.WriteLine("patched call sites: " + stats.Count + (stats.Details.Length > 0 ? " (" + stats.Details + ")" : ""));
        return 0;
      } catch (Exception e) {
        Console.Error.WriteLine("UctoPatch: " + e);
        return 1;
      }
    }
    static int Usage() {
      Console.Error.WriteLine("usage: UctoPatch.exe <in> <out> <UctoShim.dll>\n       UctoPatch.exe --prepare <helper.exe> --shim <UctoShim.dll> [--cache <dir>] [--exclude a;b]");
      return 2;
    }
  }
}
