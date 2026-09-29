// Rebex.Security.Cryptography(.Pkcs) substitute (part of Rebex.Common): CMS EnvelopedData and
// SignedData implemented over Mono's System.Security.Cryptography.Pkcs (EnvelopedCms/SignedCms),
// plus the small infrastructure types they need (ObjectIdentifier, collections, finders).
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Rebex.Security.Certificates;
using Sys = System.Security.Cryptography.Pkcs;

namespace Rebex.Security.Cryptography {
  public sealed class ObjectIdentifier {
    readonly string value;
    public ObjectIdentifier(ObjectIdentifier oid) { if (oid == null) throw new ArgumentNullException("oid"); value = oid.value; }
    public ObjectIdentifier(string oid) {
      if (oid == null) throw new ArgumentNullException("oid");
      if (!oid.Split('.').All(p => p.Length > 0 && p.All(char.IsDigit)) || oid.Split('.').Length < 2) throw new ArgumentException("Invalid object identifier.", "oid");
      value = oid;
    }
    public static implicit operator ObjectIdentifier(string oid) { return oid == null ? null : new ObjectIdentifier(oid); }
    public string Value { get { return value; } }
    public override string ToString() { return value; }
    public override bool Equals(object obj) { var o = obj as ObjectIdentifier; return o != null && o.value == value; }
    public override int GetHashCode() { return value.GetHashCode(); }

    /// DER encoding (tag 06, length, content).
    public byte[] ToArray() {
      var parts = value.Split('.').Select(ulong.Parse).ToArray();
      var body = new List<byte>();
      Base128(body, parts[0] * 40 + parts[1]);
      for (int i = 2; i < parts.Length; i++) Base128(body, parts[i]);
      var r = new List<byte> { 6 };
      r.AddRange(Der.EncodeLength(body.Count));
      r.AddRange(body);
      return r.ToArray();
    }
    public static ObjectIdentifier Parse(byte[] data) {
      if (data == null) throw new ArgumentNullException("data");
      if (data.Length > 0 && data[0] == 6) { var n = Der.Read(data, 0); return new ObjectIdentifier(Decode(data, n.Start, n.Length)); }
      return new ObjectIdentifier(Decode(data, 0, data.Length));
    }
    static void Base128(List<byte> o, ulong v) {
      var tmp = new Stack<byte>();
      tmp.Push((byte)(v & 0x7F));
      while ((v >>= 7) != 0) tmp.Push((byte)(0x80 | (v & 0x7F)));
      o.AddRange(tmp);
    }
    internal static string Decode(byte[] d, int start, int len) {
      var sb = new StringBuilder(); ulong v = 0; bool first = true;
      for (int i = start; i < start + len; i++) {
        v = (v << 7) | (ulong)(d[i] & 0x7F);
        if ((d[i] & 0x80) != 0) continue;
        if (first) { ulong a = v < 80 ? v / 40 : 2; sb.Append(a).Append('.').Append(v - a * 40); first = false; }
        else sb.Append('.').Append(v);
        v = 0;
      }
      return sb.ToString();
    }
  }

  /// Minimal DER reader.
  internal struct Der {
    public int Tag, Start, Length, End;
    public static Der Read(byte[] d, int pos) {
      var n = new Der { Tag = d[pos] };
      int p = pos + 1; int l = d[p++];
      if (l == 0x80) throw new FormatException("Indefinite length not supported here.");
      if ((l & 0x80) != 0) { int c = l & 0x7F; l = 0; while (c-- > 0) l = (l << 8) | d[p++]; }
      n.Start = p; n.Length = l; n.End = p + l;
      if (n.End > d.Length || l < 0) throw new FormatException("Truncated DER.");
      return n;
    }
    public static IEnumerable<Der> Children(byte[] d, Der parent) {
      for (int p = parent.Start; p < parent.End;) { var c = Read(d, p); yield return c; p = c.End; }
    }
    public static byte[] EncodeLength(int len) {
      if (len < 0x80) return new[] { (byte)len };
      var b = new List<byte>(); while (len > 0) { b.Insert(0, (byte)len); len >>= 8; }
      b.Insert(0, (byte)(0x80 | b.Count)); return b.ToArray();
    }
    /// True if data[offset..] is ContentInfo { contentType = oid, ... } (BER indefinite outer length allowed).
    public static bool IsContentInfo(byte[] data, int offset, int count, string oid) {
      try {
        if (data == null || count < 4 || data[offset] != 0x30) return false;
        int p = offset + 1; int l = data[p++];
        if ((l & 0x80) != 0 && l != 0x80) p += l & 0x7F;
        if (data[p] != 6) return false;
        var o = Read(data, p);
        return o.End <= offset + count && ObjectIdentifier.Decode(data, o.Start, o.Length) == oid;
      } catch (Exception) { return false; }
    }
  }

