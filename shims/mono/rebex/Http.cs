// Rebex.Http substitute: HttpRequestCreator / HttpRequest / HttpResponse backed by Mono's
// HttpWebRequest, so TLS goes through Mono's own stack (btls on Linux/macOS).
//
// Behaviour kept from the original, because the helpers depend on it:
//  * HttpRequest derives from WebRequest, GetResponse() returns a Rebex.Net.HttpResponse
//    (ELDOTAZ/ELPODPI2/ENESCHOP/UctoMD cast to it);
//  * HTTP errors throw WebException(ProtocolError) whose Response is an HttpResponse with a
//    readable body (Ares2 reads ARES's JSON error) and whose message contains the status
//    code (UctoDS looks for "401");
//  * Headers is an unrestricted WebHeaderCollection: Content-Type, Connection and Expect may
//    be added directly (UctoApep's WCF channel does that);
//  * the request body is buffered, so the request stream need not be closed before
//    GetResponse (UctoZP2) and a ContentLength that counts characters instead of bytes
//    (ELDOTAZ/ELPODPI2) still sends the whole body;
//  * settings are read when the request is sent, so SslAcceptAllCertificates set after
//    Register() applies (Nepl2, UctoDS, UctoMD).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Security;
using System.Reflection;
using System.Security.Cryptography.X509Certificates;
using System.Threading;
using System.Threading.Tasks;
using Rebex;

namespace Rebex.Net {
  [Serializable]
  public class HttpSettings : SslSettings {
    public HttpSettings() { HttpSessionCacheEnabled = true; HttpSessionCacheTimeout = 60000; SslSessionCacheEnabled = true; }
    public bool HttpSessionCacheEnabled { get; set; }
    public int HttpSessionCacheTimeout { get; set; }
    public bool SslSessionCacheEnabled { get; set; }
  }

  public class HttpRequestCreator : IWebRequestCreate {
    static int nextId;
    readonly HttpSettings settings = new HttpSettings();
    readonly int id = Interlocked.Increment(ref nextId);

    public HttpRequestCreator() {}
    public HttpSettings Settings { get { return settings; } }
    public ILogWriter LogWriter { get; set; }

    /// Makes WebRequest.Create (and thus SOAP/WCF client proxies) use this creator for
    /// http:// and https://. The most recently registered creator wins.
    public void Register() {
      Dispatcher.Current = this;
      Dispatcher.EnsureRegistered();
      Log(LogLevel.Info, typeof(HttpRequestCreator), id, "HTTP", "Registered as the handler for http:// and https:// requests.");
    }

    public HttpRequest Create(Uri uri) { return new HttpRequest(uri, this); }
    public HttpRequest Create(string uri) {
      if (uri == null) throw new ArgumentNullException("uri");
      return Create(new Uri(uri));
    }
    WebRequest IWebRequestCreate.Create(Uri uri) { return Create(uri); }

    internal void Log(LogLevel level, Type type, int objectId, string area, string message) {
      var w = LogWriter;
      if (w == null) return;
      try { w.Write(level, type, objectId, area, message); } catch (Exception) {}
    }

    sealed class Dispatcher : IWebRequestCreate {
      internal static volatile HttpRequestCreator Current;
      static readonly object Sync = new object();
      static bool registered;
      internal static void EnsureRegistered() {
        lock (Sync) {
          if (registered) return;
          var d = new Dispatcher();
          WebRequest.RegisterPrefix("http://", d);
          WebRequest.RegisterPrefix("https://", d);
          registered = true;
        }
      }
      public WebRequest Create(Uri uri) { return (Current ?? new HttpRequestCreator()).Create(uri); }
    }
  }

  public class HttpRequest : WebRequest {
    static int nextId;
    static readonly ConstructorInfo HttpWebRequestCtor = typeof(HttpWebRequest).GetConstructor(
      BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance, null, new[] { typeof(Uri) }, null);

