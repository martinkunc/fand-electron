// Runtime tests of the Rebex substitutes, compiled once per Rebex version against the
// substitute dlls (see run.sh). Each test replays the way a helper uses the API (the
// decompiled call sites are named in the test titles). Offline by default: a local
// HTTPS/HTTP server with a self-signed certificate and in-memory CMS certificates.
//   --live     also GET the public ARES REST API (certificate validation on)
//   --openssl  also cross-check CMS with the openssl command line tool
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Web.Services;
using System.Web.Services.Protocols;
using Rebex;
using Rebex.Net;
using Rebex.Security.Certificates;
using Rebex.Security.Cryptography.Pkcs;
using SysPkcs = System.Security.Cryptography.Pkcs;

[WebServiceBinding(Name = "EchoBinding", Namespace = "urn:rebex-test")]
public class EchoSoapClient : SoapHttpClientProtocol {
  [SoapDocumentMethod("urn:rebex-test/echo", RequestNamespace = "urn:rebex-test", ResponseNamespace = "urn:rebex-test",
    Use = System.Web.Services.Description.SoapBindingUse.Literal, ParameterStyle = SoapParameterStyle.Wrapped)]
  public string echo(string text) { return (string)Invoke("echo", new object[] { text })[0]; }
}

static partial class Tests {
  static readonly List<Tuple<string, Action>> All = new List<Tuple<string, Action>>();
  static TestServer https, http;
  static string tmp;
  static bool live, openssl;

  static partial void RegisterExtraTests();
  static void Test(string name, Action a) { All.Add(Tuple.Create(name, a)); }
  static void Check(bool cond, string what) { if (!cond) throw new Exception("check failed: " + what); }
  static void Eq<T>(T expected, T actual, string what) { if (!object.Equals(expected, actual)) throw new Exception(what + ": expected <" + expected + "> but was <" + actual + ">"); }
  static T Throws<T>(Action a, string what) where T : Exception {
    try { a(); } catch (T ex) { return ex; } catch (Exception ex) { throw new Exception(what + ": expected " + typeof(T).Name + " but got " + ex.GetType().Name + ": " + ex.Message, ex); }
    throw new Exception(what + ": expected " + typeof(T).Name + " but nothing was thrown");
  }
  static string ReadAll(WebResponse r) { using (var sr = new StreamReader(r.GetResponseStream())) return sr.ReadToEnd(); }

  static int Main(string[] args) {
    live = args.Contains("--live");
    openssl = args.Contains("--openssl");
    string version = typeof(HttpRequest).Assembly.GetName().Version.ToString();
    Console.WriteLine("Rebex substitute tests, version " + version + " (" + typeof(HttpRequest).Assembly.Location + ")");
    Check(typeof(HttpRequest).Assembly.GetCustomAttributes(typeof(System.Reflection.AssemblyDescriptionAttribute), false)
      .Cast<System.Reflection.AssemblyDescriptionAttribute>().Single().Description.Contains("substitute"), "the substitute (not the original) is loaded");
    tmp = Path.Combine(Path.GetTempPath(), "rebex-shim-tests-" + Process.GetCurrentProcess().Id);
    Directory.CreateDirectory(tmp);
    RSA k;
    var serverPfx = TestCerts.Pfx("CN=localhost, O=Rebex shim test server", false, out k);
    https = new TestServer(TestCerts.Load(serverPfx));
    http = new TestServer(null);

    RegisterHttpTests();
    RegisterLogTests();
    RegisterCmsTests();
    RegisterExtraTests();
    if (live) RegisterLiveTests();

    int failed = 0;
    foreach (var t in All) {
      var sw = Stopwatch.StartNew();
      try { t.Item2(); Console.WriteLine("PASS  " + t.Item1 + " (" + sw.ElapsedMilliseconds + " ms)"); }
      catch (Exception ex) { failed++; Console.WriteLine("FAIL  " + t.Item1 + "\n      " + ex.ToString().Replace("\n", "\n      ")); }
    }
    https.Dispose(); http.Dispose();
    try { Directory.Delete(tmp, true); } catch (Exception) {}
    Console.WriteLine((failed == 0 ? "ALL PASSED" : failed + " FAILED") + " (" + All.Count + " tests, Rebex " + version + ")");
    return failed == 0 ? 0 : 1;
  }

