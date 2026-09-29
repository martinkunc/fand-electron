// Rebex.Security.Certificates substitute (part of Rebex.Common): certificates, chains and
// stores implemented over System.Security.Cryptography.X509Certificates and Mono's X509Store.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Rebex.Security.Cryptography;

namespace Rebex.Security.Certificates {
  public enum CertificateStoreName { None = 0, AddressBook = 1, AuthRoot = 2, CertificateAuthority = 3, Disallowed = 4, My = 5, Root = 6, TrustedPeople = 7, TrustedPublisher = 8 }

  public enum CertificateStoreLocation {
    None = 0, CurrentUser = 65536, LocalMachine = 131072, CurrentService = 262144, Services = 327680, Users = 393216,
    CurrentUserGroupPolicy = 458752, LocalMachineGroupPolicy = 524288, LocalMachineEnterprise = 589824
  }

  [Flags] public enum KeySetOptions { Exportable = 1, UserProtected = 2, MachineKeySet = 32, UserKeySet = 4096, PersistKeySet = 32768, AlwaysCng = 512, PreferCng = 256 }

  [Flags] public enum CertificateFindOptions : long { None = 0, HasPrivateKey = 1, IsTimeValid = 2, ClientAuthentication = 4, ServerAuthentication = 8, IncludeSubordinateAuthorities = 16 }

  public enum CertificateFormat { Der = 1, Base64Der = 2, Pfx = 3 }

  [Serializable]
  public class CertificateException : CryptographicException {
    public CertificateException(string message) : base(message) {}
    public CertificateException(string message, Exception inner) : base(message, inner) {}
    public CertificateException(SerializationInfo info, StreamingContext context) : base(info, context) {}
  }

  [Serializable]
  public class DistinguishedName {
    readonly byte[] raw;
    public DistinguishedName(byte[] data) { if (data == null) throw new ArgumentNullException("data"); raw = (byte[])data.Clone(); }
    public DistinguishedName(string distinguishedName) { raw = FromString(distinguishedName); }
    internal X500DistinguishedName X500 { get { return new X500DistinguishedName(raw); } }

    public string GetCommonName() { return Attr("2.5.4.3").FirstOrDefault(); }
    public string[] GetMailAddresses() { return Attr("1.2.840.113549.1.9.1").ToArray(); }
    public byte[] ToArray() { return (byte[])raw.Clone(); }
    public override string ToString() { return X500.Name; }
    public override bool Equals(object obj) {
      var o = obj as DistinguishedName;
      return o != null && (o.raw.SequenceEqual(raw) || Norm(o.ToString()) == Norm(ToString()));
    }
    public override int GetHashCode() { return Norm(ToString()).GetHashCode(); }
    public static byte[] FromString(string distinguishedName) {
      if (distinguishedName == null) throw new ArgumentNullException("distinguishedName");
      return new X500DistinguishedName(distinguishedName).RawData;
    }
    public static string ToString(byte[] distinguishedName) { return new DistinguishedName(distinguishedName).ToString(); }

    internal static string Norm(string dn) {
      if (dn == null) return "";
      var parts = dn.Split(new[] { ',', ';', '+' }, StringSplitOptions.RemoveEmptyEntries).Select(p => p.Trim().ToUpperInvariant().Replace(" = ", "=")).OrderBy(p => p, StringComparer.Ordinal);
      return string.Join(",", parts.ToArray());
    }

    // Walks Name ::= SEQUENCE OF SET OF SEQUENCE { type OID, value ANY }.
    IEnumerable<string> Attr(string oid) {
      var result = new List<string>();
      try {
        var name = Der.Read(raw, 0);
        foreach (var rdn in Der.Children(raw, name))
          foreach (var atv in Der.Children(raw, rdn)) {
            var kids = Der.Children(raw, atv).ToList();
            if (kids.Count == 2 && kids[0].Tag == 6 && ObjectIdentifier.Decode(raw, kids[0].Start, kids[0].Length) == oid)
              result.Add(kids[1].Tag == 0x1E ? Encoding.BigEndianUnicode.GetString(raw, kids[1].Start, kids[1].Length) : Encoding.UTF8.GetString(raw, kids[1].Start, kids[1].Length));
          }
      } catch (Exception) {}
      return result;
    }
  }

