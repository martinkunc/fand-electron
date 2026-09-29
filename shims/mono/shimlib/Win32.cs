// Managed stand-ins for the Windows DLL functions Účto's .NET helpers call through
// [DllImport]. The patcher (../patch/UctoPatch.cs) turns each redirected extern method of a
// helper into a managed method that calls the method of the same name here, found in the
// class named after the DLL (user32.dll -> User32). Parameters of the helper's own types
// (MAPI structures) arrive as object; int/bool/IntPtr return values are converted by the patcher.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

namespace UctoShim.Win32 {
  public static class User32 {
    public static int ShowWindow(IntPtr hWnd, int nCmdShow) { return 1; }
    public static IntPtr GetSystemMenu(IntPtr hWnd, bool bRevert) { return IntPtr.Zero; }
    public static int RemoveMenu(IntPtr hMenu, int nPosition, int wFlags) { return 1; }
    public static int GetMenuItemCount(IntPtr hMenu) { return 0; }
    public static int MoveWindow(IntPtr hWnd, int x, int y, int cx, int cy, bool repaint) { return 1; }
    public static int SendMessage(int hWnd, uint msg, int wParam, int lParam) { return 0; }
    public static IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam) { return IntPtr.Zero; }
    public static IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam) { return IntPtr.Zero; }
    public static IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam) { return IntPtr.Zero; }
    public static int PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam) { return 1; }
    public static int SetForegroundWindow(IntPtr hWnd) { return 1; }
    public static IntPtr GetForegroundWindow() { return IntPtr.Zero; }
    public static IntPtr FindWindow(string lpClassName, string lpWindowName) { return IntPtr.Zero; }
    public static int ReleaseCapture() { return 1; }
    public static int MessageBeep(uint uType) { return 1; }
  }

  public static class Kernel32 {
    public static int AllocConsole() { return 1; }
    public static int FreeConsole() { return 1; }
    public static IntPtr GetConsoleWindow() { return IntPtr.Zero; }
    /// There are no 8.3 names on Unix: the path is returned unchanged (as the API does for
    /// paths that already are short). Returns the length, or the required size if too small.
    public static int GetShortPathName(string path, StringBuilder shortPath, int shortPathLength) {
      if (path == null) return 0;
      if (shortPath == null || shortPathLength <= path.Length) return path.Length + 1;
      shortPath.Length = 0; shortPath.Append(path);
      return path.Length;
    }
    public static int GetLongPathName(string path, StringBuilder longPath, int longPathLength) {
      return GetShortPathName(path, longPath, longPathLength);
    }
    /// win.ini [fonts] registration (AlisFand): nothing to do on Unix.
    public static int WriteProfileString(string section, string key, string value) { return 1; }
    public static int Beep(uint freq, uint duration) { return 1; }
  }

  public static class Gdi32 {
    /// Fonts are installed by the desktop (fontconfig/Core Text), not per call: report success.
    public static int AddFontResource(string lpFileName) { return 1; }
    public static int RemoveFontResource(string lpFileName) { return 1; }
  }

  /// Simple MAPI (MAPI32.DLL). Only MAPISendMail does real work: it writes an RFC 5322 draft
  /// (.eml, X-Unsent: 1) with the recipients, subject, body and attachments and opens it in
  /// the default mail client. Mailbox functions report "no messages"/"not supported".
  public static class Mapi32 {
    public const int SUCCESS_SUCCESS = 0, MAPI_E_FAILURE = 2, MAPI_E_ATTACHMENT_NOT_FOUND = 11,
      MAPI_E_NO_MESSAGES = 16, MAPI_E_INVALID_MESSAGE = 17, MAPI_E_NOT_SUPPORTED = 26;

    [StructLayout(LayoutKind.Sequential)]
    class RecipDesc { public int reserved; public int recipClass; public string name; public string address; public int eIDSize; public IntPtr entryID; }
    [StructLayout(LayoutKind.Sequential)]
    class FileDesc { public int reserved; public int flags; public int position; public string path; public string name; public IntPtr type; }

    public static int MAPILogon(IntPtr hwnd, string profile, string password, int flags, int reserved, ref IntPtr session) {
      session = new IntPtr(1);
      return SUCCESS_SUCCESS;
    }
    public static int MAPILogoff(IntPtr session, IntPtr hwnd, int flags, int reserved) { return SUCCESS_SUCCESS; }
    public static int MAPIFindNext(IntPtr session, IntPtr hwnd, string messageType, string seed, int flags, int reserved, StringBuilder id) { return MAPI_E_NO_MESSAGES; }
    public static int MAPIReadMail(IntPtr session, IntPtr hwnd, string id, int flags, int reserved, ref IntPtr message) { message = IntPtr.Zero; return MAPI_E_INVALID_MESSAGE; }
    public static int MAPIFreeBuffer(IntPtr p) { return SUCCESS_SUCCESS; }
    public static int MAPIDeleteMail(IntPtr session, IntPtr hwnd, string id, int flags, int reserved) { return MAPI_E_INVALID_MESSAGE; }
    public static int MAPIAddress(IntPtr session, IntPtr hwnd, string caption, int editFields, string labels, int recipCount, IntPtr recips, int flags, int reserved, ref int newRecipCount, ref IntPtr newRecips) {
      newRecipCount = 0; newRecips = IntPtr.Zero;
      return MAPI_E_NOT_SUPPORTED;
    }

    /// message: the helper's own MapiMessage class (Simple MAPI layout, read by field name).
    public static int MAPISendMail(IntPtr session, IntPtr hwnd, object message, int flags, int reserved) {
      try {
        var m = ReadMessage(message);
        foreach (var a in m.Attachments) if (!File.Exists(a.Path)) return MAPI_E_ATTACHMENT_NOT_FOUND;
        string file = WriteDraft(m);
        Os.Open(file);
        return SUCCESS_SUCCESS;
      } catch (Exception e) {
        Console.Error.WriteLine("UctoShim MAPISendMail: " + e);
        return MAPI_E_FAILURE;
      }
    }

    public class Attachment { public string Path; public string Name; }
    public class Message {
      public string Subject = "", Body = "";
      public List<string> To = new List<string>(), Cc = new List<string>(), Bcc = new List<string>();
      public List<Attachment> Attachments = new List<Attachment>();
    }

    static T Field<T>(object o, string name) {
      var f = o.GetType().GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.IgnoreCase);
      return f == null ? default(T) : (T)f.GetValue(o);
    }

    public static Message ReadMessage(object message) {
      var m = new Message { Subject = Field<string>(message, "subject") ?? "", Body = Field<string>(message, "noteText") ?? "" };
      int rc = Field<int>(message, "recipCount"), fc = Field<int>(message, "fileCount");
      IntPtr recips = Field<IntPtr>(message, "recips"), files = Field<IntPtr>(message, "files");
      int rs = Marshal.SizeOf(typeof(RecipDesc)), fs = Marshal.SizeOf(typeof(FileDesc));
      for (int i = 0; i < rc && recips != IntPtr.Zero; i++) {
        var r = new RecipDesc();
        Marshal.PtrToStructure(new IntPtr(recips.ToInt64() + (long)i * rs), r);
        string addr = Address(r.address, r.name);
        if (addr == null) continue;
        (r.recipClass == 2 ? m.Cc : r.recipClass == 3 ? m.Bcc : m.To).Add(addr);
      }
      for (int i = 0; i < fc && files != IntPtr.Zero; i++) {
        var f = new FileDesc();
        Marshal.PtrToStructure(new IntPtr(files.ToInt64() + (long)i * fs), f);
        if (string.IsNullOrEmpty(f.path)) continue;
        string p = PathFix.Fix(f.path);
        m.Attachments.Add(new Attachment { Path = p, Name = string.IsNullOrEmpty(f.name) ? Path.GetFileName(p) : Path.GetFileName(PathFix.Norm(f.name)) });
      }
      return m;
    }

    /// "SMTP:a@b.cz" / "a@b.cz" / display name; Účto's placeholder "@.cz" and ";" mean empty.
    static string Address(string address, string name) {
      string a = string.IsNullOrEmpty(address) ? name : address;
      if (a == null) return null;
      a = a.Trim();
      if (a.StartsWith("SMTP:", StringComparison.OrdinalIgnoreCase)) a = a.Substring(5);
      if (a.Length == 0 || a == ";" || a == "@.cz") return null;
      if (!string.IsNullOrEmpty(address) && !string.IsNullOrEmpty(name) && name != address)
        return EncodeWord(name) + " <" + a + ">";
      return a;
    }

    public static string WriteDraft(Message m) {
      string dir = Environment.GetEnvironmentVariable("UCTO_MAIL_DIR");
      if (string.IsNullOrEmpty(dir)) dir = Path.Combine(Path.GetTempPath(), "ucto-mail");
      Directory.CreateDirectory(dir);
      string file = Path.Combine(dir, "zprava-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".eml");
      File.WriteAllText(file, BuildEml(m, DateTime.Now), new UTF8Encoding(false));
      return file;
    }

    public static string BuildEml(Message m, DateTime now) {
      var sb = new StringBuilder();
      string boundary = "=_ucto_" + Guid.NewGuid().ToString("N");
      sb.Append("X-Unsent: 1\r\n");
      sb.Append("Date: ").Append(now.ToString("ddd, dd MMM yyyy HH:mm:ss ", System.Globalization.CultureInfo.InvariantCulture))
        .Append(now.ToString("zzz", System.Globalization.CultureInfo.InvariantCulture).Replace(":", "")).Append("\r\n");
      if (m.To.Count > 0) sb.Append("To: ").Append(string.Join(", ", m.To)).Append("\r\n");
      if (m.Cc.Count > 0) sb.Append("Cc: ").Append(string.Join(", ", m.Cc)).Append("\r\n");
      if (m.Bcc.Count > 0) sb.Append("Bcc: ").Append(string.Join(", ", m.Bcc)).Append("\r\n");
      sb.Append("Subject: ").Append(EncodeWord(m.Subject)).Append("\r\n");
      sb.Append("MIME-Version: 1.0\r\n");
      string body = NormalizeBody(m.Body);
      if (m.Attachments.Count == 0) {
        TextPart(sb, body);
      } else {
        sb.Append("Content-Type: multipart/mixed; boundary=\"").Append(boundary).Append("\"\r\n\r\n");
        sb.Append("This is a multi-part message in MIME format.\r\n");
        sb.Append("--").Append(boundary).Append("\r\n");
        TextPart(sb, body);
        foreach (var a in m.Attachments) {
          sb.Append("\r\n--").Append(boundary).Append("\r\n");
          string enc = EncodeWord(a.Name).Replace("\"", "");
          sb.Append("Content-Type: ").Append(MimeType(a.Name)).Append("; name=\"").Append(enc).Append("\"\r\n");
          sb.Append("Content-Transfer-Encoding: base64\r\n");
          sb.Append("Content-Disposition: attachment; filename=\"").Append(enc).Append("\"");
          if (!IsAscii(a.Name)) sb.Append(";\r\n filename*=UTF-8''").Append(Uri.EscapeDataString(a.Name));
          sb.Append("\r\n\r\n");
          string b64 = Convert.ToBase64String(File.ReadAllBytes(a.Path));
          for (int i = 0; i < b64.Length; i += 76) sb.Append(b64, i, Math.Min(76, b64.Length - i)).Append("\r\n");
        }
        sb.Append("\r\n--").Append(boundary).Append("--\r\n");
      }
      return sb.ToString();
    }

    static void TextPart(StringBuilder sb, string body) {
      sb.Append("Content-Type: text/plain; charset=utf-8\r\n");
      sb.Append("Content-Transfer-Encoding: quoted-printable\r\n\r\n");
      sb.Append(QuotedPrintable(body)).Append("\r\n");
    }

    /// UEmail17 joins the first body line and the rest with "\n\r" (sic): normalise to CRLF.
    public static string NormalizeBody(string s) {
      if (string.IsNullOrEmpty(s)) return "";
      s = s.Replace("\r\n", "\n").Replace("\n\r", "\n").Replace("\r", "\n");
      return s.Replace("\n", "\r\n");
    }

    static bool IsAscii(string s) { return s.All(c => c >= 0x20 && c < 0x7F); }

    public static string EncodeWord(string s) {
      if (string.IsNullOrEmpty(s)) return "";
      if (IsAscii(s)) return s;
      // RFC 2047: encoded words of at most 75 characters, split on character boundaries.
      var words = new List<string>(); var cur = new StringBuilder();
      foreach (var ch in s) {
        cur.Append(ch);
        if (Encoding.UTF8.GetByteCount(cur.ToString()) > 42) { words.Add(cur.ToString()); cur.Length = 0; }
      }
      if (cur.Length > 0) words.Add(cur.ToString());
      return string.Join("\r\n ", words.Select(w => "=?UTF-8?B?" + Convert.ToBase64String(Encoding.UTF8.GetBytes(w)) + "?="));
    }

    public static string QuotedPrintable(string text) {
      var sb = new StringBuilder();
      var lines = text.Split(new[] { "\r\n" }, StringSplitOptions.None);
      for (int li = 0; li < lines.Length; li++) {
        var bytes = Encoding.UTF8.GetBytes(lines[li]);
        int col = 0;
        for (int i = 0; i < bytes.Length; i++) {
          byte b = bytes[i];
          bool last = i == bytes.Length - 1;
          string tok = (b >= 33 && b <= 126 && b != (byte)'=') || ((b == 32 || b == 9) && !last)
            ? ((char)b).ToString() : "=" + b.ToString("X2");
          if (col + tok.Length > 75) { sb.Append("=\r\n"); col = 0; }
          sb.Append(tok); col += tok.Length;
        }
        if (li < lines.Length - 1) sb.Append("\r\n");
      }
      return sb.ToString();
    }

    static string MimeType(string name) {
      switch (Path.GetExtension(name ?? "").ToLowerInvariant()) {
        case ".pdf": return "application/pdf";
        case ".rtf": return "application/rtf";
        case ".htm": case ".html": return "text/html";
        case ".txt": return "text/plain";
        case ".xml": return "application/xml";
        case ".zip": return "application/zip";
        case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        case ".xls": return "application/vnd.ms-excel";
        case ".csv": return "text/csv";
        case ".jpg": case ".jpeg": return "image/jpeg";
        case ".png": return "image/png";
        case ".isdoc": return "application/xml";
        default: return "application/octet-stream";
      }
    }
  }
}