  static HttpRequestCreator AcceptAll() {
    var c = new HttpRequestCreator();
    c.Settings.SslAllowedVersions = TlsVersion.TLS12;
    c.Settings.SslAcceptAllCertificates = true;
    return c;
  }

  static void RegisterHttpTests() {
    Test("Ares2 AresSubject.CallAresRestApiService: TLS12 GET, response read via WebResponse", () => {
      var c = AcceptAll();
      WebResponse response = c.Create(https.Base + "/echo?ico=00006947").GetResponse();
      Check(response is HttpResponse, "GetResponse returns Rebex.Net.HttpResponse");
      string text = new StreamReader(response.GetResponseStream()).ReadToEnd();
      response.Close();
      Check(text.StartsWith("GET /echo?ico=00006947"), "server saw the GET: " + text);
      Eq(SecurityProtocolType.Tls12, ServicePointManager.SecurityProtocol, "SslAllowedVersions=TLS12 applied");
    });

    Test("Ares2: HTTP 404 -> WebException(ProtocolError) whose Response (HttpResponse) carries the JSON error", () => {
      var c = AcceptAll();
      var ex = Throws<WebException>(() => c.Create(https.Base + "/ares/404").GetResponse(), "404");
      Eq(WebExceptionStatus.ProtocolError, ex.Status, "status");
      Check(ex.Response is HttpResponse, "ex.Response is HttpResponse");
      Eq(HttpStatusCode.NotFound, ((HttpResponse)ex.Response).StatusCode, "status code");
      Check(ex.Message.Contains("404"), "message mentions 404: " + ex.Message);
      string json = new StreamReader(ex.Response.GetResponseStream()).ReadToEnd();
      Check(json.Contains("\"kod\":\"NENALEZENO\""), "error JSON readable: " + json);
    });

    Test("untrusted self-signed certificate is rejected unless SslAcceptAllCertificates", () => {
      var c = new HttpRequestCreator();
      c.Settings.SslAllowedVersions = TlsVersion.TLS12;
      var ex = Throws<WebException>(() => c.Create(https.Base + "/echo").GetResponse(), "untrusted");
      Check(ex.Status != WebExceptionStatus.ProtocolError && ex.Response == null, "TLS-level failure, not an HTTP error: " + ex.Status);
    });

    Test("Nepl2/UctoDS/UctoMD: Register() then SslAcceptAllCertificates set afterwards; SOAP proxy (System.Web.Services) goes through the creator", () => {
      var c = new HttpRequestCreator();
      c.Settings.SslAllowedVersions = TlsVersion.TLS12;
      c.Register();
      c.Settings.SslAcceptAllCertificates = true;
      var logPath = Path.Combine(tmp, "nepl2-rebex.log");
      c.LogWriter = new FileLogWriter(logPath, LogLevel.Debug);
      try {
        Check(WebRequest.Create(https.Base + "/echo") is HttpRequest, "WebRequest.Create returns Rebex HttpRequest after Register");
        var soap = new EchoSoapClient { Url = https.Base + "/soap" };
        Eq("ECHO:Ahoj", soap.echo("Ahoj"), "SOAP result");
        var r = https.Last();
        Check(r.Headers["SOAPAction"].Contains("urn:rebex-test/echo"), "SOAPAction header");
        Check(r.Headers["Content-Type"].StartsWith("text/xml"), "SOAP content type");
        var log = File.ReadAllText(logPath);
        Check(log.Contains("POST " + https.Base + "/soap") && log.Contains("Received response: 200"), "request logged at Debug: " + log);
        var fault = new EchoSoapClient { Url = https.Base + "/soapfault" };
        var se = Throws<SoapException>(() => fault.echo("x"), "SOAP fault");
        Check(se.Message.Contains("Chyba sluzby"), "fault string: " + se.Message);
      } finally { Unregister(); }
    });

    Test("UctoZP2 SendMessageToZP: POST form, request stream written but never closed, ContentType read from response", () => {
      var c = AcceptAll();
      HttpRequest req = c.Create(https.Base + "/echo");
      req.ContentType = "application/x-www-form-urlencoded";
      req.Method = "POST";
      byte[] bytes = Encoding.GetEncoding(28592).GetBytes("request=" + Uri.EscapeDataString("<data>žluťoučký</data>"));
      req.ContentLength = bytes.Length;
      req.GetRequestStream().Write(bytes, 0, bytes.Length);
      WebResponse response = req.GetResponse();
      Check(response.ContentType.Contains("utf-8"), "content type: " + response.ContentType);
      var r = https.Last();
      Eq(bytes.Length, r.Body.Length, "body length");
      Eq("application/x-www-form-urlencoded", r.Headers["Content-Type"], "content type header");
      response.Close();
    });

    Test("UctoApep Rebex.Samples.WcfRequestChannel: Content-Type/Connection/Expect/SOAPAction via Headers.Add, ILogWriter.Write(null type)", () => {
      var c = AcceptAll();
      var logPath = Path.Combine(tmp, "uctoapep-rebex.log");
      c.LogWriter = new FileLogWriter(logPath, LogLevel.Debug);
      ILogWriter logWriter = c.LogWriter;
      HttpRequest req = c.Create(new Uri(https.Base + "/echo"));
      req.Timeout = (int)Math.Ceiling(TimeSpan.FromMinutes(1).TotalMilliseconds);
      req.Method = "POST";
      req.Headers.Add("SOAPAction", "\"urn:action\"");
      req.Headers.Add("Content-Type", "application/soap+xml; charset=utf-8");
      req.Headers.Add("Connection", "Keep-Alive");
      req.Headers.Add("Expect", "100-continue");
      using (Stream s = req.GetRequestStream()) { var b = Encoding.UTF8.GetBytes("<Envelope/>"); s.Write(b, 0, b.Length); }
      string body;
      using (Stream cs = req.GetResponse().GetResponseStream()) body = new StreamReader(cs).ReadToEnd();
      if (logWriter != null) logWriter.Write(LogLevel.Debug, null, 0, "SOAP", body);
      var r = https.Last();
      Eq("application/soap+xml; charset=utf-8", r.Headers["Content-Type"], "Content-Type");
      Eq("\"urn:action\"", r.Headers["SOAPAction"], "SOAPAction");
      Eq("<Envelope/>", r.BodyText, "body");
      Check(r.SentContinue, "100-continue handshake used");
      Check(File.ReadAllText(logPath).Contains("SOAP: POST /echo"), "ILogWriter.Write with null objectType logged");
    });

    Test("ELDOTAZ: Register + WebRequest.Create, ContentLength counts characters, StreamWriter body, (HttpResponse) cast, using, StatusCode", () => {
      var c = new HttpRequestCreator();
      c.Register();
      c.Settings.SslAcceptAllCertificates = true; // the original has no validation hook here; our server is self-signed
      try {
        string xml = "<Podani>Příliš žluťoučký kůň</Podani>";
        WebRequest webRequest = WebRequest.Create(new Uri(https.Base + "/echo"));
        webRequest.Method = "POST";
        webRequest.ContentType = "text/xml";
        webRequest.ContentLength = xml.Length; // characters, fewer than the UTF-8 bytes
        using (Stream requestStream = webRequest.GetRequestStream())
        using (TextWriter tw = new StreamWriter(requestStream)) tw.Write(xml);
        HttpResponse httpResponse = (HttpResponse)webRequest.GetResponse();
        string answer;
        using (httpResponse) using (var sr = new StreamReader(httpResponse.GetResponseStream())) answer = sr.ReadToEnd();
        Eq(HttpStatusCode.OK, httpResponse.StatusCode, "StatusCode after dispose");
        Eq(xml, https.Last().BodyText, "whole UTF-8 body received");
        Check(answer.EndsWith(xml), "echo");
      } finally { Unregister(); }
    });

    Test("ELPODPI2/ENESCHOP: Create(string|Uri), POST text/xml, GetRequestStream/Close, (HttpResponse)GetResponse, StatusCode, Close", () => {
      var c = AcceptAll();
      foreach (var mk in new Func<HttpRequest>[] { () => c.Create(https.Base + "/echo"), () => c.Create(new Uri(https.Base + "/echo")) }) {
        HttpRequest req = mk();
        byte[] data = Encoding.UTF8.GetBytes("<Dotaz/>");
        req.Method = "POST"; req.ContentType = "text/xml"; req.ContentLength = data.Length;
        Stream st = req.GetRequestStream();
        st.Write(data, 0, data.Length);
        HttpResponse resp = (HttpResponse)req.GetResponse();
        string input = new StreamReader(resp.GetResponseStream()).ReadToEnd();
        Check(resp.StatusCode == HttpStatusCode.OK && input.EndsWith("<Dotaz/>"), "round trip");
        resp.Close();
        st.Close();
      }
    });

    Test("UctoMD/UctoDS2: new HttpRequest(Uri, creator); AllowAutoRedirect=false returns the 302 with Set-Cookie; Cookie header added", () => {
      var c = AcceptAll();
      var req = new HttpRequest(new Uri(https.Base + "/redirect"), c);
      req.ContentType = "text/xml;charset=\"utf-8\"";
      req.Method = "POST";
      req.Headers.Add("Authorization", "Basic " + Convert.ToBase64String(Encoding.ASCII.GetBytes("a:b")));
      req.ContentLength = 0L;
      req.AllowAutoRedirect = false;
      WebResponse resp = req.GetResponse();
      Eq(HttpStatusCode.Found, ((HttpResponse)resp).StatusCode, "302 returned, not followed");
      string cookie = resp.Headers.GetValues("Set-Cookie").FirstOrDefault();
      Check(cookie != null && cookie.StartsWith("sid=abc123"), "Set-Cookie: " + cookie);
      Eq("0", https.Last().Headers["Content-Length"], "empty POST sends Content-Length: 0");
      var req2 = new HttpRequest(new Uri(https.Base + "/echo"), c) { Headers = { { HttpRequestHeader.Cookie, cookie } } };
      ReadAll(req2.GetResponse());
      Eq(cookie, https.Last().Headers["Cookie"], "cookie sent");
      var req3 = new HttpRequest(new Uri(https.Base + "/redirect"), c);
      var text = ReadAll(req3.GetResponse());
      Check(text.StartsWith("GET /echo"), "redirect followed by default");
      Check(req3.Address.AbsolutePath == "/echo", "Address is the final URI");
    });

    Test("UctoDS RebexServices.UseRebex: Credentials; wrong password -> WebException whose message contains 401", () => {
      var c = AcceptAll();
      var ok = c.Create(https.Base + "/auth");
      ok.Credentials = new NetworkCredential("user", "pass");
      Eq("welcome", ReadAll(ok.GetResponse()), "authenticated");
      var bad = c.Create(https.Base + "/auth");
      bad.Credentials = new NetworkCredential("user", "wrong");
      var ex = Throws<WebException>(() => bad.GetResponse(), "401");
      Check(ex.Message.Contains("401"), "message: " + ex.Message);
    });

    Test("UctoApep CertificateHelper.DownloadFromUrl: new Rebex.Net.WebClient().DownloadFile (plain http)", () => {
      var file = Path.Combine(tmp, "crl.bin");
      new Rebex.Net.WebClient().DownloadFile(http.Base + "/file", file);
      var data = File.ReadAllBytes(file);
      Check(data.Length == 256 && data[255] == 255, "downloaded 256 bytes");
      using (var wc = new Rebex.Net.WebClient()) {
        Check(wc.DownloadString(http.Base + "/echo").StartsWith("GET /echo"), "DownloadString");
        var nv = new System.Collections.Specialized.NameValueCollection { { "a", "1 2" }, { "b", "ž" } };
        Encoding.UTF8.GetString(wc.UploadValues(http.Base + "/echo", nv));
        Eq("a=1+2&b=%C5%BE", http.Last().BodyText, "UploadValues body");
        Throws<WebException>(() => wc.DownloadData(http.Base + "/nothing"), "404 from WebClient");
      }
    });

    Test("async APM (BeginGetResponse/EndGetResponse) and GetResponseAsync", () => {
      var c = AcceptAll();
      var req = c.Create(https.Base + "/echo");
      var ar = req.BeginGetResponse(null, null);
      Check(ReadAll(req.EndGetResponse(ar)).StartsWith("GET /echo"), "APM");
      var req2 = c.Create(https.Base + "/ares/404");
      var ex = Throws<WebException>(() => req2.EndGetResponse(req2.BeginGetResponse(null, null)), "APM error");
      Check(ex.Response is HttpResponse, "APM error keeps HttpResponse");
      Check(ReadAll(c.Create(https.Base + "/echo").GetResponseAsync().Result).StartsWith("GET"), "Task");
    });
  }