  /// Minimal DER writer.
  internal static class W {
    public static byte[] Cat(params byte[][] parts) { var ms = new MemoryStream(); foreach (var p in parts) ms.Write(p, 0, p.Length); return ms.ToArray(); }
    public static byte[] Tlv(int tag, byte[] content) { return Cat(new[] { (byte)tag }, Der.EncodeLength(content.Length), content); }
    public static byte[] Seq(params byte[][] parts) { return Tlv(0x30, Cat(parts)); }
    /// Unsigned big-endian magnitude -> DER INTEGER.
    public static byte[] Integer(byte[] be) {
      int i = 0; while (i < be.Length - 1 && be[i] == 0) i++;
      var v = be.Skip(i).ToArray();
      if (v.Length == 0 || (v[0] & 0x80) != 0) v = Cat(new byte[] { 0 }, v);
      return Tlv(2, v);
    }
  }

  public abstract class CryptographicCollection : ICollection {
    internal readonly ArrayList Items = new ArrayList();
    internal CryptographicCollection() {}
    public int Count { get { return Items.Count; } }
    public IEnumerator GetEnumerator() { return Items.GetEnumerator(); }
    public bool IsSynchronized { get { return false; } }
    public void CopyTo(Array array, int index) { Items.CopyTo(array, index); }
    public object SyncRoot { get { return Items; } }
  }

  public abstract class CryptographicCollection<T> : CryptographicCollection, IList<T> {
    internal CryptographicCollection() {}
    public bool IsReadOnly { get { return false; } }
    public void Add(T item) { if (item == null) throw new ArgumentNullException("item"); Items.Add(item); }
    public void Clear() { Items.Clear(); }
    public bool Contains(T item) { return Items.Contains(item); }
    public int IndexOf(T item) { return Items.IndexOf(item); }
    public void CopyTo(T[] array, int arrayIndex) { Items.CopyTo(array, arrayIndex); }
    public bool Remove(T item) { int i = Items.IndexOf(item); if (i < 0) return false; Items.RemoveAt(i); return true; }
    public void RemoveAt(int index) { Items.RemoveAt(index); }
    public void Insert(int index, T item) { if (item == null) throw new ArgumentNullException("item"); Items.Insert(index, item); }
    public T this[int index] { get { return (T)Items[index]; } set { if (value == null) throw new ArgumentNullException("value"); Items[index] = value; } }
    public new IEnumerator<T> GetEnumerator() { return Items.Cast<T>().GetEnumerator(); }
    IEnumerator<T> IEnumerable<T>.GetEnumerator() { return GetEnumerator(); }
  }

  /// Plug-in registration point for additional key algorithms (Rebex.Castle, Rebex.Curve25519,
  /// Rebex.Ed25519). TLS is done by Mono here, so factories are only recorded.
  public class AsymmetricKeyAlgorithm : IDisposable {
    static readonly List<Func<string, object>> Factories = new List<Func<string, object>>();
    public AsymmetricKeyAlgorithm() {}
    public static void Register(Func<string, object> factory) {
      if (factory == null) throw new ArgumentNullException("factory");
      lock (Factories) Factories.Add(factory);
    }
    internal static int RegisteredCount { get { lock (Factories) return Factories.Count; } }
    public void Dispose() {}
  }
}