  [Serializable]
  public sealed class Certificate : IDisposable, IDeserializationCallback {
    [NonSerialized] X509Certificate2 x509;

    public Certificate(byte[] data) { if (data == null) throw new ArgumentNullException("data"); x509 = new X509Certificate2(data); }
    public Certificate(X509Certificate certificate) {
      if (certificate == null) throw new ArgumentNullException("certificate");
      x509 = certificate as X509Certificate2 ?? new X509Certificate2(certificate);
    }
    internal X509Certificate2 X509 { get { return x509; } }

    public static Certificate LoadDer(string path) { return new Certificate(File.ReadAllBytes(Rebex.Util.FixPath(path))); }
    public static Certificate LoadDer(Stream input) { return new Certificate(ReadAll(input)); }
    public static Certificate LoadPfx(string path, string password) { return LoadPfx(path, password, KeySetOptions.Exportable); }
    public static Certificate LoadPfx(byte[] data, string password) { return LoadPfx(data, password, KeySetOptions.Exportable); }
    public static Certificate LoadPfx(string path, string password, KeySetOptions options) {
      if (path == null) throw new ArgumentNullException("path");
      return LoadPfx(File.ReadAllBytes(Rebex.Util.FixPath(path)), password, options);
    }
    public static Certificate LoadPfx(byte[] data, string password, KeySetOptions options) {
      var all = ImportPfx(data, password, options);
      return new Certificate(all.FirstOrDefault(c => c.HasPrivateKey) ?? all[0]);
    }

    internal static List<X509Certificate2> ImportPfx(byte[] data, string password, KeySetOptions options) {
      if (data == null) throw new ArgumentNullException("data");
      var col = new X509Certificate2Collection();
      try {
        // PersistKeySet/MachineKeySet would write key containers under Mono; keep keys in memory.
        col.Import(data, password, X509KeyStorageFlags.Exportable);
      } catch (Exception ex) {
        throw new CertificateException("Unable to load the PFX/P12 file: " + ex.Message, ex);
      }
      if (col.Count == 0) throw new CertificateException("The PFX/P12 file contains no certificates.");
      return col.Cast<X509Certificate2>().ToList();
    }

    public void Save(string path) { Save(path, CertificateFormat.Der); }
    public void Save(Stream output) { Save(output, CertificateFormat.Der); }
    public void Save(string path, CertificateFormat format) { using (var fs = File.Create(Rebex.Util.FixPath(path))) Save(fs, format); }
    public void Save(Stream output, CertificateFormat format) {
      byte[] data = x509.RawData;
      if (format == CertificateFormat.Base64Der) {
        var b64 = Convert.ToBase64String(data, Base64FormattingOptions.InsertLineBreaks);
        data = Encoding.ASCII.GetBytes("-----BEGIN CERTIFICATE-----\r\n" + b64 + "\r\n-----END CERTIFICATE-----\r\n");
      } else if (format == CertificateFormat.Pfx) {
        data = x509.Export(X509ContentType.Pfx);
      }
      output.Write(data, 0, data.Length);
    }

    public static implicit operator Certificate(X509Certificate certificate) { return certificate == null ? null : new Certificate(certificate); }
    public static implicit operator X509Certificate2(Certificate certificate) { return certificate == null ? null : certificate.x509; }

