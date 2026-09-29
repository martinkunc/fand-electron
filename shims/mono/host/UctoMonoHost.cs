// Runs an original Účto .NET helper under Mono without modifying it:
//  * the helper runs in its own AppDomain with ApplicationBase = its folder and the
//    configuration file it expects (the helpers set APP_CONFIG_FILE, which Mono ignores);
//  * substitute assemblies from shim folders (e.g. Rebex backed by Mono's TLS, UctoShim) and
//    the patched copies of the helper's private DLLs are preloaded into that domain, so the
//    helper binds to them instead of the originals.
//
// Automatic mode (what the app uses on Linux/macOS):
//   mono UctoMonoHost.exe [--cache <dir>] [--shims <dir>[;<dir>]] [--config <file>|-] [--no-patch] [--]
//        <helper.exe> [helper args...]
//   * patches a copy of the helper (../patch/UctoPatch.exe, cached by SHA-256; default cache
//     $UCTO_PATCH_CACHE or ~/.cache/ucto/mono-patch, ~/Library/Caches/ucto/mono-patch on macOS);
//   * shim folders: <shims>/shimlib, <shims>/rebex/bin/<version of the helper folder's
//     Rebex.Common.dll>, plus --shims. <shims> is $UCTO_SHIMS or the parent of this exe's folder;
//   * config: --config, else the APP_CONFIG_FILE name the patcher found (matched
//     case-insensitively in the helper folder), else <helper>.exe.config;
//   * $MONO_REGISTRY_PATH defaults to <cache>/registry with the .NET 4.8 "Release" key the
//     helpers check for.
//   Helpers started by the helper (Process.Start of another .NET exe) run through the same host.
// Legacy mode (kept for scripts/mono/verify-linux.sh):
//   mono UctoMonoHost.exe <helper.exe>[=<patched copy>] <config file or -> <shim dir>[;<shim dir>] [helper args...]
// Exit code: the helper's (Main's return value or Environment.ExitCode); 1 on an unhandled exception.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;

[assembly: AssemblyTitle("UctoMonoHost")]
[assembly: AssemblyDescription("Runs Účto's original .NET helpers under Mono on Linux/macOS")]
[assembly: AssemblyVersion("2.0.0.0")]

public class Runner : MarshalByRefObject {
  public int Run(string exe, string load, string patchDir, string[] shimDirs, string[] preload, string[] args, string[] hostCmd, string mono) {
    var d = AppDomain.CurrentDomain;
    d.SetData("UCTO_HELPER_EXE", exe);
    d.SetData("UCTO_HELPER_ARGS", args);
    if (patchDir != null) d.SetData("UCTO_PATCH_DIR", patchDir);
    if (hostCmd != null) d.SetData("UCTO_HOST_CMD", hostCmd);
    if (mono != null) d.SetData("UCTO_MONO", mono);
    foreach (var dir in shimDirs)
      if (Directory.Exists(dir)) foreach (var f in Directory.GetFiles(dir, "*.dll")) Assembly.LoadFrom(f);
    foreach (var f in preload) Assembly.LoadFrom(f);
    var asm = Assembly.LoadFrom(load);
    d.SetData("UCTO_ENTRY", asm);
    var ep = asm.EntryPoint;
    if (ep == null) throw new InvalidOperationException(load + " has no entry point");
    var ps = ep.GetParameters();
    object r = ep.Invoke(null, ps.Length == 0 ? null : new object[] { args });
    return r is int ? (int)r : Environment.ExitCode;
  }
}

public static class Program {
  static string HostDir { get { return Path.GetDirectoryName(Path.GetFullPath(typeof(Program).Assembly.Location)); } }

  public static int Main(string[] argv) {
    try {
      if (argv.Length == 0) return Usage();
      return IsLegacy(argv) ? Legacy(argv) : Auto(argv);
    } catch (TargetInvocationException e) {
      Console.Error.WriteLine(e.InnerException);
      return 1;
    } catch (Exception e) {
      Console.Error.WriteLine("UctoMonoHost: " + e);
      return 1;
    }
  }

  static int Usage() {
    Console.Error.WriteLine("usage: UctoMonoHost [--cache <dir>] [--shims <dirs>] [--config <file>|-] [--no-patch] [--] <helper.exe> [args]\n" +
                            "       UctoMonoHost <helper.exe>[=<patched>] <config|-> <shimdirs> [args]");
    return 2;
  }

