// Minimal HTTP/1.1 test server (plain or TLS via SslStream with a self-signed certificate)
// with the endpoints the tests need. One request per connection ("Connection: close").
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

class Recorded {
  public string Method, Path, Version;
  public Dictionary<string, string> Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
  public byte[] Body = new byte[0];
  public bool SentContinue;
  public string BodyText { get { return Encoding.UTF8.GetString(Body); } }
}

class TestServer : IDisposable {
  readonly TcpListener listener;
  readonly X509Certificate2 cert;
  readonly Thread thread;
  volatile bool stop;
  public readonly ConcurrentQueue<Recorded> Requests = new ConcurrentQueue<Recorded>();
  public int Port { get { return ((IPEndPoint)listener.LocalEndpoint).Port; } }
  public string Base { get { return (cert != null ? "https" : "http") + "://127.0.0.1:" + Port; } }

  public TestServer(X509Certificate2 cert) {
    this.cert = cert;
    listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    thread = new Thread(Loop) { IsBackground = true };
    thread.Start();
  }

  public Recorded Last() { Recorded r = null; foreach (var x in Requests) r = x; return r; }
  public void Clear() { Recorded r; while (Requests.TryDequeue(out r)) {} }

  void Loop() {
    while (!stop) {
      TcpClient c;
      try { c = listener.AcceptTcpClient(); } catch (Exception) { return; }
      ThreadPool.QueueUserWorkItem(_ => Handle(c));
    }
  }

  void Handle(TcpClient client) {
    try {
      using (client) {
        Stream s = client.GetStream();
        if (cert != null) {
          var ssl = new SslStream(s, false);
          try { ssl.AuthenticateAsServer(cert, false, SslProtocols.Tls12 | SslProtocols.Tls11 | SslProtocols.Tls, false); }
          catch (Exception) { return; } // client rejected our certificate
          s = ssl;
        }
        var r = ReadRequest(s);
        if (r == null) return;
        Requests.Enqueue(r);
        Respond(s, r);
      }
    } catch (Exception ex) { Console.Error.WriteLine("server: " + ex.Message); }
  }

  static string ReadLine(Stream s) {
    var sb = new StringBuilder();
    int b;
    while ((b = s.ReadByte()) >= 0) { if (b == '\n') break; if (b != '\r') sb.Append((char)b); }
    return b < 0 && sb.Length == 0 ? null : sb.ToString();
  }

  Recorded ReadRequest(Stream s) {
    var line = ReadLine(s);
    if (string.IsNullOrEmpty(line)) return null;
    var p = line.Split(' ');
    var r = new Recorded { Method = p[0], Path = p[1], Version = p.Length > 2 ? p[2] : "" };
    string h;
    while (!string.IsNullOrEmpty(h = ReadLine(s))) {
      int i = h.IndexOf(':');
      string k = h.Substring(0, i).Trim(), v = h.Substring(i + 1).Trim();
      r.Headers[k] = r.Headers.ContainsKey(k) ? r.Headers[k] + ", " + v : v;
    }
    string exp;
    if (r.Headers.TryGetValue("Expect", out exp) && exp.IndexOf("100-continue", StringComparison.OrdinalIgnoreCase) >= 0) {
      var c = Encoding.ASCII.GetBytes("HTTP/1.1 100 Continue\r\n\r\n"); s.Write(c, 0, c.Length); s.Flush(); r.SentContinue = true;
    }
    string cl, te;
    var body = new MemoryStream();
    if (r.Headers.TryGetValue("Transfer-Encoding", out te) && te.Contains("chunked")) {
      while (true) {
        int n = Convert.ToInt32(ReadLine(s).Split(';')[0].Trim(), 16);
        if (n == 0) { ReadLine(s); break; }
        var buf = ReadExactly(s, n); body.Write(buf, 0, n); ReadLine(s);
      }
    } else if (r.Headers.TryGetValue("Content-Length", out cl)) {
      int n = int.Parse(cl); var buf = ReadExactly(s, n); body.Write(buf, 0, n);
    }
    r.Body = body.ToArray();
    return r;
  }