    public DistinguishedName GetIssuer() { return new DistinguishedName(x509.IssuerName.RawData); }
    public string GetIssuerName() { return x509.Issuer; }
    public DistinguishedName GetSubject() { return new DistinguishedName(x509.SubjectName.RawData); }
    public string GetSubjectName() { return x509.Subject; }
    public byte[] GetPublicKey() { return x509.GetPublicKey(); }
    public byte[] GetKeyAlgorithmParameters() { return x509.GetKeyAlgorithmParameters(); }
    public byte[] GetSubjectKeyIdentifier() {
      foreach (var e in x509.Extensions) {
        var ski = e as X509SubjectKeyIdentifierExtension;
        if (ski != null) return Hex(ski.SubjectKeyIdentifier);
        if (e.Oid.Value == "2.5.29.14") return Hex(new X509SubjectKeyIdentifierExtension(e, e.Critical).SubjectKeyIdentifier);
      }
      return null;
    }
    public string GetCommonName() { return GetSubject().GetCommonName() ?? x509.GetNameInfo(X509NameType.SimpleName, false); }
    public string[] GetMailAddresses() { return GetSubject().GetMailAddresses(); }
    public byte[] GetSerialNumber() { return x509.GetSerialNumber(); }
    public DateTime GetExpirationDate() { return x509.NotAfter; }
    public DateTime GetEffectiveDate() { return x509.NotBefore; }
    public byte[] GetCertHash() { return x509.GetCertHash(); }
    public byte[] GetRawCertData() { return x509.GetRawCertData(); }
    public string Thumbprint { get { return x509.Thumbprint; } }
    public bool IsTimeValid() { var now = DateTime.Now; return now >= x509.NotBefore && now <= x509.NotAfter; }
    public string FriendlyName { get { return x509.FriendlyName; } set { x509.FriendlyName = value; } }
    public object Tag { get; set; }
    public bool HasPrivateKey() { return x509.HasPrivateKey; }
    public int GetKeySize() { var k = x509.PublicKey.Key; return k == null ? 0 : k.KeySize; }
    public byte[] Encrypt(byte[] data) {
      var rsa = x509.PublicKey.Key as RSA;
      if (rsa == null) throw new CertificateException("Only RSA certificates are supported.");
      return ((RSACryptoServiceProvider)rsa).Encrypt(data, false);
    }
    public byte[] Decrypt(byte[] data, bool silent) {
      if (!x509.HasPrivateKey) throw new CertificateException("Certificate has no private key.");
      var rsa = x509.PrivateKey as RSACryptoServiceProvider;
      if (rsa == null) throw new CertificateException("Only RSA certificates are supported.");
      return rsa.Decrypt(data, false);
    }
    public void Dispose() {}
    void IDeserializationCallback.OnDeserialization(object sender) {}
    public override string ToString() { return x509.Subject; }

    internal static byte[] Hex(string hex) {
      if (hex == null) return null;
      hex = hex.Replace(" ", "");
      var b = new byte[hex.Length / 2];
      for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(hex.Substring(2 * i, 2), 16);
      return b;
    }
    internal static byte[] ReadAll(Stream s) { var ms = new MemoryStream(); s.CopyTo(ms); return ms.ToArray(); }
  }

  public class CertificateCollection : CryptographicCollection<Certificate> {
    public CertificateCollection() {}
  }

