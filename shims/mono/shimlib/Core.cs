// Runtime support for patched Účto helpers running under Mono on Unix (see ../patch/UctoPatch.cs).
// The patcher redirects calls in a helper's IL to the static methods here; nothing in this
// file changes behaviour on Windows, where the originals run unpatched anyway.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;

[assembly: AssemblyTitle("UctoShim")]
[assembly: AssemblyDescription("Runtime support for Účto's .NET helpers patched to run under Mono on Linux/macOS")]
[assembly: AssemblyProduct("Účto for Electron - Mono helper shims")]
[assembly: AssemblyVersion("1.0.0.0")]

namespace UctoShim {
  /// Keys of the AppDomain data the launcher (../host/UctoMonoHost.cs) sets in the helper's domain.
  public static class HostData {
    public const string HelperExe = "UCTO_HELPER_EXE";     // string: original helper exe (full path)
    public const string HelperArgs = "UCTO_HELPER_ARGS";   // string[]: helper arguments
    public const string PatchDir = "UCTO_PATCH_DIR";       // string: folder of the patched copies
    public const string EntryAssembly = "UCTO_ENTRY";      // Assembly: the loaded helper assembly
    public const string Mono = "UCTO_MONO";                // string: mono executable
    public const string HostCommand = "UCTO_HOST_CMD";     // string[]: host exe + options, helper exe and args follow
    internal static T Get<T>(string key) where T : class { return AppDomain.CurrentDomain.GetData(key) as T; }
  }

  public static class Env {
    /// Environment.GetCommandLineArgs(): argv[0] is the original helper exe, then its arguments.
    public static string[] GetCommandLineArgs() {
      var real = Environment.GetCommandLineArgs();
      var exe = HostData.Get<string>(HostData.HelperExe);
      var args = HostData.Get<string[]>(HostData.HelperArgs);
      if (exe == null) return real;
      return new[] { exe }.Concat(args ?? new string[0]).ToArray();
    }

    /// Environment.OSVersion: the helpers check for Windows 7+/10 (UctoXml refuses to run otherwise).
    public static OperatingSystem GetOSVersion() {
      if (Path.DirectorySeparatorChar == '\\') return Environment.OSVersion;
      return new OperatingSystem(PlatformID.Win32NT, new Version(10, 0, 19045, 0));
    }

    /// Environment.GetFolderPath: Mono returns "" (or a folder that does not exist) for several
    /// Windows special folders on Unix; fall back to the home folder so saving still works.
    public static string GetFolderPath(Environment.SpecialFolder folder) {
      return Existing(Environment.GetFolderPath(folder), folder);
    }
    public static string GetFolderPath(Environment.SpecialFolder folder, Environment.SpecialFolderOption option) {
      return Existing(Environment.GetFolderPath(folder, option), folder);
    }
    static string Existing(string p, Environment.SpecialFolder folder) {
      if (!string.IsNullOrEmpty(p) && Directory.Exists(p)) return p;
      if (folder == Environment.SpecialFolder.Desktop || folder == Environment.SpecialFolder.DesktopDirectory ||
          folder == Environment.SpecialFolder.MyDocuments || folder == Environment.SpecialFolder.Personal) {
        string home = Environment.GetEnvironmentVariable("HOME");
        if (!string.IsNullOrEmpty(home) && Directory.Exists(home)) return home;
      }
      return p;
    }

    /// Assembly.GetEntryAssembly(): null in the launcher's secondary AppDomain otherwise.
    public static Assembly GetEntryAssembly() {
      return Assembly.GetEntryAssembly() ?? AppDomain.CurrentDomain.GetData(HostData.EntryAssembly) as Assembly;
    }

    /// Assembly.Location of a patched copy is the original file next to the helper exe.
    public static string GetAssemblyLocation(Assembly a) {
      if (a == null) throw new NullReferenceException();
      return Original(a.Location);
    }
    public static string GetAssemblyCodeBase(Assembly a) {
      if (a == null) throw new NullReferenceException();
      string loc = a.Location, orig = Original(loc);
      return orig == loc ? a.CodeBase : new Uri(orig).AbsoluteUri;
    }
    static string Original(string loc) {
      string dir = HostData.Get<string>(HostData.PatchDir), exe = HostData.Get<string>(HostData.HelperExe);
      if (string.IsNullOrEmpty(loc) || dir == null || exe == null) return loc;
      if (!string.Equals(Path.GetDirectoryName(Path.GetFullPath(loc)), Path.GetFullPath(dir).TrimEnd('/'), StringComparison.Ordinal)) return loc;
      return Path.Combine(Path.GetDirectoryName(exe), Path.GetFileName(loc));
    }

