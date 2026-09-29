// Rebex 5.0.7320.0 only: UctoZP2 registers the ORIGINAL Rebex.Castle / Rebex.Curve25519 /
// Rebex.Ed25519 plug-ins (pure managed, reference only mscorlib, kept as shipped) with the
// substitute Rebex.Common. This test is compiled against those original dlls.
using System;
using Rebex.Security.Cryptography;

static partial class Tests {
  static partial void RegisterExtraTests() {
    Test("UctoZP2 PortalZpHelper.SendMessageToZP: AsymmetricKeyAlgorithm.Register(original EllipticCurveAlgorithm/Curve25519/Ed25519 .Create)", () => {
      AsymmetricKeyAlgorithm.Register(EllipticCurveAlgorithm.Create);
      AsymmetricKeyAlgorithm.Register(Curve25519.Create);
      AsymmetricKeyAlgorithm.Register(Ed25519.Create);
      Check(Curve25519.Create("curve25519-sha256") != null, "original Curve25519 plug-in runs under Mono");
      Check(Ed25519.Create("ed25519-sha512") != null, "original Ed25519 plug-in runs under Mono");
      Check(EllipticCurveAlgorithm.Create("ecdsa-sha2-nistp256") != null, "original Castle plug-in runs under Mono");
      Check(typeof(Curve25519).Assembly.Location.Contains("{ap03}") || typeof(Curve25519).Assembly.GetName().Version.ToString() == "1.0.0.0", "original plug-in assembly");
    });
  }
}
