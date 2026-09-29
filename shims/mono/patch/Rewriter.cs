// The IL rewriting of UctoPatch (see UctoPatch.cs for the list of rewrites).
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Mono.Cecil;
using Mono.Cecil.Cil;

namespace UctoPatch {
  public class Stats {
    public int Count;
    public string ConfigName;
    public readonly SortedDictionary<string, int> Kinds = new SortedDictionary<string, int>();
    public void Add(string kind) { Count++; int n; Kinds.TryGetValue(kind, out n); Kinds[kind] = n + 1; }
    public string Details { get { return string.Join(", ", Kinds.Select(k => k.Key + " " + k.Value)); } }
  }

  /// Patches a helper exe and the private DLLs of its folder it (transitively) references.
  public static class Folder {
    // Public key tokens of framework / Microsoft assemblies: their methods are the "framework"
    // whose path arguments get fixed; private DLLs signed with them are not patched themselves
    // (e.g. DocumentFormat.OpenXml: its callers' paths are already fixed).
    internal static readonly HashSet<string> FrameworkTokens = new HashSet<string> {
      "b77a5c561934e089", "b03f5f7f11d50a3a", "31bf3856ad364e35", "cc7b13ffcd2ddd51", "0738eb9f132ed756", "adb9793829ddae60" };

    internal static string Token(byte[] t) { return t == null ? "" : BitConverter.ToString(t).Replace("-", "").ToLowerInvariant(); }

    public static string Patch(string exe, string outDir, string shimDll, string[] exclude, TextWriter log) {
      string dir = Path.GetDirectoryName(exe);
      var files = Directory.GetFiles(dir).Where(f => f.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
        .ToDictionary(f => Path.GetFileNameWithoutExtension(f), f => f, StringComparer.OrdinalIgnoreCase);
      var skip = new HashSet<string>(exclude.Select(e => e.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) ? e.Substring(0, e.Length - 4) : e), StringComparer.OrdinalIgnoreCase);
      var todo = new Queue<string>(); var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      todo.Enqueue(exe);
      var mf = new StringBuilder();
      mf.Append("version=").Append(Patcher.Version).Append('\n');
      mf.Append("exe=").Append(Path.GetFileName(exe)).Append('\n');
      string config = "";
      while (todo.Count > 0) {
        string f = todo.Dequeue();
        bool isExe = f == exe;
        List<string> refs;
        using (var probe = ModuleDefinition.ReadModule(f)) {
          refs = probe.AssemblyReferences.Select(r => r.Name).ToList();
          if (!isExe && FrameworkTokens.Contains(Token(probe.Assembly.Name.PublicKeyToken))) continue;
        }
        foreach (var r in refs)
          if (files.ContainsKey(r) && !skip.Contains(r) && seen.Add(r)) todo.Enqueue(files[r]);
        string outFile = Path.Combine(outDir, Path.GetFileName(f));
        var st = PatchOne(f, outFile, shimDll, isExe);
        if (isExe) config = st.ConfigName ?? "";
        else {
          mf.Append("dep=").Append(Path.GetFileName(f)).Append(' ').Append(Patcher.Sha256(f)).Append('\n');
          if (st.Count == 0) File.Delete(outFile);
        }
        if (isExe || st.Count > 0) mf.Append("patched=").Append(Path.GetFileName(f)).Append('\n');
        log.WriteLine("UctoPatch: " + Path.GetFileName(f) + ": " + st.Count + " call sites" + (st.Count > 0 ? " (" + st.Details + ")" : ""));
      }
      mf.Append("config=").Append(config).Append('\n');
      return mf.ToString();
    }

    /// Patches one assembly into outFile (always written). Returns what was changed.
    public static Stats PatchOne(string inFile, string outFile, string shimDll, bool isExe) {
      var resolver = new DefaultAssemblyResolver();
      resolver.AddSearchDirectory(Path.GetDirectoryName(Path.GetFullPath(inFile)));
      resolver.AddSearchDirectory(Path.GetDirectoryName(Path.GetFullPath(shimDll)));
      using (var shim = ModuleDefinition.ReadModule(shimDll))
      using (var m = ModuleDefinition.ReadModule(inFile, new ReaderParameters { AssemblyResolver = resolver, ReadSymbols = false, InMemory = true })) {
        var rw = new Rewriter(m, shim);
        rw.Run();
        m.Write(outFile);
        return rw.Stats;
      }
    }
  }