  [Serializable]
  public sealed class CertificateChain : IEnumerable<Certificate>
#if REBEX6
    , IDisposable
#endif
  {
    readonly List<Certificate> list = new List<Certificate>();

    public CertificateChain() {}
    public CertificateChain(params Certificate[] certificates) { if (certificates != null) list.AddRange(certificates.Where(c => c != null)); }

    public int Count { get { return list.Count; } }
    public Certificate this[int index] { get { return list[index]; } set { list[index] = value; } }
    public IEnumerator<Certificate> GetEnumerator() { return list.GetEnumerator(); }
    IEnumerator IEnumerable.GetEnumerator() { return list.GetEnumerator(); }
    public Certificate RootCertificate { get { return list.Count == 0 ? null : list[list.Count - 1]; } }
    public Certificate LeafCertificate { get { return list.Count == 0 ? null : list[0]; } }
    public int Add(Certificate certificate) { if (certificate == null) throw new ArgumentNullException("certificate"); list.Add(certificate); return list.Count - 1; }
#if REBEX6
    public void Dispose() {}
#endif

    public static CertificateChain LoadPfx(string path, string password) { return LoadPfx(path, password, KeySetOptions.Exportable); }
    public static CertificateChain LoadPfx(byte[] data, string password) { return LoadPfx(data, password, KeySetOptions.Exportable); }
    public static CertificateChain LoadPfx(string path, string password, KeySetOptions options) {
      if (path == null) throw new ArgumentNullException("path");
      return LoadPfx(File.ReadAllBytes(Rebex.Util.FixPath(path)), password, options);
    }
    /// Leaf (the certificate with the private key) first, then its issuers up to the root.
    public static CertificateChain LoadPfx(byte[] data, string password, KeySetOptions options) {
      return Ordered(Certificate.ImportPfx(data, password, options));
    }
    public static CertificateChain LoadP7b(string path) { return LoadP7b(File.ReadAllBytes(Rebex.Util.FixPath(path))); }
    public static CertificateChain LoadP7b(Stream input) { return LoadP7b(Certificate.ReadAll(input)); }
    static CertificateChain LoadP7b(byte[] data) {
      var cms = new System.Security.Cryptography.Pkcs.SignedCms();
      cms.Decode(data);
      return Ordered(cms.Certificates.Cast<X509Certificate2>().ToList());
    }
    public static CertificateChain LoadDer(string path) { return new CertificateChain(Certificate.LoadDer(path)); }

    public static CertificateChain BuildFrom(Certificate certificate) { return BuildFrom(certificate, (CertificateStore)null); }
    public static CertificateChain BuildFrom(Certificate certificate, CertificateStore store) {
      if (certificate == null) throw new ArgumentNullException("certificate");
      var chain = new X509Chain();
      chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
      chain.ChainPolicy.VerificationFlags = X509VerificationFlags.AllFlags;
      if (store != null) foreach (var c in store) chain.ChainPolicy.ExtraStore.Add(c.X509);
      var result = new CertificateChain(certificate);
      try {
        chain.Build(certificate.X509);
        foreach (var el in chain.ChainElements.Cast<X509ChainElement>().Skip(1)) result.Add(new Certificate(el.Certificate));
      } catch (Exception) {}
      return result;
    }

    static CertificateChain Ordered(List<X509Certificate2> certs) {
      var chain = new CertificateChain();
      if (certs.Count == 0) return chain;
      var rest = new List<X509Certificate2>(certs);
      var cur = rest.FirstOrDefault(c => c.HasPrivateKey)
        ?? rest.FirstOrDefault(c => !rest.Any(o => o != c && DistinguishedName.Norm(o.Issuer) == DistinguishedName.Norm(c.Subject) && o.Subject != o.Issuer))
        ?? rest[0];
      while (cur != null) {
        rest.Remove(cur);
        chain.Add(new Certificate(cur));
        if (DistinguishedName.Norm(cur.Issuer) == DistinguishedName.Norm(cur.Subject)) break;
        var issuer = DistinguishedName.Norm(cur.Issuer);
        cur = rest.FirstOrDefault(c => DistinguishedName.Norm(c.Subject) == issuer);
      }
      foreach (var c in rest) chain.Add(new Certificate(c));
      return chain;
    }
  }

  /// Windows certificate store equivalent over Mono's X509Store. Certificates added in this
  /// process are also remembered in memory (with their private keys), so a later
  /// EnvelopedData.Decrypt finds them even if Mono does not persist the key.
  public sealed class CertificateStore : IEnumerable<Certificate>, IDisposable {
    static readonly List<KeyValuePair<string, X509Certificate2>> Added = new List<KeyValuePair<string, X509Certificate2>>();
    readonly string name;
    readonly StoreLocation location;
    readonly List<Certificate> memory;