  /// Legacy form: "<exe>[=<copy>] <config|-> <shimdirs|-> ...": the second argument is "-" or
  /// an existing .xml/.config file and the third "-" or existing folders.
  static bool IsLegacy(string[] a) {
    if (a.Length < 3 || a[0].StartsWith("--", StringComparison.Ordinal)) return false;
    if (a[0].Contains("=")) return true;
    bool cfg = a[1] == "-" || (File.Exists(a[1]) && (a[1].EndsWith(".xml", StringComparison.OrdinalIgnoreCase) || a[1].EndsWith(".config", StringComparison.OrdinalIgnoreCase)));
    bool shims = a[2] == "-" || a[2].Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries).All(Directory.Exists);
    return cfg && shims;
  }

  static int Legacy(string[] argv) {
    string[] ex = argv[0].Split('=');
    string exe = Path.GetFullPath(ex[0]);
    string load = ex.Length > 1 ? Path.GetFullPath(ex[1]) : exe;
    string cfg = argv[1] == "-" ? exe + ".config" : Path.GetFullPath(argv[1]);
    string[] shims = argv[2].Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
    string[] args = argv.Skip(3).ToArray();
    return RunInDomain(exe, load, load == exe ? null : Path.GetDirectoryName(load), cfg, shims, new string[0], args, null);
  }

  static int Auto(string[] argv) {
    string cache = null, config = null; bool patch = true;
    var extraShims = new List<string>();
    int i = 0;
    for (; i < argv.Length; i++) {
      string a = argv[i];
      if (a == "--") { i++; break; }
      if (!a.StartsWith("--", StringComparison.Ordinal)) break;
      switch (a) {
        case "--cache": cache = argv[++i]; break;
        case "--shims": extraShims.AddRange(argv[++i].Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries)); break;
        case "--config": config = argv[++i]; break;
        case "--no-patch": patch = false; break;
        default: Console.Error.WriteLine("UctoMonoHost: unknown option " + a); return Usage();
      }
    }
    if (i >= argv.Length) return Usage();
    string exe = Path.GetFullPath(argv[i]);
    string[] args = argv.Skip(i + 1).ToArray();
    if (!File.Exists(exe)) { Console.Error.WriteLine("UctoMonoHost: " + exe + " not found"); return 2; }
    string exeDir = Path.GetDirectoryName(exe);

    string shimRoot = Environment.GetEnvironmentVariable("UCTO_SHIMS");
    if (string.IsNullOrEmpty(shimRoot)) shimRoot = Path.GetDirectoryName(HostDir);
    string shimLib = Path.Combine(shimRoot, "shimlib");
    var shims = new List<string> { shimLib };
    string rebex = RebexShims(shimRoot, exeDir);
    if (rebex != null) shims.Add(rebex);
    shims.AddRange(extraShims.Select(Path.GetFullPath));

    if (string.IsNullOrEmpty(cache)) cache = UctoPatchCacheRoot(shimRoot);
    cache = Path.GetFullPath(cache);
    SeedRegistry(cache);

    string load = exe, patchDir = null, cfgName = "";
    var preload = new List<string>();
    if (patch) {
      var exclude = shims.Where(Directory.Exists).SelectMany(d => Directory.GetFiles(d, "*.dll")).Select(Path.GetFileNameWithoutExtension).Distinct().ToArray();
      var r = PrepareCopy(shimRoot, exe, cache, Path.Combine(shimLib, "UctoShim.dll"), exclude);
      patchDir = r[0]; cfgName = r[1];
      load = Path.Combine(patchDir, Path.GetFileName(exe));
      preload.AddRange(Directory.GetFiles(patchDir, "*.dll"));
    }

    string cfg;
    if (config == "-") cfg = exe + ".config";
    else if (!string.IsNullOrEmpty(config)) cfg = Path.GetFullPath(config);
    else if (!string.IsNullOrEmpty(cfgName)) cfg = FindCI(exeDir, cfgName) ?? Path.Combine(exeDir, cfgName);
    else cfg = exe + ".config";

    var hostCmd = new List<string> { Path.GetFullPath(typeof(Program).Assembly.Location), "--cache", cache };
    if (extraShims.Count > 0) { hostCmd.Add("--shims"); hostCmd.Add(string.Join(";", extraShims.Select(Path.GetFullPath))); }
    if (!patch) hostCmd.Add("--no-patch");
    hostCmd.Add("--");
    return RunInDomain(exe, load, patchDir, cfg, shims.ToArray(), preload.ToArray(), args, hostCmd.ToArray());
  }

  static int RunInDomain(string exe, string load, string patchDir, string cfg, string[] shims, string[] preload, string[] args, string[] hostCmd) {
    var setup = new AppDomainSetup { ApplicationBase = Path.GetDirectoryName(exe), ConfigurationFile = cfg, ApplicationName = Path.GetFileNameWithoutExtension(exe) };
    var dom = AppDomain.CreateDomain(setup.ApplicationName, null, setup);
    var runner = (Runner)dom.CreateInstanceFromAndUnwrap(typeof(Runner).Assembly.Location, typeof(Runner).FullName);
    return runner.Run(exe, load, patchDir, shims, preload, args, hostCmd, MonoPath());
  }

  static string MonoPath() {
    var env = Environment.GetEnvironmentVariable("UCTO_MONO");
    if (!string.IsNullOrEmpty(env)) return env;
    try {
      var f = Process.GetCurrentProcess().MainModule.FileName;
      if (!string.IsNullOrEmpty(f) && File.Exists(f)) return f;
    } catch (Exception) { }
    return "mono";
  }

  /// <root>/rebex/bin/<version of the helper folder's Rebex.Common.dll>, when both exist.
  static string RebexShims(string root, string exeDir) {
    string orig = FindCI(exeDir, "Rebex.Common.dll");
    if (orig == null) return null;
    string ver;
    try { ver = AssemblyName.GetAssemblyName(orig).Version.ToString(); } catch (Exception) { return null; }
    string dir = Path.Combine(root, "rebex", "bin", ver);
    return Directory.Exists(dir) ? dir : null;
  }

  static string FindCI(string dir, string name) {
    string p = Path.Combine(dir, name);
    if (File.Exists(p)) return p;
    return Directory.GetFiles(dir).FirstOrDefault(f => string.Equals(Path.GetFileName(f), name, StringComparison.OrdinalIgnoreCase));
  }

  /// Loads ../patch/UctoPatch.exe into this (default) domain and calls Patcher.Prepare.
  static string[] PrepareCopy(string root, string exe, string cache, string shimDll, string[] exclude) {
    var asm = Assembly.LoadFrom(Path.Combine(root, "patch", "UctoPatch.exe"));
    var prepare = asm.GetType("UctoPatch.Patcher", true).GetMethod("Prepare");
    return (string[])prepare.Invoke(null, new object[] { exe, cache, shimDll, exclude, Console.Error });
  }

  static string UctoPatchCacheRoot(string root) {
    var env = Environment.GetEnvironmentVariable("UCTO_PATCH_CACHE");
    if (!string.IsNullOrEmpty(env)) return env;
    var asm = Assembly.LoadFrom(Path.Combine(root, "patch", "UctoPatch.exe"));
    return (string)asm.GetType("UctoPatch.Patcher", true).GetMethod("DefaultCacheRoot").Invoke(null, null);
  }

  /// Mono keeps HKLM in files; give the helpers the .NET Framework 4.8 key they check
  /// (UctoXml refuses to start without it) unless the caller chose a registry already.
  static void SeedRegistry(string cache) {
    if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MONO_REGISTRY_PATH"))) return;
    string reg = Path.Combine(cache, "registry");
    string key = Path.Combine(reg, "LocalMachine", "software", "microsoft", "net framework setup", "ndp", "v4", "full");
    try {
      if (!File.Exists(Path.Combine(key, "values.xml"))) {
        Directory.CreateDirectory(key);
        File.WriteAllText(Path.Combine(key, "values.xml"),
          "<values>\n<value name=\"Release\"\ntype=\"int\">528040</value>\n<value name=\"Version\"\ntype=\"string\">4.8.03761</value>\n<value name=\"Install\"\ntype=\"int\">1</value>\n</values>\n");
      }
      Environment.SetEnvironmentVariable("MONO_REGISTRY_PATH", reg);
    } catch (Exception e) {
      Console.Error.WriteLine("UctoMonoHost: registry seed failed: " + e.Message);
    }
  }
}
