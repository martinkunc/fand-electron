// Static check of the Rebex substitutes against the helpers and the original assemblies.
//  1. Every managed assembly in the Účto folder that references Rebex.Common/Networking/Http
//     is scanned; every Rebex type and member it references must exist in the substitute of
//     the referenced version with the same signature (the helpers would otherwise fail with
//     TypeLoadException/MissingMethodException at run time).
//  2. Every public/protected member of the substitutes must exist in the original of the same
//     version with the same signature, staticness, visibility and virtualness; base types,
//     type attributes, enum values and [Flags] must match. So nothing is invented.
// Usage: mono ApiCheck.exe <Účto app dir> <substitutes bin dir>   (exit code 1 on errors)
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Mono.Cecil;

static class ApiCheck {
  static readonly string[] Substituted = { "Rebex.Common", "Rebex.Networking", "Rebex.Http" };
  static int errors, warnings;
  static void Err(string m) { errors++; Console.WriteLine("  ERROR " + m); }
  static void Warn(string m) { warnings++; Console.WriteLine("  warn  " + m); }

  // Documented deviations (see Http.cs): the original HttpRequest.Proxy is a Rebex.Net.Proxy
  // hiding WebRequest.Proxy; the substitute overrides WebRequest.Proxy instead.
  static readonly HashSet<string> Allowed = new HashSet<string> {
    "Rebex.Net.HttpRequest::get_Proxy", "Rebex.Net.HttpRequest::set_Proxy",
  };

  static readonly Dictionary<string, ModuleDefinition> Cache = new Dictionary<string, ModuleDefinition>();
  static ModuleDefinition Load(string path) {
    ModuleDefinition m;
    if (!Cache.TryGetValue(path, out m)) Cache[path] = m = ModuleDefinition.ReadModule(path, new ReaderParameters { ReadingMode = ReadingMode.Deferred });
    return m;
  }

  static int Main(string[] args) {
    if (args.Length < 2) { Console.Error.WriteLine("usage: ApiCheck <app dir> <bin dir>"); return 2; }
    string app = args[0], bin = args[1];
    var originals = new Dictionary<string, string>(); // version -> folder with original Rebex dlls

    Console.WriteLine("== 1. helper references -> substitutes");
    foreach (var file in Directory.GetFiles(app, "*.*", SearchOption.AllDirectories)
               .Where(f => f.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)).OrderBy(f => f)) {
      ModuleDefinition mod;
      try { mod = ModuleDefinition.ReadModule(file); } catch (Exception) { continue; }
      if (mod.Assembly != null && Substituted.Contains(mod.Assembly.Name.Name)) {
        originals[mod.Assembly.Name.Version.ToString()] = Path.GetDirectoryName(file);
        continue;
      }
      var refs = mod.AssemblyReferences.Where(r => r.Name.StartsWith("Rebex.")).ToList();
      if (refs.Count == 0) continue;
      string rel = file.Substring(app.Length).TrimStart('/');
      Console.WriteLine(rel + "  [" + string.Join(", ", refs.Select(r => r.Name + " " + r.Version).ToArray()) + "]");
      string dir = Path.GetDirectoryName(file);
      foreach (var r in refs.Where(r => !Substituted.Contains(r.Name))) {
        var p = Path.Combine(dir, r.Name + ".dll");
        if (!File.Exists(p)) { Err(r.Name + " not found next to " + rel); continue; }
        var km = Load(p);
        var bad = km.AssemblyReferences.Where(x => x.Name != "mscorlib").Select(x => x.Name).ToList();
        Console.WriteLine("  kept original " + r.Name + " " + r.Version + " (references: " + string.Join(", ", km.AssemblyReferences.Select(x => x.Name).ToArray()) + ")");
        if (bad.Any(b => Substituted.Contains(b))) Err(r.Name + " references a substituted assembly");
      }
      foreach (var tr in mod.GetTypeReferences()) {
        var scope = tr.Scope as AssemblyNameReference;
        if (scope == null || !Substituted.Contains(scope.Name)) continue;
        if (FindSubst(bin, scope, tr.FullName) == null) Err("type " + tr.FullName + " missing in substitute " + scope.Name + " " + scope.Version);
      }
      foreach (var mr in mod.GetMemberReferences()) {
        var dt = mr.DeclaringType;
        var scope = dt.Scope as AssemblyNameReference;
        if (scope == null || !Substituted.Contains(scope.Name)) continue;
        var td = FindSubst(bin, scope, dt.FullName);
        if (td == null) continue; // reported above
        CheckSignatureTypes(bin, mr);
        bool ok = mr is MethodReference ? td.Methods.Any(m => SameMethod(m, (MethodReference)mr) && Visible(m))
                : mr is FieldReference ? td.Fields.Any(f => f.Name == mr.Name && TypeName(f.FieldType) == TypeName(((FieldReference)mr).FieldType) && (f.IsPublic || f.IsFamily))
                : false;
        Console.WriteLine("  " + (ok ? "ok      " : "MISSING ") + Describe(mr));
        if (!ok) Err("member " + Describe(mr) + " missing in substitute " + scope.Name + " " + scope.Version);
      }
    }