    /// System.Windows.Forms.Application.StartupPath / ExecutablePath: the original helper folder.
    public static string GetStartupPath() {
      var exe = HostData.Get<string>(HostData.HelperExe);
      return exe != null ? Path.GetDirectoryName(exe) : AppDomain.CurrentDomain.BaseDirectory.TrimEnd('/');
    }
    public static string GetExecutablePath() {
      return HostData.Get<string>(HostData.HelperExe) ?? Environment.GetCommandLineArgs()[0];
    }
  }

  /// DOS/Windows paths as Účto writes them (C:\UCTO2026\{AP02}\X.TXT) -> host paths.
  public static class PathFix {
    static bool Unix { get { return Path.DirectorySeparatorChar == '/'; } }

    static bool IsUrl(string p) {
      int i = p.IndexOf("://", StringComparison.Ordinal);
      if (i > 1) return true;
      return p.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase);
    }

    /// Backslashes -> '/', "X:\..." -> $UCTO_DRIVE_X/..., no case matching. Used for System.IO.Path.
    public static string Norm(string p) {
      if (string.IsNullOrEmpty(p) || !Unix || IsUrl(p)) return p;
      string s = p.Replace('\\', '/');
      // .NET Framework on Windows drops whitespace before a rooted path (" C:\x" -> "C:\x");
      // helpers rely on it when they split lists like "a.xsd, b.xsd".
      if (s.Length > 0 && char.IsWhiteSpace(s[0])) {
        string t = s.TrimStart();
        if (t.StartsWith("/", StringComparison.Ordinal) || (t.Length >= 2 && t[1] == ':' && char.IsLetter(t[0]))) s = t;
      }
      if (s.Length >= 2 && s[1] == ':' && char.IsLetter(s[0]) && (s.Length == 2 || s[2] == '/')) {
        var root = Environment.GetEnvironmentVariable("UCTO_DRIVE_" + char.ToUpperInvariant(s[0]));
        if (string.IsNullOrEmpty(root)) root = "/";
        string rest = s.Substring(2).TrimStart('/');
        s = root.TrimEnd('/') + "/" + rest;
      }
      return s;
    }

    /// Norm plus case-insensitive resolution of every existing path component (DOS names are
    /// case-insensitive, Účto folders are "{ap02}" on disk and "{AP02}" in FAND code).
    /// Relative paths stay relative; a trailing separator is kept.
    public static string Fix(string p) {
      if (string.IsNullOrEmpty(p) || !Unix || IsUrl(p)) return p;
      return MatchCase(Norm(p));
    }

    public static string[] Fix(string[] ps) {
      if (ps == null) return null;
      return ps.Select(Fix).ToArray();
    }

    static string MatchCase(string s) {
      if (s.Length == 0 || File.Exists(s) || Directory.Exists(s)) return s;
      bool abs = s.StartsWith("/", StringComparison.Ordinal);
      bool trailing = s.EndsWith("/", StringComparison.Ordinal);
      var parts = s.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
      string cur = abs ? "/" : "";                  // result so far
      string look = abs ? "/" : Directory.GetCurrentDirectory();
      bool missing = false;
      foreach (var part in parts) {
        string name = part;
        if (!missing && part != "." && part != "..") {
          string next = Path.Combine(look, part);
          if (!File.Exists(next) && !Directory.Exists(next)) {
            string hit = null;
            try {
              if (Directory.Exists(look))
                hit = Directory.GetFileSystemEntries(look).Select(Path.GetFileName)
                  .FirstOrDefault(e => string.Equals(e, part, StringComparison.OrdinalIgnoreCase));
            } catch (Exception) { }
            if (hit != null) name = hit; else missing = true;
          }
        }
        cur = cur.Length == 0 ? name : (cur.EndsWith("/", StringComparison.Ordinal) ? cur + name : cur + "/" + name);
        look = Path.Combine(look, name);
      }
      if (trailing && !cur.EndsWith("/", StringComparison.Ordinal)) cur += "/";
      return cur;
    }