  static void Unregister() {
    // Leave WebRequest.Create usable for the following tests: last registered creator accepts all.
    var c = AcceptAll(); c.Register();
  }

  static void RegisterLogTests() {
    Test("LogLevel/TlsVersion/CertificateStoreName values match the originals; UctoMD Enum.Parse/IsDefined by name", () => {
      Eq(10, (int)LogLevel.Verbose, "Verbose"); Eq(20, (int)LogLevel.Debug, "Debug"); Eq(30, (int)LogLevel.Info, "Info");
      Eq(40, (int)LogLevel.Error, "Error"); Eq(int.MaxValue, (int)LogLevel.Off, "Off");
      Eq(8, (int)TlsVersion.TLS12, "TLS12"); Eq(14, (int)TlsVersion.Any, "Any");
      Eq(5, (int)CertificateStoreName.My, "My");
      Check(Enum.IsDefined(typeof(LogLevel), "Debug") && !Enum.IsDefined(typeof(LogLevel), "Warn"), "names");
      Eq(LogLevel.Verbose, (LogLevel)Enum.Parse(typeof(LogLevel), "Verbose"), "parse");
    });

    Test("FileLogWriter: levels filter, Rebex-like lines, relative path (UctoMD 'RebexLogFile'), unwritable path does not throw", () => {
      var p = Path.Combine(tmp, "levels.log");
      var w = new FileLogWriter(p, LogLevel.Info);
      w.Write(LogLevel.Debug, typeof(HttpRequest), 1, "HTTP", "hidden");
      w.Write(LogLevel.Error, typeof(HttpRequest), 1, "HTTP", "shown");
      w.Write(LogLevel.Info, typeof(HttpRequest), 2, "TLS", "data", new byte[] { 0x41, 0x42, 0x00 }, 0, 3);
      var text = File.ReadAllText(p);
      Check(!text.Contains("hidden") && text.Contains("ERROR HttpRequest(1)[") && text.Contains("HTTP: shown"), text);
      Check(text.Contains(" 41 42 00") && text.Contains("AB."), "hex dump");
      Eq(p, w.Path, "Path");
      var off = Path.Combine(tmp, "off.log");
      new FileLogWriter(off, LogLevel.Off).Write(LogLevel.Error, null, 0, "x", "y");
      Check(!File.Exists(off) || !File.ReadAllText(off).Contains("x: y"), "Off writes nothing");
      new FileLogWriter("/nonexistent-dir/x/y.log", LogLevel.Debug).Write(LogLevel.Error, null, 0, "x", "y");
      var cwd = Environment.CurrentDirectory;
      try { Environment.CurrentDirectory = tmp; new FileLogWriter("RebexLogFile", LogLevel.Verbose); } finally { Environment.CurrentDirectory = cwd; }
      Check(File.Exists(Path.Combine(tmp, "RebexLogFile")), "relative log file");
      new FileLogWriter(tmp + "\\dos-style.log", LogLevel.Debug);
      Check(File.Exists(Path.Combine(tmp, "dos-style.log")), "backslash path converted");
    });
  }