    readonly HttpRequestCreator creator;
    readonly Uri requestUri;
    readonly int id = Interlocked.Increment(ref nextId);
    WebHeaderCollection headers = new WebHeaderCollection();
    string method = "GET";
    long contentLength = -1;
    int timeout = 100000;
    MemoryStream body;
    HttpWebRequest inner;
    Uri address;
    volatile bool aborted;
    ICredentials credentials;
    IWebProxy proxy;
    bool proxySet;
#if REBEX6
    readonly List<long[]> ranges = new List<long[]>();
    readonly List<string> rangeUnits = new List<string>();
#endif

    public HttpRequest(Uri uri, HttpRequestCreator creator) {
      if (uri == null) throw new ArgumentNullException("uri");
      if (creator == null) throw new ArgumentNullException("creator");
      if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) throw new NotSupportedException("The URI prefix is not recognized.");
      requestUri = uri; address = uri; this.creator = creator;
      AllowAutoRedirect = true; AllowWriteStreamBuffering = true; MaximumAutomaticRedirections = 50; KeepAlive = true;
      ContinueTimeout = 350;
    }

    public bool AllowAutoRedirect { get; set; }
    public bool AllowWriteStreamBuffering { get; set; }
    public int MaximumAutomaticRedirections { get; set; }
#if REBEX6
    public CookieContainer CookieContainer { get; set; }
#endif
    public string Accept { get { return headers["Accept"]; } set { SetHeader("Accept", value); } }
    public string Connection { get { return headers["Connection"]; } set { SetHeader("Connection", value); } }
    public override string ContentType { get { return headers["Content-Type"]; } set { SetHeader("Content-Type", value); } }
    public override long ContentLength {
      get { return contentLength; }
      set { if (value < 0) throw new ArgumentOutOfRangeException("value"); contentLength = value; }
    }
    public bool SendChunked { get; set; }
    public string Expect { get { return headers["Expect"]; } set { SetHeader("Expect", value); } }
    public bool Expect100Continue { get; set; }
    public int ContinueTimeout { get; set; }
    public bool HaveResponse { get; private set; }
    public string IfModifiedSince { get { return headers["If-Modified-Since"]; } set { SetHeader("If-Modified-Since", value); } }
    public bool KeepAlive { get; set; }
    public override string Method {
      get { return method; }
      set { if (string.IsNullOrEmpty(value)) throw new ArgumentException("Method must not be empty.", "value"); method = value; }
    }
    public override WebHeaderCollection Headers {
      get { return headers; }
      set { if (value == null) throw new ArgumentNullException("value"); var h = new WebHeaderCollection(); foreach (string k in value.AllKeys) h.Add(k, value[k]); headers = h; }
    }
    public string Referer { get { return headers["Referer"]; } set { SetHeader("Referer", value); } }
    public Uri Address { get { return address; } }
    public override Uri RequestUri { get { return requestUri; } }
    public override int Timeout {
      get { return timeout; }
      set { if (value < 0 && value != System.Threading.Timeout.Infinite) throw new ArgumentOutOfRangeException("value"); timeout = value; }
    }
    public string TransferEncoding { get { return headers["Transfer-Encoding"]; } set { SetHeader("Transfer-Encoding", value); } }
    public override ICredentials Credentials { get { return credentials; } set { credentials = value; } }
    public override bool UseDefaultCredentials { get; set; }
    public override string ConnectionGroupName { get; set; }
    public override bool PreAuthenticate { get; set; }
    public string UserAgent { get { return headers["User-Agent"]; } set { SetHeader("User-Agent", value); } }
    public DecompressionMethods AutomaticDecompression { get; set; }
    /// Deviation: the original's Proxy is of type Rebex.Net.Proxy and hides WebRequest.Proxy;
    /// here the standard WebRequest.Proxy is honoured (SOAP proxies set it).
    public override IWebProxy Proxy { get { return proxySet ? proxy : WebRequest.DefaultWebProxy; } set { proxy = value; proxySet = true; } }

#if REBEX6
    public void AddRange(long range) { AddRange("bytes", range); }
    public void AddRange(string rangeSpecifier, long range) { rangeUnits.Add(rangeSpecifier); ranges.Add(new[] { range }); }
    public void AddRange(long from, long to) { AddRange("bytes", from, to); }
    public void AddRange(string rangeSpecifier, long from, long to) { rangeUnits.Add(rangeSpecifier); ranges.Add(new[] { from, to }); }
#endif