  class Rewriter {
    readonly ModuleDefinition m, shim;
    public readonly Stats Stats = new Stats();
    readonly TypeDefinition holder;
    readonly Dictionary<string, MethodDefinition> wrappers = new Dictionary<string, MethodDefinition>();
    readonly Dictionary<string, MethodDefinition> resolved = new Dictionary<string, MethodDefinition>();
    bool pinvokeRedirected;

    static readonly HashSet<string> PathParams = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
      "path", "fileName", "sourceFileName", "destFileName", "destinationFileName", "destinationBackupFileName",
      "sourceDirName", "destDirName", "inputUri", "outputFileName", "uri", "url", "stylesheetUri", "exePath",
      "sourceDirectoryName", "destinationDirectoryName", "sourceArchiveFileName", "destinationArchiveFileName",
      "archiveFileName", "filePath", "directoryName", "assemblyFile" };
    // Methods whose "path"-named arguments are not host paths.
    static readonly HashSet<string> NoPathTypes = new HashSet<string> {
      "System.IO.Path", "System.Reflection.Assembly", "System.AppDomain", "System.Environment", "System.Uri",
      "System.Web.HttpUtility", "System.Net.WebRequest", "System.Net.HttpWebRequest", "System.Diagnostics.Process",
      "System.Diagnostics.ProcessStartInfo", "System.Configuration.ConfigurationManager",
      "System.Xml.XmlNamespaceManager", "System.Xml.Serialization.XmlSerializerNamespaces", "System.Xml.XmlNameTable", "System.Xml.NameTable" };
    static readonly HashSet<string> WriterTypes = new HashSet<string> { "System.IO.StreamWriter", "System.IO.StringWriter" };

    static readonly Dictionary<string, string> TypeRedirects = new Dictionary<string, string> {
      { "System.Data.OleDb.OleDbConnection", "UctoShim.Data" },
      { "System.Data.OleDb.OleDbCommand", "UctoShim.Data" },
      { "System.Data.OleDb.OleDbDataAdapter", "UctoShim.Data" },
      { "System.Data.OleDb.OleDbDataReader", "UctoShim.Data" },
      { "System.Windows.Forms.WebBrowser", "UctoShim.Forms" },
    };

    // "Type::method" -> "ShimType::method"; instance methods get the object as first argument.
    static readonly Dictionary<string, string> Redirects = new Dictionary<string, string> {
      { "System.Environment::GetCommandLineArgs", "UctoShim.Env::GetCommandLineArgs" },
      { "System.Environment::get_OSVersion", "UctoShim.Env::GetOSVersion" },
      { "System.Environment::GetFolderPath", "UctoShim.Env::GetFolderPath" },
      { "System.Reflection.Assembly::GetEntryAssembly", "UctoShim.Env::GetEntryAssembly" },
      { "System.Reflection.Assembly::get_Location", "UctoShim.Env::GetAssemblyLocation" },
      { "System.Reflection.Assembly::get_CodeBase", "UctoShim.Env::GetAssemblyCodeBase" },
      { "System.Windows.Forms.Application::get_StartupPath", "UctoShim.Env::GetStartupPath" },
      { "System.Windows.Forms.Application::get_ExecutablePath", "UctoShim.Env::GetExecutablePath" },
      { "System.Diagnostics.Process::Start", "UctoShim.Os::Start|StartProcess" },
      { "System.IO.File::WriteAllLines", "UctoShim.Io::WriteAllLines" },
      { "System.IO.File::AppendAllLines", "UctoShim.Io::AppendAllLines" },
      { "System.Text.StringBuilder::AppendLine", "UctoShim.Io::AppendLine" },
      { "System.Windows.Forms.FileDialog::get_FileName", "UctoShim.Forms.Dialogs::GetFileName" },
      { "System.Windows.Forms.FileDialog::get_FileNames", "UctoShim.Forms.Dialogs::GetFileNames" },
      { "System.Windows.Forms.FileDialog::set_FileName", "UctoShim.Forms.Dialogs::SetFileName" },
      { "System.Windows.Forms.FileDialog::set_InitialDirectory", "UctoShim.Forms.Dialogs::SetInitialDirectory" },
      { "System.Windows.Forms.FolderBrowserDialog::get_SelectedPath", "UctoShim.Forms.Dialogs::GetSelectedPath" },
      { "System.Windows.Forms.FolderBrowserDialog::set_SelectedPath", "UctoShim.Forms.Dialogs::SetSelectedPath" },
    };