  static byte[] SysEncrypt(byte[] content, X509Certificate2 recipient, string algOid, SysPkcs.SubjectIdentifierType idType) {
    var e = algOid == null ? new SysPkcs.EnvelopedCms(new SysPkcs.ContentInfo(content))
                           : new SysPkcs.EnvelopedCms(new SysPkcs.ContentInfo(content), new SysPkcs.AlgorithmIdentifier(new Oid(algOid)));
    e.Encrypt(new SysPkcs.CmsRecipient(idType, recipient));
    return e.Encode();
  }

  static void RegisterCmsTests() {
    RSA k;
    var pfxA = TestCerts.Pfx("CN=Uzivatel A, O=Ucto test, C=CZ", true, out k);
    var pfxB = TestCerts.Pfx("CN=Uzivatel B, O=Ucto test, C=CZ", false, out k);
    var certA = TestCerts.Load(pfxA);
    var certB = TestCerts.Load(pfxB);
    byte[] payload = Encoding.UTF8.GetBytes("<eNeschopenka>Příliš žluťoučký kůň úpěl ďábelské ódy</eNeschopenka>");

    Test("ENESCHOP PosliDotaz: EnvelopedData.Decode + CertificateFinder.CreateFinder(CertificateChain.LoadPfx) + Decrypt (3DES, AES-256, SKI)", () => {
      var pfxPath = TestCerts.Write(tmp, "eneschop.pfx", pfxA);
      foreach (var variant in new[] { Tuple.Create<string, SysPkcs.SubjectIdentifierType>(null, SysPkcs.SubjectIdentifierType.IssuerAndSerialNumber),
                                      Tuple.Create("2.16.840.1.101.3.4.1.42", SysPkcs.SubjectIdentifierType.IssuerAndSerialNumber),
                                      Tuple.Create("2.16.840.1.101.3.4.1.2", SysPkcs.SubjectIdentifierType.SubjectKeyIdentifier) }) {
        byte[] encodedMessage = SysEncrypt(payload, certA, variant.Item1, variant.Item2);
        EnvelopedData envelopedData = new EnvelopedData();
        envelopedData.CertificateFinder = CertificateFinder.CreateFinder(new[] { CertificateChain.LoadPfx(pfxPath, TestCerts.Password) });
        envelopedData.Decode(encodedMessage);
        envelopedData.Decrypt();
        byte[] decryptData = envelopedData.ContentInfo.ToArray();
        Check(decryptData.SequenceEqual(payload), "decrypted content (" + (variant.Item1 ?? "default") + ", " + variant.Item2 + ")");
        Eq("1.2.840.113549.1.7.1", envelopedData.ContentInfo.ContentType.Value, "content type");
        Check(!envelopedData.IsEncrypted, "IsEncrypted false after Decrypt");
      }
    });

    Test("UctoApep RebexDecrypt.GetDecryptedData: Certificate.LoadPfx + CertificateStore(My).Add + HasPrivateKey + Decrypt", () => {
      var pfxPath = TestCerts.Write(tmp, "apep.pfx", pfxA);
      byte[] data = SysEncrypt(payload, certA, null, SysPkcs.SubjectIdentifierType.IssuerAndSerialNumber);
      Certificate certificate = Certificate.LoadPfx(pfxPath, TestCerts.Password);
      Check(certificate.HasPrivateKey(), "LoadPfx keeps the private key");
      new CertificateStore(CertificateStoreName.My).Add(certificate);
      EnvelopedData envelopedData = new EnvelopedData();
      envelopedData.Decode(data);
      Check(envelopedData.HasPrivateKey, "HasPrivateKey via the default finder (My store)");
      envelopedData.Decrypt();
      Check(envelopedData.ContentInfo.ToArray().SequenceEqual(payload), "decrypted");
      Check(new CertificateStore(CertificateStoreName.My).Any(c => c.Thumbprint == certificate.Thumbprint), "store lists the added certificate");
    });

    Test("UctoApep/ENESCHOP error paths: no matching key -> HasPrivateKey false (helper throws CertificateException), Decrypt throws; bad password", () => {
      byte[] forB = SysEncrypt(payload, certB, null, SysPkcs.SubjectIdentifierType.IssuerAndSerialNumber);
      var ed = new EnvelopedData();
      ed.CertificateFinder = CertificateFinder.CreateFinder(new[] { CertificateChain.LoadPfx(pfxA, TestCerts.Password) });
      ed.Decode(forB);
      Check(!ed.HasPrivateKey, "no key for B");
      var ce = new CertificateException("Certifikát x neobsahuje privátní klíč.");
      Check(ce is CryptographicException, "CertificateException is a CryptographicException");
      Throws<CryptographicException>(() => ed.Decrypt(), "Decrypt without key");
      var bad = Throws<CertificateException>(() => CertificateChain.LoadPfx(pfxA, "spatne"), "bad password");
      Check(bad.Message.Length > 0, "message");
      Throws<CryptographicException>(() => new EnvelopedData().Decode(new byte[] { 1, 2, 3 }), "garbage");
    });

    Test("EnvelopedData.Encrypt (KeyTransRecipientInfo, issuer+serial and SKI) round trip, readable by System EnvelopedCms", () => {
      foreach (var idType in new[] { SubjectIdentifierType.IssuerAndSerialNumber, SubjectIdentifierType.SubjectKeyIdentifier }) {
        var ed = new EnvelopedData(new ContentInfo(payload));
        ed.RecipientInfos.Add(new KeyTransRecipientInfo(new Certificate(certA), idType));
        ed.RecipientInfos.Add(new KeyTransRecipientInfo(new Certificate(certB)));
        ed.Encrypt();
        byte[] enc = ed.Encode();
        Check(EnvelopedData.IsEnvelopedData(enc, 0, enc.Length) && !SignedData.IsSignedData(enc, 0, enc.Length), "IsEnvelopedData");
        var sys = new SysPkcs.EnvelopedCms(); sys.Decode(enc); sys.Decrypt(new X509Certificate2Collection(certB));
        Check(sys.ContentInfo.Content.SequenceEqual(payload), "System decrypt");
        Eq("2.16.840.1.101.3.4.1.42", sys.ContentEncryptionAlgorithm.Oid.Value, "AES-256 default");
        var back = new EnvelopedData { CertificateFinder = CertificateFinder.CreateFinder(new[] { new CertificateChain(new Certificate(certA)) }) };
        back.Decode(enc);
        Eq(2, back.RecipientInfos.Count, "recipients");
        Eq(idType, back.RecipientInfos[0].RecipientIdentifier.Type, "identifier type");
        back.Decrypt();
        Check(back.ContentInfo.ToArray().SequenceEqual(payload), "substitute decrypt");
        Eq(certA.Thumbprint, back.RecipientInfos.OfType<KeyTransRecipientInfo>().First(r => r.Certificate != null).Certificate.Thumbprint, "matched recipient certificate");
      }
      foreach (var alg in new[] { "1.2.840.113549.3.7", "2.16.840.1.101.3.4.1.2" }) {
        var ed = new EnvelopedData(new ContentInfo(payload), new Rebex.Security.Cryptography.ObjectIdentifier(alg));
        ed.RecipientInfos.Add(new KeyTransRecipientInfo(new Certificate(certB)));
        ed.Encrypt();
        var sys = new SysPkcs.EnvelopedCms(); sys.Decode(ed.Encode()); sys.Decrypt(new X509Certificate2Collection(certB));
        Check(sys.ContentInfo.Content.SequenceEqual(payload), "System decrypt " + alg);
        Eq(alg, sys.ContentEncryptionAlgorithm.Oid.Value, "algorithm");
      }
    });

    Test("SignedData: attached and detached sign / encode / decode / Validate; tampered content is invalid", () => {
      var sd = new SignedData(new ContentInfo(payload));
      sd.SignerInfos.Add(new SignerInfo(new Certificate(certA)));
      sd.Sign();
      byte[] enc = sd.Encode();
      Check(SignedData.IsSignedData(enc, 0, enc.Length), "IsSignedData");
      var dec = new SignedData(); dec.Decode(enc);
      Check(dec.ContentInfo.ToArray().SequenceEqual(payload), "content");
      Check(dec.Validate().Valid, "valid");
      Eq(certA.Thumbprint, dec.SignerInfos[0].Certificate.Thumbprint, "signer certificate");
      Check(Math.Abs((dec.SignerInfos[0].SigningTime - DateTime.Now).TotalMinutes) < 5, "signing time");
      var det = new SignedData(new ContentInfo(payload), true);
      det.SignerInfos.Add(new SignerInfo(new Certificate(certA)));
      det.Sign();
      var d2 = new SignedData(new ContentInfo(payload), true); d2.Decode(det.Encode());
      Check(d2.Validate().Valid, "detached valid");
      var tampered = (byte[])payload.Clone(); tampered[3] ^= 1;
      var d3 = new SignedData(new ContentInfo(tampered), true); d3.Decode(det.Encode());
      Check(!d3.Validate().Valid, "tampered invalid");
      var sys = new SysPkcs.SignedCms(); sys.Decode(enc); sys.CheckSignature(true);
    });

    Test("Certificate/CertificateChain/CertificateStore/DistinguishedName basics", () => {
      var c = Certificate.LoadPfx(pfxA, TestCerts.Password);
      Eq("Uzivatel A", c.GetCommonName(), "common name");
      Check(c.GetSubject().Equals(new DistinguishedName(c.GetSubjectName())), "DN equality");
      Check(c.GetSubjectKeyIdentifier() != null && c.GetSerialNumber().Length > 0, "SKI/serial");
      X509Certificate2 x = c; Certificate back = x;
      Eq(c.Thumbprint, back.Thumbprint, "implicit conversions");
      var der = Path.Combine(tmp, "a.cer"); c.Save(der);
      Eq(c.Thumbprint, Certificate.LoadDer(der).Thumbprint, "Save/LoadDer");
      var ch = CertificateChain.LoadPfx(pfxA, TestCerts.Password);
      Eq(1, ch.Count, "chain count"); Check(ch.LeafCertificate.HasPrivateKey(), "leaf has key");
      var mem = new CertificateStore(new[] { c });
      Eq(1, mem.FindCertificates(CertificateFindOptions.HasPrivateKey).Length, "memory store find");
      Eq("1.2.840.113549.1.7.3", Rebex.Security.Cryptography.ObjectIdentifier.Parse(new Rebex.Security.Cryptography.ObjectIdentifier("1.2.840.113549.1.7.3").ToArray()).Value, "OID DER round trip");
    });

    if (openssl) Test("openssl interop: openssl cms -encrypt (AES-256, RSA-OAEP) -> substitute Decrypt; substitute Encrypt -> openssl cms -decrypt", () => {
      var pem = Path.Combine(tmp, "a.pem"); File.WriteAllText(pem, TestCerts.ToPem(certA.RawData, "CERTIFICATE"));
      var pfxPath = TestCerts.Write(tmp, "ossl.pfx", pfxA);
      var key = Path.Combine(tmp, "a.key");
      Run("openssl", "pkcs12 -in " + pfxPath + " -passin pass:" + TestCerts.Password + " -nocerts -nodes -out " + key);
      var plain = TestCerts.Write(tmp, "plain.bin", payload);
      var enc = Path.Combine(tmp, "o.der");
      Run("openssl", "cms -encrypt -binary -in " + plain + " -outform DER -out " + enc + " -aes256 -recip " + pem + " -keyopt rsa_padding_mode:oaep");
      var ed = new EnvelopedData { CertificateFinder = CertificateFinder.CreateFinder(new[] { CertificateChain.LoadPfx(pfxPath, TestCerts.Password) }) };
      ed.Decode(File.ReadAllBytes(enc)); ed.Decrypt();
      Check(ed.ContentInfo.ToArray().SequenceEqual(payload), "openssl -> substitute");
      var mine = new EnvelopedData(new ContentInfo(payload));
      mine.RecipientInfos.Add(new KeyTransRecipientInfo(new Certificate(certA)));
      mine.Encrypt();
      var mineFile = TestCerts.Write(tmp, "mine.der", mine.Encode());
      var outFile = Path.Combine(tmp, "mine.out");
      Run("openssl", "cms -decrypt -binary -inform DER -in " + mineFile + " -recip " + pem + " -inkey " + key + " -out " + outFile);
      Check(File.ReadAllBytes(outFile).SequenceEqual(payload), "substitute -> openssl");
    });
  }