namespace Rebex.Security.Cryptography.Pkcs {
  public class ContentInfo {
    internal const string DataOid = "1.2.840.113549.1.7.1";
    readonly ObjectIdentifier contentType;
    readonly byte[] content;
    public ContentInfo(byte[] content) : this(new ObjectIdentifier(DataOid), content) {}
    public ContentInfo(ObjectIdentifier contentType, byte[] content) {
      if (contentType == null) throw new ArgumentNullException("contentType");
      if (content == null) throw new ArgumentNullException("content");
      this.contentType = contentType; this.content = content;
    }
    public ObjectIdentifier ContentType { get { return contentType; } }
    public byte[] Content { get { return content; } }
    /// The content bytes (for id-data the raw data, not DER-wrapped).
    public byte[] ToArray() { return (byte[])content.Clone(); }
    public void CopyTo(Stream output) { output.Write(content, 0, content.Length); }
    internal Sys.ContentInfo ToSys() { return new Sys.ContentInfo(new Oid(contentType.Value), content); }
  }

  [Serializable]
  public abstract class PkcsBase : System.Runtime.Serialization.IDeserializationCallback {
    internal PkcsBase() {}
    void System.Runtime.Serialization.IDeserializationCallback.OnDeserialization(object sender) {}
    public static PkcsBase Load(Stream input, ICertificateFinder finder, bool silent) {
      var data = Certificate.ReadAll(input);
      if (EnvelopedData.IsEnvelopedData(data, 0, data.Length)) { var e = new EnvelopedData { CertificateFinder = finder, Silent = silent }; e.Decode(data); return e; }
      if (SignedData.IsSignedData(data, 0, data.Length)) { var s = new SignedData { CertificateFinder = finder, Silent = silent }; s.Decode(data); return s; }
      throw new CryptographicException("Unsupported PKCS #7 content.");
    }
  }

  public enum SubjectIdentifierType { Unknown = 0, IssuerAndSerialNumber = 1, SubjectKeyIdentifier = 2, PublicKey = 4 }

  [Serializable]
  public class SubjectIdentifier : PkcsBase {
    readonly SubjectIdentifierType type;
    readonly DistinguishedName issuer;
    readonly byte[] serial, ski;
    internal SubjectIdentifier(SubjectIdentifierType type, DistinguishedName issuer, byte[] serialNumber, byte[] subjectKeyIdentifier) {
      this.type = type; this.issuer = issuer; serial = serialNumber; ski = subjectKeyIdentifier;
    }
    internal static SubjectIdentifier FromSys(Sys.SubjectIdentifier id) {
      if (id.Type == Sys.SubjectIdentifierType.IssuerAndSerialNumber) {
        var iss = (System.Security.Cryptography.Xml.X509IssuerSerial)id.Value;
        var be = Certificate.Hex(iss.SerialNumber);
        Array.Reverse(be); // store little-endian like Certificate.GetSerialNumber()
        return new SubjectIdentifier(SubjectIdentifierType.IssuerAndSerialNumber, new DistinguishedName(iss.IssuerName), be, null);
      }
      if (id.Type == Sys.SubjectIdentifierType.SubjectKeyIdentifier)
        return new SubjectIdentifier(SubjectIdentifierType.SubjectKeyIdentifier, null, null, Certificate.Hex((string)id.Value));
      return new SubjectIdentifier(SubjectIdentifierType.Unknown, null, null, null);
    }
    internal static SubjectIdentifier ForCertificate(Certificate c, SubjectIdentifierType type) {
      if (type == SubjectIdentifierType.SubjectKeyIdentifier) return new SubjectIdentifier(type, null, null, c.GetSubjectKeyIdentifier());
      return new SubjectIdentifier(SubjectIdentifierType.IssuerAndSerialNumber, c.GetIssuer(), c.GetSerialNumber(), null);
    }
    public SubjectIdentifierType Type { get { return type; } }
    public DistinguishedName Issuer { get { return issuer; } }
    public byte[] SerialNumber { get { return serial == null ? null : (byte[])serial.Clone(); } }
    public byte[] SubjectKeyIdentifier { get { return ski == null ? null : (byte[])ski.Clone(); } }

    internal bool Matches(Certificate c) {
      if (c == null) return false;
      switch (type) {
        case SubjectIdentifierType.IssuerAndSerialNumber:
          return serial != null && Trim(c.GetSerialNumber()).SequenceEqual(Trim(serial)) && c.GetIssuer().Equals(issuer);
        case SubjectIdentifierType.SubjectKeyIdentifier:
          var k = c.GetSubjectKeyIdentifier();
          return k != null && ski != null && k.SequenceEqual(ski);
        default: return false;
      }
    }
    // little-endian: drop high-order zero bytes (sign padding) at the end
    static byte[] Trim(byte[] le) { int n = le.Length; while (n > 1 && le[n - 1] == 0) n--; return le.Take(n).ToArray(); }
  }

