// Rebex.Common substitute (logging + shared helpers) for running Účto's original .NET
// helpers under Mono. Same assembly identity as the original (name, version and public
// key; delay-signed with rebex-public.snk; Mono does not verify strong-name signatures),
// but only the API subset the helpers use, implemented over Mono's own classes.
// Built twice by build.sh: 6.0.8000.0 ({ap02}) and 5.0.7320.0 ({ap03}, {tisk}).
// Enum values and member signatures are checked against the originals by tests/ApiCheck.cs.
using System;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;

namespace Rebex {
  /// Values as in the original Rebex.Common (both 5.0.7320.0 and 6.0.8000.0).
  public enum LogLevel { Verbose = 10, Debug = 20, Info = 30, Error = 40, Off = int.MaxValue }

  public interface ILogWriter {
    LogLevel Level { get; set; }
    void Write(LogLevel level, Type objectType, int objectId, string area, string message);
    void Write(LogLevel level, Type objectType, int objectId, string area, string message, byte[] buffer, int offset, int length);
  }

  public abstract class LogWriterBase : ILogWriter, IDisposable {
    LogLevel level = LogLevel.Info;
    bool closed;
    protected LogWriterBase() {}
    public LogLevel Level { get { return level; } set { level = value; } }
    protected virtual bool IsClosed { get { return closed; } }
    public virtual void Close() { Dispose(true); }
    protected virtual void Dispose(bool disposing) { closed = true; }
    public void Dispose() { Dispose(true); GC.SuppressFinalize(this); }

    // Line format modelled on Rebex logs: "2024-01-31 10:00:00.123 DEBUG HttpRequest(1)[5] HTTP: text"
    public virtual void Write(LogLevel level, Type objectType, int objectId, string area, string message) {
      if (level < Level || Level == LogLevel.Off || IsClosed) return;
      WriteMessage(string.Format("{0:yyyy-MM-dd HH:mm:ss.fff} {1} {2}({3})[{4}] {5}: {6}",
        DateTime.Now, level.ToString().ToUpperInvariant(), objectType == null ? "" : objectType.Name, objectId,
        Thread.CurrentThread.ManagedThreadId, area, message));
    }

    public virtual void Write(LogLevel level, Type objectType, int objectId, string area, string message, byte[] buffer, int offset, int length) {
      if (level < Level || Level == LogLevel.Off || IsClosed) return;
      var sb = new StringBuilder(message);
      if (buffer != null)
        for (int row = 0; row < length; row += 16) {
          sb.Append("\r\n ").Append(row.ToString("X4")).Append(' ');
          var text = new StringBuilder();
          for (int i = row; i < row + 16; i++) {
            if (i < length) { byte b = buffer[offset + i]; sb.Append(' ').Append(b.ToString("X2")); text.Append(b >= 32 && b < 127 ? (char)b : '.'); }
            else sb.Append("   ");
          }
          sb.Append("  ").Append(text);
        }
      Write(level, objectType, objectId, area, sb.ToString());
    }

    protected virtual void WriteMessage(string message) {}
  }

  public class FileLogWriter : LogWriterBase {
    static readonly object Sync = new object();
    readonly string path;
    bool broken;

    public FileLogWriter(string path) : this(path, LogLevel.Info) {}
    public FileLogWriter(string path, LogLevel level) {
      if (path == null) throw new ArgumentNullException("path");
      this.path = Util.FixPath(path);
      Level = level;
      // The original opens the file here and writes a banner; an unusable path does not stop the helper here.
      WriteMessage(string.Format("{0:yyyy-MM-dd HH:mm:ss.fff} Opening log file.", DateTime.Now));
      Write(LogLevel.Info, typeof(FileLogWriter), 1, "Info", "Assembly: " + typeof(FileLogWriter).Assembly.GetName().Name + " " + typeof(FileLogWriter).Assembly.GetName().Version + " (Účto Mono substitute)");
      Write(LogLevel.Info, typeof(FileLogWriter), 1, "Info", "Platform: " + Environment.OSVersion + ", CLR " + Environment.Version);
    }

    public string Path { get { return path; } }
    public string Filename { get { return path; } }
    protected override bool IsClosed { get { return base.IsClosed; } }
    protected override void Dispose(bool disposing) { base.Dispose(disposing); }

    protected override void WriteMessage(string message) {
      if (broken) return;
      lock (Sync) {
        try {
          using (var fs = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) {
            var bytes = Encoding.UTF8.GetBytes(message + "\r\n");
            fs.Write(bytes, 0, bytes.Length);
          }
        } catch (Exception) { broken = true; }
      }
    }

    ~FileLogWriter() { Dispose(false); }
  }

  static class Util {
    static MethodInfo pathFix; static bool pathFixLooked;

    /// DOS path -> host path. Uses UctoShim.PathFix.Fix (the patcher's runtime) when it is
    /// loaded in the helper's domain, otherwise just converts backslashes on Unix.
    internal static string FixPath(string p) {
      if (string.IsNullOrEmpty(p) || System.IO.Path.DirectorySeparatorChar == '\\') return p;
      if (!pathFixLooked) {
        pathFixLooked = true;
        try {
          foreach (var a in AppDomain.CurrentDomain.GetAssemblies())
            if (a.GetName().Name == "UctoShim") {
              var t = a.GetType("UctoShim.PathFix");
              if (t != null) pathFix = t.GetMethod("Fix", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string) }, null);
            }
        } catch (Exception) {}
      }
      if (pathFix != null) try { return (string)pathFix.Invoke(null, new object[] { p }); } catch (Exception) {}
      return p.Replace('\\', '/');
    }
  }
}