  static byte[] ReadExactly(Stream s, int n) {
    var buf = new byte[n]; int got = 0;
    while (got < n) { int k = s.Read(buf, got, n - got); if (k <= 0) break; got += k; }
    return buf;
  }

  static void Send(Stream s, int code, string reason, string contentType, byte[] body, params string[] extraHeaders) {
    var sb = new StringBuilder();
    sb.Append("HTTP/1.1 ").Append(code).Append(' ').Append(reason).Append("\r\n");
    sb.Append("Server: RebexShimTest\r\n");
    if (contentType != null) sb.Append("Content-Type: ").Append(contentType).Append("\r\n");
    sb.Append("Content-Length: ").Append(body.Length).Append("\r\n");
    foreach (var e in extraHeaders) sb.Append(e).Append("\r\n");
    sb.Append("Connection: close\r\n\r\n");
    var head = Encoding.ASCII.GetBytes(sb.ToString());
    s.Write(head, 0, head.Length);
    s.Write(body, 0, body.Length);
    s.Flush();
  }

  void Respond(Stream s, Recorded r) {
    var path = r.Path.Split('?')[0];
    switch (path) {
      case "/echo": {
        var text = new StringBuilder();
        text.Append(r.Method).Append(' ').Append(r.Path).Append('\n');
        foreach (var kv in r.Headers) text.Append(kv.Key).Append(": ").Append(kv.Value).Append('\n');
        text.Append('\n').Append(r.BodyText);
        Send(s, 200, "OK", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes(text.ToString()));
        break;
      }
      case "/ares/404":
        Send(s, 404, "Not Found", "application/json", Encoding.UTF8.GetBytes("{\"kod\":\"NENALEZENO\",\"subKod\":\"VYSTUP_SUBJEKT_NENALEZEN\",\"popis\":\"Ekonomický subjekt nenalezen.\"}"));
        break;
      case "/auth": {
        string a;
        if (r.Headers.TryGetValue("Authorization", out a) && a == "Basic " + Convert.ToBase64String(Encoding.ASCII.GetBytes("user:pass")))
          Send(s, 200, "OK", "text/plain", Encoding.ASCII.GetBytes("welcome"));
        else Send(s, 401, "Unauthorized", "text/plain", Encoding.ASCII.GetBytes("no"), "WWW-Authenticate: Basic realm=\"test\"");
        break;
      }
      case "/redirect":
        Send(s, 302, "Found", "text/plain", Encoding.ASCII.GetBytes("moved"), "Location: /echo", "Set-Cookie: sid=abc123; path=/");
        break;
      case "/file": {
        var data = Enumerable.Range(0, 256).Select(i => (byte)i).ToArray();
        Send(s, 200, "OK", "application/octet-stream", data);
        break;
      }
      case "/soap": {
        var m = Regex.Match(r.BodyText, "<text>(.*?)</text>");
        var xml = "<?xml version=\"1.0\" encoding=\"utf-8\"?><soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\"><soap:Body>"
          + "<echoResponse xmlns=\"urn:rebex-test\"><echoResult>ECHO:" + m.Groups[1].Value + "</echoResult></echoResponse></soap:Body></soap:Envelope>";
        Send(s, 200, "OK", "text/xml; charset=utf-8", Encoding.UTF8.GetBytes(xml));
        break;
      }
      case "/soapfault": {
        var xml = "<?xml version=\"1.0\" encoding=\"utf-8\"?><soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\"><soap:Body>"
          + "<soap:Fault><faultcode>soap:Server</faultcode><faultstring>Chyba sluzby</faultstring></soap:Fault></soap:Body></soap:Envelope>";
        Send(s, 500, "Internal Server Error", "text/xml; charset=utf-8", Encoding.UTF8.GetBytes(xml));
        break;
      }
      default:
        Send(s, 404, "Not Found", "text/plain", Encoding.ASCII.GetBytes("unknown path"));
        break;
    }
  }

  public void Dispose() { stop = true; try { listener.Stop(); } catch (Exception) {} }
}