  public interface ICertificateFinder {
    CertificateChain Find(SubjectIdentifier subjectIdentifier, CertificateStore additionalStore);
  }

  public abstract class CertificateFinder {
    /// Searches certificates added in this process, then the CurrentUser and LocalMachine "My" stores.
    public static readonly ICertificateFinder Default = new StoreFinder();
    internal CertificateFinder() {}
    public static ICertificateFinder CreateFinder(CertificateChain[] chains) {
      if (chains == null) throw new ArgumentNullException("chains");
      return new ChainFinder(chains);
    }

    sealed class ChainFinder : ICertificateFinder {
      readonly CertificateChain[] chains;
      public ChainFinder(CertificateChain[] chains) { this.chains = chains; }
      public CertificateChain Find(SubjectIdentifier id, CertificateStore additionalStore) {
        foreach (var ch in chains) {
          if (ch == null) continue;
          for (int i = 0; i < ch.Count; i++)
            if (id.Matches(ch[i])) return new CertificateChain(ch.Skip(i).ToArray());
        }
        return additionalStore == null ? null : FromStore(id, additionalStore);
      }
    }

    sealed class StoreFinder : ICertificateFinder {
      public CertificateChain Find(SubjectIdentifier id, CertificateStore additionalStore) {
        var stores = new List<CertificateStore>();
        if (additionalStore != null) stores.Add(additionalStore);
        stores.Add(new CertificateStore(CertificateStoreName.My, CertificateStoreLocation.CurrentUser));
        stores.Add(new CertificateStore(CertificateStoreName.My, CertificateStoreLocation.LocalMachine));
        CertificateChain fallback = null;
        foreach (var s in stores) {
          var ch = FromStore(id, s);
          if (ch != null && ch.LeafCertificate.HasPrivateKey()) return ch;
          if (ch != null && fallback == null) fallback = ch;
        }
        return fallback;
      }
    }

    static CertificateChain FromStore(SubjectIdentifier id, CertificateStore store) {
      var hits = store.Where(id.Matches).ToList();
      var best = hits.FirstOrDefault(c => c.HasPrivateKey()) ?? hits.FirstOrDefault();
      return best == null ? null : new CertificateChain(best);
    }
  }

  public abstract class RecipientInfo {
    protected RecipientInfo() {}
    public abstract SubjectIdentifier RecipientIdentifier { get; }
    public abstract byte[] EncryptedKey { get; }
    public abstract Certificate Certificate { get; }
    public abstract CertificateChain CertificateChain { get; }
  }

  public class KeyTransRecipientInfo : RecipientInfo {
    readonly SubjectIdentifier id;
    readonly SubjectIdentifierType idType;
    internal CertificateChain Chain;
    internal readonly Sys.RecipientInfo Decoded;

    public KeyTransRecipientInfo(Certificate certificate) : this(certificate, SubjectIdentifierType.IssuerAndSerialNumber) {}
    public KeyTransRecipientInfo(Certificate certificate, SubjectIdentifierType subjectIdentifierType) {
      if (certificate == null) throw new ArgumentNullException("certificate");
      idType = subjectIdentifierType == SubjectIdentifierType.SubjectKeyIdentifier ? subjectIdentifierType : SubjectIdentifierType.IssuerAndSerialNumber;
      id = SubjectIdentifier.ForCertificate(certificate, idType);
      Chain = new CertificateChain(certificate);
    }
    internal KeyTransRecipientInfo(Sys.RecipientInfo decoded) {
      Decoded = decoded;
      id = SubjectIdentifier.FromSys(decoded.RecipientIdentifier);
      idType = id.Type;
    }
    internal SubjectIdentifierType IdType { get { return idType; } }
    public override SubjectIdentifier RecipientIdentifier { get { return id; } }
    public override byte[] EncryptedKey { get { return Decoded == null ? null : Decoded.EncryptedKey; } }
    public override Certificate Certificate { get { return Chain == null ? null : Chain.LeafCertificate; } }
    public override CertificateChain CertificateChain { get { return Chain; } }
  }