    Console.WriteLine();
    Console.WriteLine("== 2. substitutes -> originals (no invented API, same enum values)");
    foreach (var verDir in Directory.GetDirectories(bin).Where(d => char.IsDigit(Path.GetFileName(d)[0])).OrderBy(d => d)) {
      string ver = Path.GetFileName(verDir);
      string orig;
      if (!originals.TryGetValue(ver, out orig)) { Warn("no original Rebex " + ver + " found in the app folder"); continue; }
      foreach (var name in Substituted) {
        var sm = Load(Path.Combine(verDir, name + ".dll"));
        var om = Load(Path.Combine(orig, name + ".dll"));
        Console.WriteLine(ver + " " + name + ": compare with " + Path.Combine(orig, name + ".dll").Substring(app.Length).TrimStart('/'));
        if (sm.Assembly.Name.Version.ToString() != ver) Err(name + " version " + sm.Assembly.Name.Version);
        if (!sm.Assembly.Name.PublicKeyToken.SequenceEqual(om.Assembly.Name.PublicKeyToken)) Err(name + " public key token differs");
        foreach (var st in sm.GetTypes().Where(t => t.IsPublic || t.IsNestedPublic)) CompareType(st, om);
      }
    }
    Console.WriteLine();
    Console.WriteLine(errors == 0 ? "API check passed (" + warnings + " warnings)." : "API check FAILED: " + errors + " errors, " + warnings + " warnings.");
    return errors == 0 ? 0 : 1;
  }

  static TypeDefinition FindSubst(string bin, AssemblyNameReference scope, string fullName) {
    var p = Path.Combine(bin, scope.Version.ToString(), scope.Name + ".dll");
    if (!File.Exists(p)) { Err("no substitute " + p); return null; }
    var t = Load(p).GetType(fullName.Replace('/', '/'));
    if (t == null) t = Load(p).GetTypes().FirstOrDefault(x => x.FullName == fullName);
    return t != null && (t.IsPublic || t.IsNestedPublic) ? t : null;
  }

  static void CheckSignatureTypes(string bin, MemberReference mr) {
    var types = new List<TypeReference>();
    var m = mr as MethodReference;
    if (m != null) { types.Add(m.ReturnType); types.AddRange(m.Parameters.Select(p => p.ParameterType)); }
    var f = mr as FieldReference;
    if (f != null) types.Add(f.FieldType);
    foreach (var t in types.SelectMany(Flatten)) {
      var s = t.Scope as AssemblyNameReference;
      if (s != null && Substituted.Contains(s.Name) && FindSubst(bin, s, t.FullName) == null)
        Err("signature type " + t.FullName + " (in " + Describe(mr) + ") missing in " + s.Name + " " + s.Version);
    }
  }

  static IEnumerable<TypeReference> Flatten(TypeReference t) {
    var ts = t as TypeSpecification;
    if (ts != null) { foreach (var x in Flatten(ts.ElementType)) yield return x; }
    var g = t as GenericInstanceType;
    if (g != null) foreach (var a in g.GenericArguments) foreach (var x in Flatten(a)) yield return x;
    if (ts == null) yield return t;
  }

  static bool Visible(MethodDefinition m) { return m.IsPublic || m.IsFamily || m.IsFamilyOrAssembly; }
  static string TypeName(TypeReference t) { return t.FullName; }
  static bool SameMethod(MethodDefinition a, MethodReference b) {
    return a.Name == b.Name && a.HasThis == b.HasThis && a.GenericParameters.Count == b.GenericParameters.Count
      && TypeName(a.ReturnType) == TypeName(b.ReturnType) && a.Parameters.Count == b.Parameters.Count
      && a.Parameters.Select(p => TypeName(p.ParameterType)).SequenceEqual(b.Parameters.Select(p => TypeName(p.ParameterType)));
  }
  static string Describe(MemberReference m) {
    var mr = m as MethodReference;
    if (mr != null) return mr.DeclaringType.FullName + "::" + mr.Name + "(" + string.Join(", ", mr.Parameters.Select(p => p.ParameterType.Name).ToArray()) + ") : " + mr.ReturnType.Name;
    return m.DeclaringType.FullName + "::" + m.Name;
  }

  static void CompareType(TypeDefinition st, ModuleDefinition om) {
    var ot = om.GetTypes().FirstOrDefault(t => t.FullName == st.FullName);
    if (ot == null || !(ot.IsPublic || ot.IsNestedPublic)) { Err("type " + st.FullName + " does not exist (publicly) in the original"); return; }
    const TypeAttributes mask = TypeAttributes.VisibilityMask | TypeAttributes.Abstract | TypeAttributes.Sealed | TypeAttributes.ClassSemanticMask;
    if ((st.Attributes & mask) != (ot.Attributes & mask)) Err("type " + st.FullName + " attributes " + (st.Attributes & mask) + " vs original " + (ot.Attributes & mask));
    string sb = st.BaseType == null ? "-" : st.BaseType.FullName, ob = ot.BaseType == null ? "-" : ot.BaseType.FullName;
    if (sb != ob) Err("type " + st.FullName + " base " + sb + " vs original " + ob);
    foreach (var oi in ot.Interfaces.Select(i => i.InterfaceType)) {
      TypeDefinition r = null;
      try { r = oi.Resolve(); } catch (Exception) {}
      if (r != null ? !r.IsPublic : !(oi.Namespace.StartsWith("System") || oi.Namespace.StartsWith("Rebex"))) continue; // obfuscated internal interfaces
      if (!st.Interfaces.Any(i => i.InterfaceType.FullName == oi.FullName) && !InheritsInterface(st, oi.FullName))
        Warn("type " + st.FullName + " does not implement " + oi.FullName);
    }
    bool sf = st.CustomAttributes.Any(a => a.AttributeType.FullName == "System.FlagsAttribute");
    bool of = ot.CustomAttributes.Any(a => a.AttributeType.FullName == "System.FlagsAttribute");
    if (sf != of) Err("type " + st.FullName + " [Flags] " + sf + " vs original " + of);
    foreach (var f in st.Fields.Where(f => f.IsPublic || f.IsFamily)) {
      var o = ot.Fields.FirstOrDefault(x => x.Name == f.Name && (x.IsPublic || x.IsFamily));
      if (o == null) { Err("field " + st.FullName + "::" + f.Name + " not in original"); continue; }
      if (TypeName(o.FieldType) != TypeName(f.FieldType) || o.IsStatic != f.IsStatic || o.IsInitOnly != f.IsInitOnly || o.IsPublic != f.IsPublic)
        Err("field " + st.FullName + "::" + f.Name + " differs from original");
      if (o.HasConstant != f.HasConstant || (o.HasConstant && !object.Equals(o.Constant, f.Constant)))
        Err("constant " + st.FullName + "::" + f.Name + " = " + f.Constant + " vs original " + o.Constant);
    }
    if (st.IsEnum) foreach (var o in ot.Fields.Where(x => x.HasConstant))
      if (!st.Fields.Any(x => x.Name == o.Name)) Warn("enum " + st.FullName + " lacks " + o.Name + " = " + o.Constant);
    foreach (var m in st.Methods.Where(Visible)) {
      string key = st.FullName + "::" + m.Name;
      var o = ot.Methods.FirstOrDefault(x => Visible(x) && SameMethod(x, m));
      if (o == null) {
        if (Allowed.Contains(key)) { Console.WriteLine("  allowed deviation: " + Describe(m)); continue; }
        if (m.IsVirtual && !m.IsNewSlot && OverridesExternal(st, m)) continue; // override of a framework virtual (WebRequest, Object...)
        Err("method " + Describe(m) + " not in original");
        continue;
      }
      if (o.IsStatic != m.IsStatic) Err("method " + Describe(m) + " static differs");
      if ((o.Attributes & MethodAttributes.MemberAccessMask) != (m.Attributes & MethodAttributes.MemberAccessMask)) Err("method " + Describe(m) + " visibility " + (m.Attributes & MethodAttributes.MemberAccessMask) + " vs original " + (o.Attributes & MethodAttributes.MemberAccessMask));
      bool ov = o.IsVirtual && !o.IsFinal, sv = m.IsVirtual && !m.IsFinal;
      if (ov != sv || o.IsAbstract != m.IsAbstract) Err("method " + Describe(m) + " virtual/abstract differs (substitute virtual=" + sv + " abstract=" + m.IsAbstract + ", original virtual=" + ov + " abstract=" + o.IsAbstract + ")");
    }
  }

  static bool InheritsInterface(TypeDefinition t, string iface) {
    for (var b = t.BaseType; b != null;) {
      TypeDefinition d; try { d = b.Resolve(); } catch (Exception) { return false; }
      if (d == null) return false;
      if (d.Interfaces.Any(i => i.InterfaceType.FullName == iface || i.InterfaceType.FullName.StartsWith(iface.Split('<')[0]))) return true;
      b = d.BaseType;
    }
    return false;
  }

  static bool OverridesExternal(TypeDefinition t, MethodDefinition m) {
    for (var b = t.BaseType; b != null;) {
      TypeDefinition d; try { d = b.Resolve(); } catch (Exception) { return false; }
      if (d == null) return false;
      if (!d.Module.Assembly.Name.Name.StartsWith("Rebex.") && d.Methods.Any(x => x.IsVirtual && x.Name == m.Name && x.Parameters.Count == m.Parameters.Count)) return true;
      b = d.BaseType;
    }
    return false;
  }
}