    static readonly Dictionary<string, string> Libraries = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
      { "user32", "UctoShim.Win32.User32" }, { "kernel32", "UctoShim.Win32.Kernel32" },
      { "gdi32", "UctoShim.Win32.Gdi32" }, { "mapi32", "UctoShim.Win32.Mapi32" } };

    public Rewriter(ModuleDefinition m, ModuleDefinition shim) {
      this.m = m; this.shim = shim;
      holder = new TypeDefinition("UctoShim.Generated", "Wrappers", TypeAttributes.NotPublic | TypeAttributes.Abstract | TypeAttributes.Sealed | TypeAttributes.BeforeFieldInit, m.TypeSystem.Object);
    }

    AssemblyNameReference shimRef;
    AssemblyNameReference ShimRef {
      get {
        if (shimRef != null) return shimRef;
        var n = shim.Assembly.Name;
        shimRef = m.AssemblyReferences.FirstOrDefault(r => r.Name == n.Name);
        if (shimRef == null) { shimRef = new AssemblyNameReference(n.Name, n.Version); m.AssemblyReferences.Add(shimRef); }
        return shimRef;
      }
    }

    public void Run() {
      if (m.Types.Any(t => t.Namespace == "UctoShim.Generated")) throw new InvalidOperationException(m.Name + " is already patched");
      RedirectTypes();
      RedirectPInvokes();
      foreach (var t in m.GetTypes().ToList())
        foreach (var md in t.Methods.Where(x => x.HasBody).ToList())
          RewriteBody(md);
      if (holder.Methods.Count > 0) m.Types.Add(holder);
    }

    // ---- type redirects (OleDb, WebBrowser) -------------------------------------------------
    void RedirectTypes() {
      foreach (var tr in m.GetTypeReferences().ToList()) {
        string ns;
        if (tr.DeclaringType != null || !TypeRedirects.TryGetValue(tr.FullName, out ns)) continue;
        if (shim.GetType(ns, tr.Name) == null) throw new InvalidOperationException("UctoShim has no " + ns + "." + tr.Name);
        tr.Namespace = ns;
        tr.Scope = ShimRef;
        Stats.Add("type " + tr.Name);
      }
    }

    // ---- P/Invoke -> managed stubs ------------------------------------------------------------
    void RedirectPInvokes() {
      foreach (var t in m.GetTypes())
        foreach (var md in t.Methods.Where(x => x.IsPInvokeImpl && x.PInvokeInfo != null).ToList()) {
          string lib = Path.GetFileNameWithoutExtension(md.PInvokeInfo.Module.Name.Replace('\\', '/').Split('/').Last().ToLowerInvariant().Replace(".dll", ""));
          string shimType;
          if (!Libraries.TryGetValue(lib, out shimType)) continue;
          string entry = md.PInvokeInfo.EntryPoint ?? md.Name;
          var st = shim.GetType(shimType);
          var target = FindStub(st, entry, md) ?? ((entry.EndsWith("A") || entry.EndsWith("W")) ? FindStub(st, entry.Substring(0, entry.Length - 1), md) : null);
          if (target == null) { Console.Error.WriteLine("UctoPatch: no managed stub for " + lib + "!" + entry + " (" + md.FullName + "), left as P/Invoke"); continue; }
          md.PInvokeInfo = null;        // (the setter marks the method pinvokeimpl again)
          md.IsPInvokeImpl = false;
          md.ImplAttributes = MethodImplAttributes.IL | MethodImplAttributes.Managed;
          md.Body = new MethodBody(md);
          var il = md.Body.GetILProcessor();
          for (int i = 0; i < md.Parameters.Count; i++) {
            il.Emit(OpCodes.Ldarg, md.Parameters[i]);
            var pt = md.Parameters[i].ParameterType;
            if (target.Parameters[i].ParameterType.FullName == "System.Object" && pt.IsValueType) il.Emit(OpCodes.Box, pt);
          }
          il.Emit(OpCodes.Call, m.ImportReference(target));
          ConvertReturn(il, target.ReturnType, md.ReturnType);
          il.Emit(OpCodes.Ret);
          pinvokeRedirected = true;
          Stats.Add("pinvoke " + lib);
        }
    }

    static readonly HashSet<string> Int32ish = new HashSet<string> { "System.Int32", "System.UInt32", "System.Boolean" };

    static bool ParamOk(TypeReference helper, TypeReference stub) {
      if (helper.FullName == stub.FullName) return true;
      if (stub.FullName == "System.Object" && !helper.IsByReference && !helper.IsPointer) return true;
      return Int32ish.Contains(helper.FullName) && Int32ish.Contains(stub.FullName) && helper.FullName != "System.Boolean" && stub.FullName != "System.Boolean";
    }

    static bool ReturnOk(TypeReference stub, TypeReference helper) {
      string s = stub.FullName, h = helper.FullName;
      return s == h || h == "System.Void" || (Int32ish.Contains(s) && Int32ish.Contains(h)) ||
        (s == "System.Int32" && h == "System.IntPtr") || (s == "System.IntPtr" && h == "System.Int32");
    }

    static MethodDefinition FindStub(TypeDefinition st, string name, MethodDefinition md) {
      return st.Methods.FirstOrDefault(x => x.IsStatic && x.IsPublic && x.Name == name && x.Parameters.Count == md.Parameters.Count &&
        x.Parameters.Select((p, i) => ParamOk(md.Parameters[i].ParameterType, p.ParameterType)).All(ok => ok) && ReturnOk(x.ReturnType, md.ReturnType));
    }

    static void ConvertReturn(ILProcessor il, TypeReference from, TypeReference to) {
      string f = from.FullName, t = to.FullName;
      if (f == t) return;
      if (t == "System.Void") { if (f != "System.Void") il.Emit(OpCodes.Pop); return; }
      if (t == "System.Boolean" && f != "System.Boolean") { il.Emit(OpCodes.Ldc_I4_0); il.Emit(OpCodes.Cgt_Un); return; }
      if (t == "System.IntPtr") { il.Emit(OpCodes.Conv_I); return; }
      if (f == "System.IntPtr") { il.Emit(OpCodes.Conv_I4); return; }
    }

    // ---- method bodies ----------------------------------------------------------------------
    void RewriteBody(MethodDefinition md) {
      var body = md.Body;
      var ins = body.Instructions;
      for (int k = 0; k < ins.Count; k++) {
        var i = ins[k];
        if (i.OpCode == OpCodes.Ldstr && (string)i.Operand == "APP_CONFIG_FILE" && k + 1 < ins.Count && ins[k + 1].OpCode == OpCodes.Ldstr) {
          string cfg = (string)ins[k + 1].Operand;
          if (k + 2 < ins.Count && ins[k + 2].Operand is MethodReference && ((MethodReference)ins[k + 2].Operand).Name == "SetData") Stats.ConfigName = cfg;
        }
        if (i.OpCode != OpCodes.Call && i.OpCode != OpCodes.Callvirt && i.OpCode != OpCodes.Newobj) continue;
        var target = i.Operand as MethodReference;
        if (target == null || target.DeclaringType == null) continue;
        if (i.Previous != null && (i.Previous.OpCode == OpCodes.Constrained || i.Previous.OpCode == OpCodes.Tail)) continue;
        if (target is GenericInstanceMethod || target.DeclaringType is GenericInstanceType || target.CallingConvention == MethodCallingConvention.VarArg) continue;
        string type = target.DeclaringType.FullName;

        if (type == "System.Environment" && target.Name == "get_NewLine") {
          i.OpCode = OpCodes.Ldstr; i.Operand = "\r\n"; Stats.Add("newline"); continue;
        }
        if (type == "System.IntPtr" && target.Name == "op_Explicit" && pinvokeRedirected) {
          string from = target.Parameters[0].ParameterType.FullName, to = target.ReturnType.FullName;
          string stub = from == "System.IntPtr" && to == "System.Int32" ? "ToInt32" : from == "System.Int32" && to == "System.IntPtr" ? "FromInt32" : null;
          if (stub != null) { i.OpCode = OpCodes.Call; i.Operand = m.ImportReference(shim.GetType("UctoShim.Ptr").Methods.First(x => x.Name == stub)); Stats.Add("intptr"); }
          continue;
        }
        if (TryRedirect(i, target, type)) continue;
        if (type == "System.Windows.Forms.MessageBox" && target.Name == "Show" && !target.HasThis) { WrapMessageBox(i, target); continue; }
        if (!IsFramework(target.DeclaringType)) continue;
        if (type == "System.Xml.XmlWriterSettings" && i.OpCode == OpCodes.Newobj && target.Parameters.Count == 0) { Wrap(i, target, new bool[0], "crlf"); continue; }
        bool writer = i.OpCode == OpCodes.Newobj && WriterTypes.Contains(type);
        bool returnsWriter = target.ReturnType.FullName == "System.IO.StreamWriter";
        bool hasString = target.Parameters.Any(p => p.ParameterType.FullName == "System.String");
        if (!hasString && !writer) continue;
        if (target.HasThis && i.OpCode != OpCodes.Newobj && target.DeclaringType.IsValueType) continue;
        bool isPathType = type == "System.IO.Path";
        if ((NoPathTypes.Contains(type) || type.EndsWith("Exception", StringComparison.Ordinal)) && !isPathType) continue;
        var def = Resolve(target);
        if (def == null) continue;
        var fix = def.Parameters.Select(p => p.ParameterType.FullName == "System.String" &&
          (isPathType ? p.Name.StartsWith("path", StringComparison.Ordinal) : PathParams.Contains(p.Name))).ToArray();
        if (!fix.Any(x => x) && !writer && !returnsWriter) continue;
        Wrap(i, target, fix, isPathType ? "norm" : fix.Any(x => x) ? "path" : "crlf");
      }
    }

    bool IsFramework(TypeReference t) {
      var s = t.Scope as AssemblyNameReference;
      if (s == null) return false;
      return Folder.FrameworkTokens.Contains(Folder.Token(s.PublicKeyToken)) || s.Name == "mscorlib" || s.Name == "netstandard";
    }

    MethodDefinition Resolve(MethodReference r) {
      string key = r.FullName;
      MethodDefinition d;
      if (resolved.TryGetValue(key, out d)) return d;
      try { d = r.Resolve(); } catch (Exception) { d = null; }
      resolved[key] = d;
      return d;
    }

    bool TryRedirect(Instruction i, MethodReference target, string type) {
      string spec;
      string declType = type;
      if (type == "System.Windows.Forms.OpenFileDialog" || type == "System.Windows.Forms.SaveFileDialog") declType = "System.Windows.Forms.FileDialog";
      if (!Redirects.TryGetValue(declType + "::" + target.Name, out spec)) return false;
      if (i.OpCode == OpCodes.Newobj) return false;
      var parts = spec.Split(new[] { "::" }, StringSplitOptions.None);
      var st = shim.GetType(parts[0]);
      string name = parts[1];
      if (name.Contains("|")) { var alt = name.Split('|'); name = target.HasThis ? alt[1] : alt[0]; }
      var ps = new List<TypeReference>();
      if (target.HasThis) ps.Add(target.DeclaringType);
      ps.AddRange(target.Parameters.Select(p => p.ParameterType));
      var stub = st.Methods.FirstOrDefault(x => x.IsStatic && x.Name == name && x.Parameters.Count == ps.Count &&
        x.Parameters.Select((p, k) => SameOrBase(ps[k], p.ParameterType)).All(ok => ok));
      if (stub == null) return false;
      i.OpCode = OpCodes.Call;
      i.Operand = m.ImportReference(stub);
      Stats.Add(target.Name);
      return true;
    }

    static bool SameOrBase(TypeReference helper, TypeReference stub) {
      if (helper.FullName == stub.FullName) return true;
      return stub.FullName == "System.Windows.Forms.FileDialog" && (helper.FullName == "System.Windows.Forms.OpenFileDialog" || helper.FullName == "System.Windows.Forms.SaveFileDialog");
    }

    /// MessageBox.Show(...) -> if ((r = Dialogs.MessageLog(text, caption)) != -1) return r; else show.
    void WrapMessageBox(Instruction i, MethodReference target) {
      string key = "msgbox " + target.FullName;
      MethodDefinition w;
      if (!wrappers.TryGetValue(key, out w)) {
        var def = Resolve(target);
        if (def == null) return;
        w = new MethodDefinition("W" + wrappers.Count, MethodAttributes.Assembly | MethodAttributes.Static | MethodAttributes.HideBySig, target.ReturnType);
        foreach (var p in target.Parameters) w.Parameters.Add(new ParameterDefinition(p.Name, ParameterAttributes.None, p.ParameterType));
        var il = w.Body.GetILProcessor();
        int ti = def.Parameters.ToList().FindIndex(p => p.Name == "text"), ci = def.Parameters.ToList().FindIndex(p => p.Name == "caption");
        if (ti >= 0) il.Emit(OpCodes.Ldarg, w.Parameters[ti]); else il.Emit(OpCodes.Ldnull);
        if (ci >= 0) il.Emit(OpCodes.Ldarg, w.Parameters[ci]); else il.Emit(OpCodes.Ldnull);
        il.Emit(OpCodes.Call, m.ImportReference(shim.GetType("UctoShim.Forms.Dialogs").Methods.First(x => x.Name == "MessageLog")));
        var show = Instruction.Create(OpCodes.Pop);
        il.Emit(OpCodes.Dup);
        il.Emit(OpCodes.Ldc_I4_M1);
        il.Emit(OpCodes.Beq_S, show);
        il.Emit(OpCodes.Ret);
        il.Append(show);
        foreach (var p in w.Parameters) il.Emit(OpCodes.Ldarg, p);
        il.Emit(OpCodes.Call, target);
        il.Emit(OpCodes.Ret);
        holder.Methods.Add(w);
        wrappers[key] = w;
      }
      i.OpCode = OpCodes.Call; i.Operand = w;
      Stats.Add("msgbox");
    }

    /// Replaces the call by a generated static wrapper that fixes the flagged string
    /// arguments and makes new writers use CRLF.
    void Wrap(Instruction i, MethodReference target, bool[] fix, string kind) {
      bool ctor = i.OpCode == OpCodes.Newobj;
      bool inst = target.HasThis && !ctor;
      string key = i.OpCode.Code + " " + target.FullName;
      MethodDefinition w;
      if (!wrappers.TryGetValue(key, out w)) {
        var ret = ctor ? target.DeclaringType : target.ReturnType;
        w = new MethodDefinition("W" + wrappers.Count, MethodAttributes.Assembly | MethodAttributes.Static | MethodAttributes.HideBySig, ret);
        if (inst) w.Parameters.Add(new ParameterDefinition("self", ParameterAttributes.None, target.DeclaringType));
        foreach (var p in target.Parameters) w.Parameters.Add(new ParameterDefinition(p.Name, ParameterAttributes.None, p.ParameterType));
        var il = w.Body.GetILProcessor();
        var fixRef = m.ImportReference(shim.GetType("UctoShim.PathFix").Methods.First(x => x.Name == (kind == "norm" ? "Norm" : "Fix") && x.Parameters[0].ParameterType.FullName == "System.String"));
        int off = inst ? 1 : 0;
        if (inst) il.Emit(OpCodes.Ldarg, w.Parameters[0]);
        for (int k = 0; k < target.Parameters.Count; k++) {
          il.Emit(OpCodes.Ldarg, w.Parameters[k + off]);
          if (k < fix.Length && fix[k]) il.Emit(OpCodes.Call, fixRef);
        }
        il.Emit(ctor ? OpCodes.Newobj : i.OpCode == OpCodes.Callvirt ? OpCodes.Callvirt : OpCodes.Call, target);
        string rt = ret.FullName;
        if (WriterTypes.Contains(rt) || (ctor && WriterTypes.Contains(target.DeclaringType.FullName))) {
          il.Emit(OpCodes.Dup);
          il.Emit(OpCodes.Ldstr, "\r\n");
          il.Emit(OpCodes.Callvirt, m.ImportReference(typeof(TextWriter).GetProperty("NewLine").GetSetMethod()));
        } else if (rt == "System.Xml.XmlWriterSettings") {
          il.Emit(OpCodes.Dup);
          il.Emit(OpCodes.Ldstr, "\r\n");
          var set = new MethodReference("set_NewLineChars", m.TypeSystem.Void, target.DeclaringType) { HasThis = true };
          set.Parameters.Add(new ParameterDefinition(m.TypeSystem.String));
          il.Emit(OpCodes.Callvirt, m.ImportReference(set));
        }
        il.Emit(OpCodes.Ret);
        holder.Methods.Add(w);
        wrappers[key] = w;
      }
      i.OpCode = OpCodes.Call; i.Operand = w;
      Stats.Add(kind);
    }
  }
}