  public class RecipientInfoCollection : CryptographicCollection<RecipientInfo> {
    public RecipientInfoCollection() {}
  }

  [Serializable]
  public class EnvelopedData : PkcsBase {
    const string EnvelopedOid = "1.2.840.113549.1.7.3";
    const string DefaultAlgorithm = "2.16.840.1.101.3.4.1.42"; // AES-256-CBC
    [NonSerialized] Sys.EnvelopedCms cms;
    byte[] encoded;
    readonly RecipientInfoCollection recipients = new RecipientInfoCollection();
    readonly CertificateCollection certificates = new CertificateCollection();
    readonly ObjectIdentifier algorithm;
    readonly int keyLength;
    KeyTransRecipientInfo matched;

    public EnvelopedData() : this(null, null, 0) {}
    public EnvelopedData(ContentInfo contentInfo) : this(contentInfo, null, 0) {}
    public EnvelopedData(ContentInfo contentInfo, ObjectIdentifier encryptionAlgorithm) : this(contentInfo, encryptionAlgorithm, 0) {}
    public EnvelopedData(ContentInfo contentInfo, ObjectIdentifier encryptionAlgorithm, int keyLength) {
      ContentInfo = contentInfo;
      algorithm = encryptionAlgorithm ?? new ObjectIdentifier(DefaultAlgorithm);
      this.keyLength = keyLength;
    }

    public ICertificateFinder CertificateFinder { get; set; }
    public bool Silent { get; set; }
    public bool IsEncrypted { get; private set; }
    public CertificateCollection Certificates { get { return certificates; } }
    public RecipientInfoCollection RecipientInfos { get { return recipients; } }
    public ContentInfo ContentInfo { get; set; }

    public bool HasPrivateKey { get { return AcquirePrivateKey(); } }

    /// Finds a recipient certificate with a private key via CertificateFinder (default: the stores).
    public bool AcquirePrivateKey() {
      if (matched != null && matched.Chain != null && matched.Chain.LeafCertificate.HasPrivateKey()) return true;
      var finder = CertificateFinder ?? Rebex.Security.Cryptography.Pkcs.CertificateFinder.Default;
      foreach (var ri in recipients.OfType<KeyTransRecipientInfo>()) {
        if (ri.Decoded == null) continue;
        CertificateChain ch = null;
        try { ch = finder.Find(ri.RecipientIdentifier, null); } catch (Exception) {}
        if (ch != null && ch.Count > 0 && ch.LeafCertificate.HasPrivateKey()) { ri.Chain = ch; matched = ri; return true; }
      }
      return false;
    }