    void SetHeader(string name, string value) { if (string.IsNullOrEmpty(value)) headers.Remove(name); else headers[name] = value; }
    internal HttpRequestCreator Creator { get { return creator; } }
    internal int Id { get { return id; } }
    void Log(LogLevel level, string area, string message) { creator.Log(level, typeof(HttpRequest), id, area, message); }

    public override Stream GetRequestStream() {
      if (aborted) throw new WebException("The request was aborted.", WebExceptionStatus.RequestCanceled);
      if (HaveResponse) throw new InvalidOperationException("This operation cannot be performed after the request has been submitted.");
      string m = method.ToUpperInvariant();
      if (m == "GET" || m == "HEAD") throw new ProtocolViolationException("Cannot send a content-body with this verb-type.");
      if (body == null) body = new MemoryStream();
      return new BodyStream(body);
    }

    public override IAsyncResult BeginGetRequestStream(AsyncCallback callback, object state) {
      return Apm(Task.FromResult(0).ContinueWith(_ => GetRequestStream()), callback, state);
    }
    public override Stream EndGetRequestStream(IAsyncResult asyncResult) { return ((Task<Stream>)asyncResult).GetAwaiter().GetResult(); }
    public override Task<Stream> GetRequestStreamAsync() { return Task.FromResult(GetRequestStream()); }

    public override IAsyncResult BeginGetResponse(AsyncCallback callback, object state) {
      return Apm(Task.Factory.StartNew(() => GetResponse(), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default), callback, state);
    }
    public override WebResponse EndGetResponse(IAsyncResult asyncResult) { return ((Task<WebResponse>)asyncResult).GetAwaiter().GetResult(); }
    public override Task<WebResponse> GetResponseAsync() { return Task.Factory.StartNew(() => GetResponse(), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default); }

    public override void Abort() {
      aborted = true;
      var r = inner;
      if (r != null) try { r.Abort(); } catch (Exception) {}
    }

    public override WebResponse GetResponse() {
      if (aborted) throw new WebException("The request was aborted.", WebExceptionStatus.RequestCanceled);
      var req = BuildInner();
      Log(LogLevel.Info, "HTTP", string.Format("Sending request: {0} {1}", req.Method, requestUri));
      Log(LogLevel.Debug, "HTTP", "Request headers:\r\n" + req.Headers.ToString().TrimEnd());
      try {
        SendBody(req);
        var resp = (HttpWebResponse)req.GetResponse();
        HaveResponse = true;
        address = resp.ResponseUri ?? requestUri;
        Log(LogLevel.Info, "HTTP", string.Format("Received response: {0} {1}.", (int)resp.StatusCode, resp.StatusDescription));
        Log(LogLevel.Debug, "HTTP", "Response headers:\r\n" + resp.Headers.ToString().TrimEnd());
        return new HttpResponse(resp, method);
      } catch (WebException ex) {
        HaveResponse = ex.Response != null;
        var hr = ex.Response as HttpWebResponse;
        if (hr != null) {
          Log(LogLevel.Info, "HTTP", string.Format("Received response: {0} {1}.", (int)hr.StatusCode, hr.StatusDescription));
          throw new WebException(ex.Message, ex.InnerException, ex.Status, new HttpResponse(hr, method));
        }
        Log(LogLevel.Error, "HTTP", "Error while sending request: " + Describe(ex));
        throw;
      } catch (Exception ex) {
        Log(LogLevel.Error, "HTTP", "Error while sending request: " + Describe(ex));
        throw;
      }
    }

