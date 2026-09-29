// Rebex.Networking substitute: the TLS settings the helpers set. The actual TLS is done by
// Mono's own stack (HttpWebRequest/SslStream); see Http.cs for how the settings are applied.
using System;
using System.Net;

namespace Rebex.Net {
  /// Values as in the original (Any = TLS10|TLS11|TLS12, i.e. 14).
  [Flags] public enum TlsVersion { None = 0, SSL30 = 1, TLS10 = 2, TLS11 = 4, TLS12 = 8, TLS13 = 16, Any = 14 }

  [Serializable]
  public abstract class SslSettings {
    public SslSettings() {
      SslAllowedVersions = TlsVersion.Any;
      SslRenegotiationExtensionEnabled = true;
      SslServerNameIndicationEnabled = true;
      SslMinimumDiffieHellmanKeySize = 1024;
    }

    /// When true, any server certificate is accepted (no chain/name validation).
    public bool SslAcceptAllCertificates { get; set; }
    /// Mapped onto ServicePointManager.SecurityProtocol for each request (Mono has no TLS 1.3 / SSL 3.0).
    public TlsVersion SslAllowedVersions { get; set; }
    /// Recorded only: Mono always sends the request host name as SNI.
    public string SslServerName { get; set; }
    public bool SslAllowVulnerableSuites { get; set; }
    public bool SslDoNotInsertEmptyFragment { get; set; }
    public bool SslRenegotiationExtensionEnabled { get; set; }
    public bool SslServerNameIndicationEnabled { get; set; }
    public int SslMinimumDiffieHellmanKeySize { get; set; }
    public bool SslStrictKeyUsageValidation { get; set; }

    internal SecurityProtocolType? ToSecurityProtocol() {
      SecurityProtocolType p = 0;
      if ((SslAllowedVersions & TlsVersion.TLS10) != 0) p |= SecurityProtocolType.Tls;
      if ((SslAllowedVersions & TlsVersion.TLS11) != 0) p |= SecurityProtocolType.Tls11;
      if ((SslAllowedVersions & TlsVersion.TLS12) != 0) p |= SecurityProtocolType.Tls12;
      if (p == 0) return null; // only SSL 3.0 / TLS 1.3 requested: leave Mono's default
      return p;
    }
  }
}