    /// Standard CMS (RFC 5652) key transport with RSA PKCS#1 v1.5, content encrypted as raw
    /// bytes (like Rebex and OpenSSL; Mono's EnvelopedCms would wrap id-data content in an
    /// extra OCTET STRING). AES-128/192/256-CBC or 3DES-CBC.
    public void Encrypt() {
      if (ContentInfo == null) throw new InvalidOperationException("Content is not set.");
      var list = recipients.OfType<KeyTransRecipientInfo>().Where(r => r.Certificate != null).ToList();
      if (list.Count == 0) throw new InvalidOperationException("No recipients specified.");
      SymmetricAlgorithm sym;
      switch (algorithm.Value) {
        case "2.16.840.1.101.3.4.1.2": sym = Aes.Create(); sym.KeySize = 128; break;
        case "2.16.840.1.101.3.4.1.22": sym = Aes.Create(); sym.KeySize = 192; break;
        case "2.16.840.1.101.3.4.1.42": sym = Aes.Create(); sym.KeySize = 256; break;
        case "1.2.840.113549.3.7": sym = TripleDES.Create(); sym.KeySize = 192; break;
        default: throw new CryptographicException("Unsupported content encryption algorithm " + algorithm.Value + ".");
      }
      if (keyLength > 0 && keyLength != sym.KeySize) throw new CryptographicException("Invalid key length " + keyLength + " for " + algorithm.Value + ".");
      using (sym) {
        sym.Mode = CipherMode.CBC; sym.Padding = PaddingMode.PKCS7;
        sym.GenerateKey(); sym.GenerateIV();
        byte[] encrypted;
        using (var enc = sym.CreateEncryptor()) encrypted = enc.TransformFinalBlock(ContentInfo.Content, 0, ContentInfo.Content.Length);
        bool anySki = list.Any(r => r.IdType == SubjectIdentifierType.SubjectKeyIdentifier);
        var ris = new List<byte[]>();
        foreach (var r in list) {
          var x = r.Certificate.X509;
          var rsa = x.PublicKey.Key as RSACryptoServiceProvider;
          if (rsa == null) throw new CryptographicException("Only RSA recipient certificates are supported.");
          byte[] rid;
          if (r.IdType == SubjectIdentifierType.SubjectKeyIdentifier) {
            var ski = r.Certificate.GetSubjectKeyIdentifier();
            if (ski == null) throw new CryptographicException("The recipient certificate has no subject key identifier.");
            rid = W.Tlv(0x80, ski);
          } else {
            var serial = x.GetSerialNumber(); Array.Reverse(serial);
            rid = W.Seq(x.IssuerName.RawData, W.Integer(serial));
          }
          ris.Add(W.Seq(W.Integer(new byte[] { (byte)(r.IdType == SubjectIdentifierType.SubjectKeyIdentifier ? 2 : 0) }), rid,
                        W.Seq(new ObjectIdentifier("1.2.840.113549.1.1.1").ToArray(), new byte[] { 5, 0 }),
                        W.Tlv(0x04, rsa.Encrypt(sym.Key, false))));
        }
        var eci = W.Seq(ContentInfo.ContentType.ToArray(), W.Seq(algorithm.ToArray(), W.Tlv(0x04, sym.IV)), W.Tlv(0x80, encrypted));
        var env = W.Seq(W.Integer(new byte[] { (byte)(anySki ? 2 : 0) }), W.Tlv(0x31, W.Cat(ris.ToArray())), eci);
        encoded = W.Seq(new ObjectIdentifier(EnvelopedOid).ToArray(), W.Tlv(0xA0, env));
      }
      cms = null;
      IsEncrypted = true;
    }

    public void Decrypt() {
      if (!IsEncrypted) throw new InvalidOperationException("The message is not encrypted.");
      if (cms == null) { var c = ContentInfo; Decode(encoded); ContentInfo = c; }
      if (!AcquirePrivateKey())
        throw new CryptographicException("Unable to find a certificate with an associated private key for any of the recipients.");
      var cert = matched.Chain.LeafCertificate.X509;
      // Mono (like .NET on Windows) also unwraps content that the sender wrapped in an OCTET STRING.
      cms.Decrypt(matched.Decoded, new X509Certificate2Collection(cert));
      ContentInfo = new ContentInfo(new ObjectIdentifier(cms.ContentInfo.ContentType.Value), cms.ContentInfo.Content);
      IsEncrypted = false;
    }

    public void Decode(byte[] encodedMessage) {
      if (encodedMessage == null) throw new ArgumentNullException("encodedMessage");
      var c = new Sys.EnvelopedCms();
      c.Decode(encodedMessage);
      cms = c;
      encoded = (byte[])encodedMessage.Clone();
      matched = null;
      recipients.Clear();
      foreach (Sys.RecipientInfo ri in c.RecipientInfos) recipients.Add(new KeyTransRecipientInfo(ri));
      certificates.Clear();
      foreach (var x in c.Certificates) certificates.Add(new Certificate(x));
      ContentInfo = null;
      IsEncrypted = true;
    }

    /// The encrypted message (after Encrypt or Decode).
    public byte[] Encode() {
      if (encoded == null) throw new InvalidOperationException("The message has not been encrypted yet.");
      return (byte[])encoded.Clone();
    }

    public static bool IsEnvelopedData(byte[] buffer, int offset, int count) { return Der.IsContentInfo(buffer, offset, count, EnvelopedOid); }
    public void Load(Stream input) { Decode(Certificate.ReadAll(input)); }
    public void Save(Stream output) { var b = Encode(); output.Write(b, 0, b.Length); }
  }

  [Flags] public enum SignatureValidationStatus : long {
    CertificateNotValid = 1, CertificateNotAvailable = 2, UnsupportedDigestAlgorithm = 4, UnsupportedSignatureAlgorithm = 8,
    InvalidSignature = 16, InvalidKeyUsage = 32, ContentTypeMismatch = 64
  }