    static string Describe(Exception ex) {
      var parts = new List<string>();
      for (var e = ex; e != null; e = e.InnerException) parts.Add(e.GetType().Name + ": " + e.Message);
      return string.Join(" --> ", parts.ToArray());
    }

    HttpWebRequest BuildInner() {
      if (inner != null) throw new InvalidOperationException("This operation cannot be performed after the request has been submitted.");
      var s = creator.Settings;
      var sp = s.ToSecurityProtocol();
      if (sp.HasValue && ServicePointManager.SecurityProtocol != sp.Value) {
        try { ServicePointManager.SecurityProtocol = sp.Value; } catch (NotSupportedException) {}
      }
      // Bypass WebRequest.Create (it may dispatch back to us after Register()).
      var req = (HttpWebRequest)HttpWebRequestCtor.Invoke(new object[] { requestUri });
      req.Method = method;
      req.AllowAutoRedirect = AllowAutoRedirect;
      if (MaximumAutomaticRedirections > 0) req.MaximumAutomaticRedirections = MaximumAutomaticRedirections;
      req.AllowWriteStreamBuffering = true;
      req.Timeout = timeout;
      req.ReadWriteTimeout = timeout;
      req.KeepAlive = KeepAlive;
      if (UseDefaultCredentials) req.UseDefaultCredentials = true; // setting it (even to false) resets Credentials
      req.Credentials = credentials;
      req.PreAuthenticate = PreAuthenticate;
      if (ConnectionGroupName != null) req.ConnectionGroupName = ConnectionGroupName;
      req.AutomaticDecompression = AutomaticDecompression;
      if (proxySet) req.Proxy = proxy;
#if REBEX6
      if (CookieContainer != null) req.CookieContainer = CookieContainer;
      for (int i = 0; i < ranges.Count; i++) {
        if (ranges[i].Length == 1) req.AddRange(rangeUnits[i], ranges[i][0]); else req.AddRange(rangeUnits[i], ranges[i][0], ranges[i][1]);
      }
#endif
      bool expect100 = Expect100Continue;
      if (SendChunked) req.SendChunked = true;
      foreach (string name in headers.AllKeys) {
        string v = headers[name];
        switch (name.ToLowerInvariant()) {
          case "content-type": req.ContentType = v; break;
          case "content-length": break; // computed from the body
          case "accept": req.Accept = v; break;
          case "connection":
            if (v.Equals("keep-alive", StringComparison.OrdinalIgnoreCase)) req.KeepAlive = true;
            else if (v.Equals("close", StringComparison.OrdinalIgnoreCase)) req.KeepAlive = false;
            else req.Connection = v;
            break;
          case "expect":
            if (v.IndexOf("100-continue", StringComparison.OrdinalIgnoreCase) >= 0) expect100 = true; else req.Expect = v;
            break;
          case "referer": req.Referer = v; break;
          case "user-agent": req.UserAgent = v; break;
          case "transfer-encoding":
            req.SendChunked = true;
            if (!v.Equals("chunked", StringComparison.OrdinalIgnoreCase)) req.TransferEncoding = v;
            break;
          case "if-modified-since":
            DateTime d;
            if (DateTime.TryParse(v, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out d)) req.IfModifiedSince = d;
            break;
          case "date":
            DateTime dd;
            if (DateTime.TryParse(v, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out dd)) req.Date = dd;
            break;
          case "host": req.Host = v; break;
          default: AddRaw(req.Headers, name, v); break;
        }
      }
      try { req.ServicePoint.Expect100Continue = expect100; } catch (Exception) {}
      bool acceptAll = s.SslAcceptAllCertificates;
      req.ServerCertificateValidationCallback = (sender, cert, chain, errors) => {
        bool ok = acceptAll || errors == SslPolicyErrors.None;
        Log(LogLevel.Debug, "TLS", string.Format("Server certificate: {0}; issuer: {1}; errors: {2}; {3}.",
          cert == null ? "(none)" : cert.Subject, cert == null ? "" : cert.Issuer, errors,
          ok ? (errors == SslPolicyErrors.None ? "accepted" : "accepted (SslAcceptAllCertificates)") : "rejected"));
        return ok;
      };
      inner = req;
      if (aborted) req.Abort();
      return req;
    }

