// Rebex.Net.WebClient substitute (part of Rebex.Http): the System.Net.WebClient-like
// convenience API on top of HttpRequestCreator/HttpRequest. UctoApep uses DownloadFile.
using System;
using System.Collections.Specialized;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using Rebex;

namespace Rebex.Net {
  public class WebClient : IDisposable {
    readonly HttpRequestCreator creator;
    HttpRequest current;
    WebHeaderCollection headers = new WebHeaderCollection();

    public WebClient() : this(new HttpRequestCreator()) {}
    protected WebClient(HttpRequestCreator creator) {
      if (creator == null) throw new ArgumentNullException("creator");
      this.creator = creator;
      Timeout = 60000;
      Encoding = Encoding.UTF8;
    }

    public int Timeout { get; set; }
    public ILogWriter LogWriter { get { return creator.LogWriter; } set { creator.LogWriter = value; } }
    public string BaseAddress { get; set; }
    public WebHeaderCollection Headers { get { return headers; } set { headers = value ?? new WebHeaderCollection(); } }
    public WebHeaderCollection ResponseHeaders { get; private set; }
    public ICredentials Credentials { get; set; }
    public HttpSettings Settings { get { return creator.Settings; } }
    public Encoding Encoding { get; set; }

    Uri Resolve(string address) {
      if (address == null) throw new ArgumentNullException("address");
      Uri u;
      if (!string.IsNullOrEmpty(BaseAddress) && !Uri.TryCreate(address, UriKind.Absolute, out u)) return new Uri(new Uri(BaseAddress), address);
      return new Uri(address);
    }
    Uri Resolve(Uri address) {
      if (address == null) throw new ArgumentNullException("address");
      return address.IsAbsoluteUri || string.IsNullOrEmpty(BaseAddress) ? address : new Uri(new Uri(BaseAddress), address);
    }

    HttpResponse Send(Uri uri, string method, byte[] data, string contentType) {
      var req = creator.Create(uri);
      current = req;
      req.Method = method;
      req.Timeout = Timeout;
      if (Credentials != null) req.Credentials = Credentials;
      foreach (string k in headers.AllKeys) req.Headers[k] = headers[k];
      if (contentType != null && string.IsNullOrEmpty(req.ContentType)) req.ContentType = contentType;
      if (data != null) {
        req.ContentLength = data.Length;
        using (var s = req.GetRequestStream()) s.Write(data, 0, data.Length);
      }
      try {
        var resp = (HttpResponse)req.GetResponse();
        ResponseHeaders = resp.Headers;
        return resp;
      } catch (WebException ex) {
        if (ex.Response != null) ResponseHeaders = ex.Response.Headers;
        throw;
      } finally { current = null; }
    }

    static byte[] ReadAll(HttpResponse r) {
      using (r) using (var s = r.GetResponseStream()) { var ms = new MemoryStream(); s.CopyTo(ms); return ms.ToArray(); }
    }
    string Decode(byte[] data) {
      var ct = ResponseHeaders == null ? null : ResponseHeaders["Content-Type"];
      var enc = Encoding;
      if (ct != null) {
        var cs = ct.Split(';').Select(p => p.Trim()).FirstOrDefault(p => p.StartsWith("charset=", StringComparison.OrdinalIgnoreCase));
        if (cs != null) try { enc = Encoding.GetEncoding(cs.Substring(8).Trim('"', '\'')); } catch (Exception) {}
      }
      return enc.GetString(data);
    }