  public class SignatureValidationResult {
    readonly SignatureValidationStatus status;
    internal SignatureValidationResult(SignatureValidationStatus status) { this.status = status; }
    public SignatureValidationStatus Status { get { return status; } }
    public bool Valid { get { return status == 0; } }
  }

  public enum CertificateIncludeOption { LeaveExisting = -1, None = 0, ExcludeRoot = 1, EndCertificateOnly = 2, WholeChain = 3 }

  public class SignerInfo {
    readonly SubjectIdentifierType idType;
    internal Sys.SignerInfo Decoded;
    internal CertificateChain Chain;
    DateTime signingTime = DateTime.MinValue;
    byte[] signature;

    public SignerInfo(Certificate certificate) : this(certificate, SubjectIdentifierType.IssuerAndSerialNumber) {}
    public SignerInfo(Certificate certificate, SubjectIdentifierType subjectIdentifierType) {
      if (certificate == null) throw new ArgumentNullException("certificate");
      idType = subjectIdentifierType == SubjectIdentifierType.SubjectKeyIdentifier ? subjectIdentifierType : SubjectIdentifierType.IssuerAndSerialNumber;
      Chain = new CertificateChain(certificate);
    }
    internal SignerInfo(Sys.SignerInfo decoded) {
      Decoded = decoded;
      idType = decoded.SignerIdentifier.Type == Sys.SubjectIdentifierType.SubjectKeyIdentifier ? SubjectIdentifierType.SubjectKeyIdentifier : SubjectIdentifierType.IssuerAndSerialNumber;
      if (decoded.Certificate != null) Chain = new CertificateChain(new Certificate(decoded.Certificate));
      foreach (var a in decoded.SignedAttributes)
        foreach (var v in a.Values) {
          var t = v as Sys.Pkcs9SigningTime;
          if (t == null && v.Oid != null && v.Oid.Value == "1.2.840.113549.1.9.5") try { t = new Sys.Pkcs9SigningTime(v.RawData); } catch (Exception) {}
          if (t != null) signingTime = t.SigningTime.Kind == DateTimeKind.Utc ? t.SigningTime.ToLocalTime() : t.SigningTime;
        }
    }
    internal SubjectIdentifierType IdType { get { return idType; } }

    public SubjectIdentifier SignerIdentifier {
      get { return Decoded != null ? SubjectIdentifier.FromSys(Decoded.SignerIdentifier) : SubjectIdentifier.ForCertificate(Certificate, idType); }
    }
    public ObjectIdentifier DigestAlgorithm { get { return Decoded == null ? new ObjectIdentifier("2.16.840.1.101.3.4.2.1") : new ObjectIdentifier(Decoded.DigestAlgorithm.Value); } }
    public byte[] Signature { get { return signature == null ? null : (byte[])signature.Clone(); } internal set { signature = value; } }
    public Certificate Certificate { get { return Chain == null ? null : Chain.LeafCertificate; } }
    public CertificateChain CertificateChain { get { return Chain; } }
    public DateTime SigningTime { get { return signingTime; } set { signingTime = value; } }

    public SignatureValidationResult Validate() {
      if (Decoded == null) return new SignatureValidationResult(SignatureValidationStatus.CertificateNotAvailable);
      try {
        if (Decoded.Certificate == null && Certificate != null) Decoded.CheckSignature(new X509Certificate2Collection(Certificate.X509), true);
        else Decoded.CheckSignature(true);
        return new SignatureValidationResult(0);
      } catch (CryptographicException) {
        return new SignatureValidationResult(Certificate == null ? SignatureValidationStatus.CertificateNotAvailable : SignatureValidationStatus.InvalidSignature);
      }
    }
  }

  public class SignerInfoCollection : CryptographicCollection<SignerInfo> {
    public SignerInfoCollection() {}
  }

  [Serializable]
  public class SignedData : PkcsBase {
    const string SignedOid = "1.2.840.113549.1.7.2";
    [NonSerialized] Sys.SignedCms cms;
    readonly SignerInfoCollection signers = new SignerInfoCollection();
    readonly CertificateCollection certificates = new CertificateCollection();