    /// Host path -> DOS path for values handed back to Účto (file dialogs): the longest
    /// $UCTO_DRIVE_X root that contains the path becomes "X:\". Unchanged without a match.
    public static string ToDos(string p) {
      if (string.IsNullOrEmpty(p) || !Unix || !p.StartsWith("/", StringComparison.Ordinal)) return p;
      string best = null; char drive = '\0';
      for (char c = 'A'; c <= 'Z'; c++) {
        var root = Environment.GetEnvironmentVariable("UCTO_DRIVE_" + c);
        if (string.IsNullOrEmpty(root)) continue;
        root = root.TrimEnd('/');
        if ((p == root || p.StartsWith(root + "/", StringComparison.Ordinal)) && (best == null || root.Length > best.Length)) { best = root; drive = c; }
      }
      if (best == null) return p;
      return drive + ":\\" + p.Substring(best.Length).TrimStart('/').Replace('/', '\\');
    }
  }

  /// Process.Start replacements: documents and URLs open with the desktop's default
  /// application; other .NET helpers run through the same launcher; native Windows programs
  /// go to $UCTO_EXEC_NATIVE when the embedding app provides one.
  public static class Os {
    static bool Mac { get { return File.Exists("/usr/bin/open") && Directory.Exists("/System/Library"); } }

    /// Command that opens a document/URL: $UCTO_OPEN_CMD, else open (macOS) / xdg-open.
    public static string Opener {
      get {
        var cmd = Environment.GetEnvironmentVariable("UCTO_OPEN_CMD");
        if (!string.IsNullOrEmpty(cmd)) return cmd;
        return Mac ? "/usr/bin/open" : "xdg-open";
      }
    }

    public static string Quote(string a) {
      if (a == null) return "\"\"";
      if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"', '\'', '\\' }) < 0) return a;
      return "\"" + a.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    /// Opens a file or URL with the default application. Returns the opener process.
    public static Process Open(string target) {
      if (Path.DirectorySeparatorChar == '\\') return Process.Start(target);
      string t = target;
      if (!IsUrl(t)) { t = PathFix.Fix(t); try { t = Path.GetFullPath(t); } catch (Exception) { } }
      var psi = new ProcessStartInfo(Opener, Quote(t)) { UseShellExecute = false };
      return Process.Start(psi);
    }

    static bool IsUrl(string s) {
      int i = s.IndexOf(':');
      return i > 1 && (s.IndexOf("://", StringComparison.Ordinal) == i || s.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase));
    }

    public static Process Start(string fileName) { return Start(new ProcessStartInfo(fileName)); }
    public static Process Start(string fileName, string arguments) { return Start(new ProcessStartInfo(fileName, arguments)); }
    public static Process Start(ProcessStartInfo psi) {
      Prepare(psi);
      return Process.Start(psi);
    }
    /// Replacement for the instance method Process.Start().
    public static bool StartProcess(Process p) {
      Prepare(p.StartInfo);
      return p.Start();
    }

    /// Rewrites a ProcessStartInfo for Unix. Returns true when it now runs the opener.
    public static bool Prepare(ProcessStartInfo psi) {
      if (Path.DirectorySeparatorChar == '\\' || psi == null || string.IsNullOrEmpty(psi.FileName)) return false;
      if (!string.IsNullOrEmpty(psi.WorkingDirectory)) psi.WorkingDirectory = PathFix.Fix(psi.WorkingDirectory);
      string fn = psi.FileName;
      if (IsUrl(fn)) { ToOpener(psi, fn); return true; }
      string path = PathFix.Fix(fn);
      if (!File.Exists(path) && !string.IsNullOrEmpty(psi.WorkingDirectory) && !Path.IsPathRooted(path)) {
        string inWd = PathFix.Fix(Path.Combine(psi.WorkingDirectory, path));
        if (File.Exists(inWd)) path = inWd;
      }
      string ext = Path.GetExtension(path).ToLowerInvariant();
      if (ext == ".exe" || ext == ".com" || ext == ".bat" || ext == ".cmd") {
        if (File.Exists(path) && IsManaged(path)) {
          var host = HostData.Get<string[]>(HostData.HostCommand);
          var mono = HostData.Get<string>(HostData.Mono) ?? "mono";
          if (host != null) {
            psi.FileName = mono;
            psi.Arguments = string.Join(" ", host.Select(Quote)) + " " + Quote(Path.GetFullPath(path)) + (string.IsNullOrEmpty(psi.Arguments) ? "" : " " + psi.Arguments);
            psi.UseShellExecute = false;
            return false;
          }
        }
        var native = Environment.GetEnvironmentVariable("UCTO_EXEC_NATIVE");
        if (!string.IsNullOrEmpty(native)) {
          psi.Arguments = Quote(File.Exists(path) ? Path.GetFullPath(path) : fn) + (string.IsNullOrEmpty(psi.Arguments) ? "" : " " + psi.Arguments);
          psi.FileName = native;
          psi.UseShellExecute = false;
          return false;
        }
        psi.FileName = path;            // fails like a missing program would on Windows
        return false;
      }
      if (File.Exists(path) || Directory.Exists(path) || psi.UseShellExecute) {
        ToOpener(psi, File.Exists(path) || Directory.Exists(path) ? Path.GetFullPath(path) : path);
        return true;
      }
      psi.FileName = path;
      return false;
    }

    static void ToOpener(ProcessStartInfo psi, string target) {
      psi.FileName = Opener;
      psi.Arguments = Quote(target);
      psi.UseShellExecute = false;
      psi.Verb = "";
    }

    /// True for a .NET assembly (PE with a CLI header).
    public static bool IsManaged(string path) {
      try {
        using (var fs = File.OpenRead(path)) {
          var b = new BinaryReader(fs);
          if (fs.Length < 0x100 || b.ReadUInt16() != 0x5A4D) return false;
          fs.Position = 0x3C; int pe = b.ReadInt32();
          if (pe <= 0 || pe + 0x18 > fs.Length) return false;
          fs.Position = pe;
          if (b.ReadUInt32() != 0x4550) return false;
          fs.Position = pe + 0x18;
          ushort magic = b.ReadUInt16();
          int dirs = pe + 0x18 + (magic == 0x20B ? 112 : 96);
          fs.Position = dirs + 14 * 8;   // data directory 14: CLI header
          return b.ReadUInt32() != 0;
        }
      } catch (Exception) { return false; }
    }
  }

  /// Windows line ends (CRLF) in text the helpers write: Účto reads the files back as DOS text.
  public static class Io {
    public const string CrLf = "\r\n";
    public static T Crlf<T>(T w) where T : TextWriter { if (w != null) w.NewLine = CrLf; return w; }
    public static void WriteAllLines(string path, string[] contents) { WriteLines(path, contents, new UTF8Encoding(false), false); }
    public static void WriteAllLines(string path, string[] contents, Encoding encoding) { WriteLines(path, contents, encoding, false); }
    public static void WriteAllLines(string path, IEnumerable<string> contents) { WriteLines(path, contents, new UTF8Encoding(false), false); }
    public static void WriteAllLines(string path, IEnumerable<string> contents, Encoding encoding) { WriteLines(path, contents, encoding, false); }
    public static void AppendAllLines(string path, IEnumerable<string> contents) { WriteLines(path, contents, new UTF8Encoding(false), true); }
    public static void AppendAllLines(string path, IEnumerable<string> contents, Encoding encoding) { WriteLines(path, contents, encoding, true); }
    static void WriteLines(string path, IEnumerable<string> lines, Encoding enc, bool append) {
      if (lines == null) throw new ArgumentNullException("contents");
      using (var w = new StreamWriter(PathFix.Fix(path), append, enc)) {
        w.NewLine = CrLf;
        foreach (var l in lines) w.WriteLine(l);
      }
    }
    public static StringBuilder AppendLine(StringBuilder sb) { return sb.Append(CrLf); }
    public static StringBuilder AppendLine(StringBuilder sb, string value) { return sb.Append(value).Append(CrLf); }
  }

  /// 32-bit pointer arithmetic in helpers built for x86 ((int)ptr + size, (IntPtr)int) would
  /// truncate 64-bit addresses. The patcher routes those conversions here in assemblies whose
  /// P/Invokes it redirected: values that fit stay unchanged, larger addresses are encoded
  /// as 0x40000000 | window << 24 | offset within a 16 MB window.
  public static class Ptr {
    const int Tag = 0x40000000, Shift = 24, Mask = (1 << Shift) - 1, MaxWindows = 62;
    static readonly List<long> windows = new List<long>();
    static readonly object gate = new object();

    public static int ToInt32(IntPtr p) {
      long v = p.ToInt64();
      if (v >= int.MinValue && v <= int.MaxValue) return (int)v;
      long w = v >> Shift;
      lock (gate) {
        int i = windows.IndexOf(w);
        if (i < 0) {
          if (windows.Count + 2 > MaxWindows) throw new OverflowException("UctoShim.Ptr: too many 64-bit pointer windows");
          i = windows.Count; windows.Add(w);
        }
        if (i == windows.Count - 1) windows.Add(w + 1);   // arithmetic may cross into the next window
        return Tag | (i << Shift) | (int)(v & Mask);
      }
    }

    public static IntPtr FromInt32(int e) {
      if (e > 0 && (e & Tag) != 0) {
        int i = (e & ~Tag) >> Shift;
        lock (gate) if (i < windows.Count) return new IntPtr((windows[i] << Shift) | (long)(uint)(e & Mask));
      }
      return new IntPtr(e);
    }
  }
}
