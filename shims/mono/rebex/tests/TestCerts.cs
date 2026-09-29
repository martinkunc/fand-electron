// Test certificates generated in memory with Mono.Security (no files or tools needed):
// a self-signed TLS server certificate and CMS recipient certificates (as PFX).
using System;
using System.IO;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using MX = Mono.Security.X509;

static class TestCerts {
  public const string Password = "heslo";
  static int serial = 0x1000;

  /// PKCS#12 bytes with one certificate and its private key.
  public static byte[] Pfx(string subject, bool withSki, out RSA key) {
    key = new RSACryptoServiceProvider(2048);
    var b = new MX.X509CertificateBuilder(3);
    int sn = ++serial;
    b.SerialNumber = new byte[] { 0x0C, (byte)(sn >> 8), (byte)sn, 0x42 };
    b.IssuerName = subject;
    b.SubjectName = subject;
    b.NotBefore = DateTime.UtcNow.AddDays(-1);
    b.NotAfter = DateTime.UtcNow.AddYears(2);
    b.SubjectPublicKey = key;
    b.Hash = "SHA256";
    if (withSki) {
      var ski = new MX.Extensions.SubjectKeyIdentifierExtension();
      using (var sha = SHA1.Create()) ski.Identifier = sha.ComputeHash(((RSACryptoServiceProvider)key).ExportCspBlob(false));
      b.Extensions.Add(ski);
    }
    byte[] raw = b.Sign(key);
    var p12 = new MX.PKCS12 { Password = Password };
    p12.AddCertificate(new MX.X509Certificate(raw));
    p12.AddPkcs8ShroudedKeyBag(key);
    return p12.GetBytes();
  }

  public static X509Certificate2 Load(byte[] pfx) { return new X509Certificate2(pfx, Password, X509KeyStorageFlags.Exportable); }

  public static string Write(string dir, string name, byte[] data) {
    var p = Path.Combine(dir, name);
    File.WriteAllBytes(p, data);
    return p;
  }

  public static string ToPem(byte[] der, string label) {
    return "-----BEGIN " + label + "-----\n" + Convert.ToBase64String(der, Base64FormattingOptions.InsertLineBreaks) + "\n-----END " + label + "-----\n";
  }
}