    public SignedData() : this(null, false) {}
    public SignedData(ContentInfo contentInfo) : this(contentInfo, false) {}
    public SignedData(ContentInfo contentInfo, bool detached) {
      ContentInfo = contentInfo; Detached = detached; IncludeOption = CertificateIncludeOption.ExcludeRoot;
    }

    public CertificateIncludeOption IncludeOption { get; set; }
    public ICertificateFinder CertificateFinder { get; set; }
    public bool Silent { get; set; }
    public CertificateCollection Certificates { get { return certificates; } }
    public SignerInfoCollection SignerInfos { get { return signers; } }
    public ContentInfo ContentInfo { get; set; }
    public bool Detached { get; set; }

    public void Sign() {
      if (ContentInfo == null) throw new InvalidOperationException("Content is not set.");
      if (signers.Count == 0) throw new InvalidOperationException("No signers specified.");
      var c = new Sys.SignedCms(ContentInfo.ToSys(), Detached);
      foreach (var si in signers) {
        if (si.Decoded != null) continue;
        var s = new Sys.CmsSigner(si.IdType == SubjectIdentifierType.SubjectKeyIdentifier ? Sys.SubjectIdentifierType.SubjectKeyIdentifier : Sys.SubjectIdentifierType.IssuerAndSerialNumber, si.Certificate.X509);
        s.DigestAlgorithm = new Oid("2.16.840.1.101.3.4.2.1");
        s.IncludeOption = IncludeOption == CertificateIncludeOption.None ? X509IncludeOption.None
          : IncludeOption == CertificateIncludeOption.EndCertificateOnly ? X509IncludeOption.EndCertOnly
          : IncludeOption == CertificateIncludeOption.WholeChain ? X509IncludeOption.WholeChain : X509IncludeOption.ExcludeRoot;
        s.SignedAttributes.Add(new Sys.Pkcs9SigningTime(si.SigningTime == DateTime.MinValue ? DateTime.Now : si.SigningTime));
        foreach (var extra in certificates) s.Certificates.Add(extra.X509);
        c.ComputeSignature(s, true);
      }
      cms = c;
      Reload();
    }

    public SignatureValidationResult Validate() {
      if (cms == null) throw new InvalidOperationException("The message is not signed.");
      SignatureValidationStatus st = 0;
      if (signers.Count == 0) st = SignatureValidationStatus.CertificateNotAvailable;
      foreach (var si in signers) st |= si.Validate().Status;
      return new SignatureValidationResult(st);
    }

    public void Decode(byte[] encodedMessage) {
      if (encodedMessage == null) throw new ArgumentNullException("encodedMessage");
      var c = Detached && ContentInfo != null ? new Sys.SignedCms(ContentInfo.ToSys(), true) : new Sys.SignedCms();
      c.Decode(encodedMessage);
      cms = c;
      Detached = c.Detached;
      if (!c.Detached) ContentInfo = new ContentInfo(new ObjectIdentifier(c.ContentInfo.ContentType.Value), c.ContentInfo.Content);
      Reload();
      var finder = CertificateFinder ?? Rebex.Security.Cryptography.Pkcs.CertificateFinder.Default;
      foreach (var si in signers)
        if (si.Chain == null) try { si.Chain = finder.Find(si.SignerIdentifier, new CertificateStore(certificates)); } catch (Exception) {}
    }

    void Reload() {
      signers.Clear();
      foreach (Sys.SignerInfo s in cms.SignerInfos) signers.Add(new SignerInfo(s) { Signature = SignatureOf(s) });
      certificates.Clear();
      foreach (var x in cms.Certificates) certificates.Add(new Certificate(x));
    }

    static byte[] SignatureOf(Sys.SignerInfo s) {
      var p = typeof(Sys.SignerInfo).GetMethod("GetSignature", Type.EmptyTypes);
      try { return p == null ? null : (byte[])p.Invoke(s, null); } catch (Exception) { return null; }
    }

    public byte[] Encode() {
      if (cms == null) throw new InvalidOperationException("The message is not signed.");
      return cms.Encode();
    }

    public static bool IsSignedData(byte[] buffer, int offset, int count) { return Der.IsContentInfo(buffer, offset, count, SignedOid); }
    public void Load(Stream input) { Decode(Certificate.ReadAll(input)); }
    public void Save(Stream output) { var b = Encode(); output.Write(b, 0, b.Length); }
  }
}