    public Stream OpenRead(string address) { return OpenRead(Resolve(address)); }
    public Stream OpenRead(Uri address) {
      var r = Send(Resolve(address), "GET", null, null);
      return new MemoryStream(ReadAll(r));
    }
    public WebHeaderCollection GetHeaders(string address) { return GetHeaders(Resolve(address)); }
    public WebHeaderCollection GetHeaders(Uri address) { using (var r = Send(Resolve(address), "HEAD", null, null)) return r.Headers; }
    public byte[] DownloadData(string address) { return DownloadData(Resolve(address)); }
    public byte[] DownloadData(Uri address) { return ReadAll(Send(Resolve(address), "GET", null, null)); }
    public string DownloadString(string address) { return DownloadString(Resolve(address)); }
    public string DownloadString(Uri address) { return Decode(DownloadData(address)); }
    public void DownloadFile(string address, string fileName) { DownloadFile(Resolve(address), fileName); }
    public void DownloadFile(Uri address, string fileName) {
      if (fileName == null) throw new ArgumentNullException("fileName");
      var data = DownloadData(address);
      File.WriteAllBytes(Util.FixPath(fileName), data);
    }

    public byte[] UploadData(string address, byte[] data) { return UploadData(Resolve(address), "POST", data); }
    public byte[] UploadData(Uri address, byte[] data) { return UploadData(address, "POST", data); }
    public byte[] UploadData(string address, string method, byte[] data) { return UploadData(Resolve(address), method, data); }
    public byte[] UploadData(Uri address, string method, byte[] data) {
      if (data == null) throw new ArgumentNullException("data");
      return ReadAll(Send(Resolve(address), method ?? "POST", data, "application/octet-stream"));
    }
    public string UploadString(string address, string data) { return UploadString(Resolve(address), "POST", data); }
    public string UploadString(Uri address, string data) { return UploadString(address, "POST", data); }
    public string UploadString(string address, string method, string data) { return UploadString(Resolve(address), method, data); }
    public string UploadString(Uri address, string method, string data) {
      if (data == null) throw new ArgumentNullException("data");
      return Decode(ReadAll(Send(Resolve(address), method ?? "POST", Encoding.GetBytes(data), "text/plain; charset=" + Encoding.WebName)));
    }
    public byte[] UploadFile(string address, string fileName) { return UploadFile(Resolve(address), "POST", fileName); }
    public byte[] UploadFile(Uri address, string fileName) { return UploadFile(address, "POST", fileName); }
    public byte[] UploadFile(string address, string method, string fileName) { return UploadFile(Resolve(address), method, fileName); }
    public byte[] UploadFile(Uri address, string method, string fileName) {
      if (fileName == null) throw new ArgumentNullException("fileName");
      string boundary = "---------------------" + DateTime.Now.Ticks.ToString("x");
      var ms = new MemoryStream();
      var head = Encoding.UTF8.GetBytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + Path.GetFileName(fileName) + "\"\r\nContent-Type: application/octet-stream\r\n\r\n");
      ms.Write(head, 0, head.Length);
      var file = File.ReadAllBytes(Util.FixPath(fileName));
      ms.Write(file, 0, file.Length);
      var tail = Encoding.UTF8.GetBytes("\r\n--" + boundary + "--\r\n");
      ms.Write(tail, 0, tail.Length);
      return ReadAll(Send(Resolve(address), method ?? "POST", ms.ToArray(), "multipart/form-data; boundary=" + boundary));
    }
    public byte[] UploadValues(string address, NameValueCollection data) { return UploadValues(Resolve(address), "POST", data); }
    public byte[] UploadValues(Uri address, NameValueCollection data) { return UploadValues(address, "POST", data); }
    public byte[] UploadValues(string address, string method, NameValueCollection data) { return UploadValues(Resolve(address), method, data); }
    public byte[] UploadValues(Uri address, string method, NameValueCollection data) {
      if (data == null) throw new ArgumentNullException("data");
      var body = string.Join("&", data.AllKeys.Select(k => FormEncode(k) + "=" + FormEncode(data[k])).ToArray());
      return ReadAll(Send(Resolve(address), method ?? "POST", Encoding.ASCII.GetBytes(body), "application/x-www-form-urlencoded"));
    }

    static string FormEncode(string s) { return s == null ? "" : Uri.EscapeDataString(s).Replace("%20", "+"); }

    public void Cancel() { var r = current; if (r != null) r.Abort(); }
    public void Dispose() { Cancel(); }
  }
}