    static readonly MethodInfo AddWithoutValidate = typeof(WebHeaderCollection).GetMethod("AddWithoutValidate", BindingFlags.NonPublic | BindingFlags.Instance, null, new[] { typeof(string), typeof(string) }, null);
    static void AddRaw(WebHeaderCollection h, string name, string value) {
      try { h.Add(name, value); }
      catch (ArgumentException) { if (AddWithoutValidate != null) AddWithoutValidate.Invoke(h, new object[] { name, value }); else throw; }
    }

    void SendBody(HttpWebRequest req) {
      string m = method.ToUpperInvariant();
      if (m == "GET" || m == "HEAD") return;
      byte[] data = body == null ? null : body.ToArray();
      if (data == null) {
        if (contentLength < 0) return;
        data = new byte[0];
      }
      if (contentLength >= 0 && contentLength != data.Length)
        Log(LogLevel.Debug, "HTTP", string.Format("ContentLength was set to {0} but {1} bytes were written; sending {1} bytes.", contentLength, data.Length));
      if (!req.SendChunked) req.ContentLength = data.Length;
      Log(LogLevel.Verbose, "HTTP", string.Format("Sending {0} bytes of request body.", data.Length));
      using (var rs = req.GetRequestStream()) rs.Write(data, 0, data.Length);
    }

    static IAsyncResult Apm<T>(Task<T> task, AsyncCallback callback, object state) {
      var tcs = new TaskCompletionSource<T>(state);
      task.ContinueWith(t => {
        if (t.IsFaulted) tcs.TrySetException(t.Exception.InnerExceptions);
        else if (t.IsCanceled) tcs.TrySetCanceled();
        else tcs.TrySetResult(t.Result);
        if (callback != null) callback(tcs.Task);
      }, TaskScheduler.Default);
      return tcs.Task;
    }

    /// Request body buffer; closing it does not discard the data.
    sealed class BodyStream : Stream {
      readonly MemoryStream ms;
      public BodyStream(MemoryStream ms) { this.ms = ms; }
      public override bool CanRead { get { return false; } }
      public override bool CanSeek { get { return false; } }
      public override bool CanWrite { get { return true; } }
      public override long Length { get { return ms.Length; } }
      public override long Position { get { return ms.Length; } set { throw new NotSupportedException(); } }
      public override void Flush() {}
      public override int Read(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
      public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
      public override void SetLength(long value) { throw new NotSupportedException(); }
      public override void Write(byte[] buffer, int offset, int count) { ms.Seek(0, SeekOrigin.End); ms.Write(buffer, offset, count); }
    }
  }

  public class HttpResponse : WebResponse {
    readonly HttpWebResponse inner;
    readonly string method;
    internal HttpResponse(HttpWebResponse inner, string method) { this.inner = inner; this.method = method; }

    public override long ContentLength { get { return inner.ContentLength; } }
    public override string ContentType { get { return inner.ContentType ?? ""; } }
    public override WebHeaderCollection Headers { get { return inner.Headers; } }
#if REBEX6
    public CookieCollection Cookies { get { return inner.Cookies; } }
    public DateTime LastModified { get { return inner.LastModified; } }
#endif
    public Version ProtocolVersion { get { return inner.ProtocolVersion; } }
    public override Uri ResponseUri { get { return inner.ResponseUri; } }
    public string Server { get { return inner.Server; } }
    public override Stream GetResponseStream() { return inner.GetResponseStream(); }
    public HttpStatusCode StatusCode { get { return inner.StatusCode; } }
    public string StatusDescription { get { return inner.StatusDescription; } }
    public string CharacterSet { get { return inner.CharacterSet; } }
    public string ContentEncoding { get { return inner.ContentEncoding; } }
    public string Method { get { return method; } }
    public override bool SupportsHeaders { get { return true; } }
    public override void Close() { inner.Close(); }
  }
}