  static void Run(string exe, string args) {
    var p = Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false, RedirectStandardError = true, RedirectStandardOutput = true });
    string err = p.StandardError.ReadToEnd(); p.StandardOutput.ReadToEnd(); p.WaitForExit();
    if (p.ExitCode != 0) throw new Exception(exe + " " + args + " failed: " + err);
  }

  static void RegisterLiveTests() {
    Test("LIVE ARES (as Ares2): GET https://ares.gov.cz/.../00006947 with certificate validation, and the 404-style error JSON", () => {
      HttpRequestCreator c = new HttpRequestCreator();
      c.Settings.SslAllowedVersions = TlsVersion.TLS12;
      c.LogWriter = new FileLogWriter(Path.Combine(tmp, "ares.log"), LogLevel.Debug);
      string url = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/";
      WebResponse response = c.Create(url + "00006947").GetResponse();
      string text = new StreamReader(response.GetResponseStream()).ReadToEnd();
      response.Close();
      Check(text.Contains("\"ico\":\"00006947\""), "ARES JSON: " + text.Substring(0, Math.Min(200, text.Length)));
      Console.WriteLine("      ARES: " + System.Text.RegularExpressions.Regex.Match(text, "\"obchodniJmeno\":\"[^\"]*\"").Value);
      var ex = Throws<WebException>(() => c.Create(url + "00000001").GetResponse(), "unknown ICO");
      Check(ex.Response is HttpResponse, "error response is HttpResponse");
      string json = new StreamReader(ex.Response.GetResponseStream()).ReadToEnd();
      Check(json.Contains("\"kod\""), "ARES error JSON: " + json);
      Console.WriteLine("      ARES error " + (int)((HttpResponse)ex.Response).StatusCode + ": " + json);
    });
  }
}