    public CertificateStore(string name, CertificateStoreLocation location) {
      if (name == null) throw new ArgumentNullException("name");
      this.name = name;
      this.location = location == CertificateStoreLocation.LocalMachine ? StoreLocation.LocalMachine : StoreLocation.CurrentUser;
    }
    public CertificateStore(CertificateStoreName name, CertificateStoreLocation location) : this(StoreNameString(name), location) {}
    public CertificateStore(string name) : this(name, CertificateStoreLocation.CurrentUser) {}
    public CertificateStore(CertificateStoreName name) : this(name, CertificateStoreLocation.CurrentUser) {}
    public CertificateStore(ICollection certificates) {
      if (certificates == null) throw new ArgumentNullException("certificates");
      name = null;
      memory = new List<Certificate>();
      foreach (var o in certificates) {
        var c = o as Certificate ?? (o is X509Certificate ? new Certificate((X509Certificate)o) : null);
        if (c != null) memory.Add(c);
      }
    }

    public static bool Exists(string name, CertificateStoreLocation location) { return name != null; }
    public static bool Exists(CertificateStoreName name, CertificateStoreLocation location) { return name != CertificateStoreName.None; }
    public static bool Exists(string name) { return Exists(name, CertificateStoreLocation.CurrentUser); }
    public static bool Exists(CertificateStoreName name) { return Exists(name, CertificateStoreLocation.CurrentUser); }

    internal static string StoreNameString(CertificateStoreName name) {
      switch (name) {
        case CertificateStoreName.CertificateAuthority: return "CA";
        case CertificateStoreName.None: throw new ArgumentException("Invalid store name.", "name");
        default: return name.ToString();
      }
    }
    string Key { get { return location + "/" + name.ToUpperInvariant(); } }

    public void AddCertificate(Certificate certificate) { Add(certificate); }
    public void Add(Certificate certificate) {
      if (certificate == null) throw new ArgumentNullException("certificate");
      if (memory != null) { memory.Add(certificate); return; }
      lock (Added) {
        Added.RemoveAll(p => p.Key == Key && p.Value.Thumbprint == certificate.Thumbprint);
        Added.Add(new KeyValuePair<string, X509Certificate2>(Key, certificate.X509));
      }
      try {
        using (var st = new X509Store(name, location)) { st.Open(OpenFlags.ReadWrite); st.Add(certificate.X509); }
      } catch (Exception) {
        // Best effort: the in-process copy above is what this helper run needs.
      }
    }
    public void Remove(Certificate certificate) {
      if (certificate == null) throw new ArgumentNullException("certificate");
      if (memory != null) { memory.RemoveAll(c => c.Thumbprint == certificate.Thumbprint); return; }
      lock (Added) Added.RemoveAll(p => p.Key == Key && p.Value.Thumbprint == certificate.Thumbprint);
      try { using (var st = new X509Store(name, location)) { st.Open(OpenFlags.ReadWrite); st.Remove(certificate.X509); } } catch (Exception) {}
    }

    public Certificate[] FindCertificates(CertificateFindOptions options) {
      return All().Where(c => ((options & CertificateFindOptions.HasPrivateKey) == 0 || c.HasPrivateKey())
                          && ((options & CertificateFindOptions.IsTimeValid) == 0 || c.IsTimeValid())).ToArray();
    }

    IEnumerator<Certificate> IEnumerable<Certificate>.GetEnumerator() { return All().GetEnumerator(); }
    IEnumerator IEnumerable.GetEnumerator() { return All().GetEnumerator(); }

    List<Certificate> All() {
      if (memory != null) return new List<Certificate>(memory);
      var result = new List<Certificate>();
      lock (Added) foreach (var p in Added) if (p.Key == Key) result.Add(new Certificate(p.Value));
      try {
        using (var st = new X509Store(name, location)) {
          st.Open(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly);
          foreach (var c in st.Certificates) if (!result.Any(r => r.Thumbprint == c.Thumbprint)) result.Add(new Certificate(c));
        }
      } catch (Exception) {}
      return result;
    }

    public void Dispose() {}
  }
}
