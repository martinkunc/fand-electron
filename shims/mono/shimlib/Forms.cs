// System.Windows.Forms.WebBrowser substitute. Mono's WebBrowser needs a Gecko engine that
// no current system has, so the preview forms of UctoDS2, UctoApep and UctoZP2 would stay
// blank or crash. The patcher redirects the helper's WebBrowser references here: the page
// opens in the system browser (Navigate: the file/URL; DocumentText: a temporary .html),
// and the control itself shows the page as plain text plus a link to open it again, so the
// rest of the form keeps working.
using System;
using System.ComponentModel;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace UctoShim.Forms {
  /// File dialogs: paths the user picks go back to Účto as DOS paths (X:\... for a
  /// $UCTO_DRIVE_X root); paths the helper presets are mapped to host paths.
  public static class Dialogs {
    public static string GetFileName(FileDialog d) { return PathFix.ToDos(d.FileName); }
    public static string[] GetFileNames(FileDialog d) { var n = d.FileNames; return n == null ? null : Array.ConvertAll(n, PathFix.ToDos); }
    public static void SetFileName(FileDialog d, string value) { d.FileName = HostName(value); }
    public static void SetInitialDirectory(FileDialog d, string value) { d.InitialDirectory = PathFix.Fix(value); }
    public static string GetSelectedPath(FolderBrowserDialog d) { return PathFix.ToDos(d.SelectedPath); }
    public static void SetSelectedPath(FolderBrowserDialog d, string value) { d.SelectedPath = PathFix.Fix(value); }
    /// Called before every MessageBox.Show of a patched helper: logs the message to stderr
    /// and, when $UCTO_MESSAGEBOX is "stderr" (unattended runs, tests) or a DialogResult
    /// number, answers without showing the box (stderr = OK). Returns -1 to show it.
    public static int MessageLog(string text, string caption) {
      Console.Error.WriteLine("MessageBox [" + caption + "]: " + (text ?? "").Replace("\r", "").Replace("\n", " | "));
      var mode = Environment.GetEnvironmentVariable("UCTO_MESSAGEBOX");
      if (string.IsNullOrEmpty(mode)) return -1;
      if (mode == "stderr") return (int)DialogResult.OK;
      int r; return int.TryParse(mode, out r) ? r : -1;
    }

    static string HostName(string v) {
      if (string.IsNullOrEmpty(v) || (v.IndexOf('\\') < 0 && v.IndexOf(':') < 0)) return v;
      return PathFix.Fix(v);
    }
  }

  public class WebBrowser : Panel {
    readonly LinkLabel link;
    readonly TextBox text;
    string target;          // what the link opens: a file path or URL
    string documentText = "";
    Uri url;

    public WebBrowser() {
      link = new LinkLabel { Dock = DockStyle.Top, Height = 24, TextAlign = ContentAlignment.MiddleLeft, Text = "", Visible = false };
      link.LinkClicked += (s, e) => OpenTarget();
      text = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = true, BackColor = SystemColors.Window };
      Controls.Add(text);
      Controls.Add(link);
      AllowNavigation = true; ScrollBarsEnabled = true; IsWebBrowserContextMenuEnabled = true; WebBrowserShortcutsEnabled = true;
    }

    // Properties the helpers set; kept for API compatibility.
    public bool AllowNavigation { get; set; }
    public bool AllowWebBrowserDrop { get; set; }
    public bool IsWebBrowserContextMenuEnabled { get; set; }
    public bool ScriptErrorsSuppressed { get; set; }
    public bool ScrollBarsEnabled { get; set; }
    public bool WebBrowserShortcutsEnabled { get; set; }
    public object ObjectForScripting { get; set; }
    public bool CanGoBack { get { return false; } }
    public bool CanGoForward { get { return false; } }
    public bool IsBusy { get { return false; } }
    public WebBrowserReadyState ReadyState { get { return WebBrowserReadyState.Complete; } }
    public string DocumentTitle { get; private set; }
    public string StatusText { get { return ""; } }
    public HtmlDocument Document { get { return null; } }
    public string DocumentType { get { return "HTML Document"; } }

    public event WebBrowserDocumentCompletedEventHandler DocumentCompleted;
    public event WebBrowserNavigatedEventHandler Navigated;
    public event WebBrowserNavigatingEventHandler Navigating;
    public event EventHandler DocumentTitleChanged;
    public event EventHandler StatusTextChanged;
    public event CancelEventHandler NewWindow;

    [Browsable(false)]
    public Uri Url {
      get { return url; }
      set { if (value == null) return; if (value.IsFile) Navigate(value.LocalPath); else Navigate(value.AbsoluteUri); }
    }

    public string DocumentText {
      get { return documentText; }
      set {
        documentText = value ?? "";
        if (documentText.Length == 0) { Show(null, ""); return; }
        string dir = Path.Combine(Path.GetTempPath(), "ucto-preview");
        Directory.CreateDirectory(dir);
        string file = Path.Combine(dir, "nahled-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".html");
        File.WriteAllText(file, documentText, new UTF8Encoding(true));   // the BOM wins over a <meta charset>
        url = new Uri("about:blank");
        Show(file, documentText);
        Completed();
      }
    }

    public Stream DocumentStream {
      get { return new MemoryStream(Encoding.UTF8.GetBytes(documentText)); }
      set { if (value == null) return; using (var r = new StreamReader(value, Encoding.UTF8, true)) DocumentText = r.ReadToEnd(); }
    }

    public void Navigate(Uri u) { Url = u; }
    public void Navigate(string urlString) {
      if (string.IsNullOrEmpty(urlString) || urlString.Equals("about:blank", StringComparison.OrdinalIgnoreCase)) { Show(null, ""); return; }
      bool web = Regex.IsMatch(urlString, "^[a-zA-Z][a-zA-Z0-9+.-]+://") && !urlString.StartsWith("file:", StringComparison.OrdinalIgnoreCase);
      if (Navigating != null) {
        var ev = new WebBrowserNavigatingEventArgs(SafeUri(urlString), "");
        Navigating(this, ev);
        if (ev.Cancel) return;
      }
      if (web) {
        url = SafeUri(urlString);
        documentText = "";
        Show(urlString, urlString);
      } else {
        string p = urlString.StartsWith("file:", StringComparison.OrdinalIgnoreCase) ? new Uri(urlString).LocalPath : urlString;
        p = PathFix.Fix(p);
        try { p = Path.GetFullPath(p); } catch (Exception) { }
        url = SafeUri(p);
        documentText = File.Exists(p) ? ReadHtml(p) : "";
        Show(p, File.Exists(p) ? documentText : "Soubor " + urlString + " nebyl nalezen.");
      }
      if (Navigated != null) Navigated(this, new WebBrowserNavigatedEventArgs(url));
      Completed();
    }
    public void Navigate(string urlString, bool newWindow) { Navigate(urlString); }
    public void Navigate(string urlString, string targetFrameName) { Navigate(urlString); }

    public bool GoBack() { return false; }
    public bool GoForward() { return false; }
    public void GoHome() { }
    public void GoSearch() { }
    public void Stop() { }
    public override void Refresh() { base.Refresh(); }
    public void Refresh(WebBrowserRefreshOption opt) { }
    /// Printing happens in the browser: open the page there.
    public void Print() { OpenTarget(); }
    public void ShowPrintDialog() { OpenTarget(); }
    public void ShowPrintPreviewDialog() { OpenTarget(); }
    public void ShowPageSetupDialog() { }
    public void ShowPropertiesDialog() { }
    public void ShowSaveAsDialog() { OpenTarget(); }

    static Uri SafeUri(string s) { try { return new Uri(s); } catch (Exception) { return new Uri("about:blank"); } }

    void Completed() {
      if (DocumentCompleted != null) DocumentCompleted(this, new WebBrowserDocumentCompletedEventArgs(url));
    }

    void Show(string openTarget, string html) {
      target = openTarget;
      var title = Regex.Match(html ?? "", @"<title[^>]*>(.*?)</title>", RegexOptions.IgnoreCase | RegexOptions.Singleline);
      DocumentTitle = title.Success ? WebUtility.HtmlDecode(title.Groups[1].Value).Trim() : "";
      if (DocumentTitleChanged != null) DocumentTitleChanged(this, EventArgs.Empty);
      text.Text = ToPlainText(html ?? "");
      link.Visible = target != null;
      link.Text = target == null ? "" : "Obsah byl otevřen ve webovém prohlížeči. Otevřít znovu";
      if (target != null) OpenTarget();
    }

    void OpenTarget() {
      if (target == null) return;
      try { Os.Open(target); }
      catch (Exception e) { text.Text = "Prohlížeč nelze spustit: " + e.Message + "\r\n\r\n" + text.Text; }
    }

    static string ReadHtml(string path) {
      var bytes = File.ReadAllBytes(path);
      // Honour a BOM, else a declared charset, else UTF-8 when valid, else CP1250.
      if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) return Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3);
      string ascii = Encoding.ASCII.GetString(bytes, 0, Math.Min(bytes.Length, 2048));
      var m = Regex.Match(ascii, @"charset\s*=\s*[""']?([A-Za-z0-9_-]+)", RegexOptions.IgnoreCase);
      if (m.Success) { try { return Encoding.GetEncoding(m.Groups[1].Value).GetString(bytes); } catch (Exception) { } }
      try { return new UTF8Encoding(false, true).GetString(bytes); }
      catch (DecoderFallbackException) { return Encoding.GetEncoding(1250).GetString(bytes); }
    }

    /// Readable text of an HTML page for the in-form fallback view.
    public static string ToPlainText(string html) {
      if (string.IsNullOrEmpty(html)) return "";
      if (html.IndexOf('<') < 0) return html;
      string s = Regex.Replace(html, @"<(script|style|head)[^>]*>.*?</\1\s*>", "", RegexOptions.IgnoreCase | RegexOptions.Singleline);
      s = Regex.Replace(s, @"<!--.*?-->", "", RegexOptions.Singleline);
      s = Regex.Replace(s, @"\s+", " ");
      s = Regex.Replace(s, @"<\s*(br|/p|/div|/tr|/h[1-6]|/li|/table|p|div|tr|h[1-6]|li|table)\b[^>]*>", "\r\n", RegexOptions.IgnoreCase);
      s = Regex.Replace(s, @"<\s*/?(td|th)\b[^>]*>", "\t", RegexOptions.IgnoreCase);
      s = Regex.Replace(s, @"<[^>]+>", "");
      s = WebUtility.HtmlDecode(s);
      s = Regex.Replace(s, @"[ \t]*\r\n[ \t\r\n]*", "\r\n");
      return s.Trim();
    }
  }
}
