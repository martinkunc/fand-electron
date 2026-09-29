// System.Data.OleDb substitutes for the Jet "dBASE IV" provider (UctoExp), which exists
// only on Windows. The patcher redirects the helper's references to
// System.Data.OleDb.OleDb{Connection,Command,DataAdapter,DataReader} to the classes of the
// same names here, so fields, locals and calls keep working. Supported SQL:
//   SELECT * | col[, col...] FROM <table>[;]     (table = file name in Data Source, .dbf optional)
// Values are typed the way Jet maps dBASE columns: C/M -> String (C right-trimmed),
// N/F -> Double, D -> DateTime, L -> Boolean, blanks -> DBNull.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Data;
using System.Data.Common;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace UctoShim.Data {
  public static class Dbf {
    /// Code page for a DBF language-driver byte; 0 means the OEM code page of the system
    /// (CP852 on Czech Windows, what FAND writes). $UCTO_DBF_CODEPAGE overrides the default.
    public static Encoding EncodingFor(byte ldid) {
      int cp;
      switch (ldid) {
        case 0x01: cp = 437; break;
        case 0x02: cp = 850; break;
        case 0x03: case 0x57: case 0x58: case 0x59: cp = 1252; break;
        case 0x64: cp = 852; break;
        case 0x65: cp = 866; break;
        case 0x66: cp = 865; break;
        case 0x67: cp = 861; break;
        case 0x6A: cp = 737; break;
        case 0x6B: cp = 857; break;
        case 0x7D: cp = 1255; break;
        case 0x7E: cp = 1256; break;
        case 0xC8: cp = 1250; break;
        case 0xC9: cp = 1251; break;
        case 0xCA: cp = 1254; break;
        case 0xCB: cp = 1253; break;
        default:
          var env = Environment.GetEnvironmentVariable("UCTO_DBF_CODEPAGE");
          if (!int.TryParse(env, out cp)) cp = 852;
          break;
      }
      try { return Encoding.GetEncoding(cp); } catch (Exception) { return Encoding.GetEncoding(28592); }
    }

    class Field { public string Name; public char Type; public int Length, Decimals, Offset; }

    public static DataTable Read(string path) { return Read(path, null); }

    public static DataTable Read(string path, Encoding enc) {
      byte[] b = File.ReadAllBytes(path);
      if (b.Length < 32) throw new InvalidDataException("Soubor " + path + " není platná tabulka dBASE.");
      byte version = b[0];
      int nRecs = BitConverter.ToInt32(b, 4), hdrLen = BitConverter.ToUInt16(b, 8), recLen = BitConverter.ToUInt16(b, 10);
      if (enc == null) enc = EncodingFor(b[29]);
      var fields = new List<Field>();
      int offset = 1;
      for (int p = 32; p + 32 <= hdrLen && p < b.Length && b[p] != 0x0D; p += 32) {
        int n = 0; while (n < 11 && b[p + n] != 0) n++;
        var f = new Field { Name = enc.GetString(b, p, n).Trim(), Type = char.ToUpperInvariant((char)b[p + 11]), Length = b[p + 16], Decimals = b[p + 17], Offset = offset };
        if (f.Type == 'C' && version != 0x03 && version != 0x83) f.Length |= b[p + 17] << 8;   // FoxPro/Clipper long character fields
        offset += f.Length;
        fields.Add(f);
      }
      var table = new DataTable(Path.GetFileNameWithoutExtension(path));
      foreach (var f in fields) {
        string name = f.Name, uniq = name; int k = 1;
        while (table.Columns.Contains(uniq)) uniq = name + "_" + (k++);
        table.Columns.Add(uniq, ClrType(f));
      }
      Memo memo = fields.Any(f => f.Type == 'M' || f.Type == 'G' || f.Type == 'B' && version != 0x30 && version != 0x31) ? Memo.Open(path, version) : null;
      try {
        for (int r = 0; r < nRecs; r++) {
          int bas = hdrLen + r * recLen;
          if (bas + recLen > b.Length) break;
          if (b[bas] == 0x1A) break;
          if (b[bas] == (byte)'*') continue;   // deleted (Jet hides deleted records)
          var row = table.NewRow();
          for (int i = 0; i < fields.Count; i++) row[i] = Value(fields[i], b, bas + fields[i].Offset, enc, memo, version);
          table.Rows.Add(row);
        }
      } finally { if (memo != null) memo.Dispose(); }
      table.AcceptChanges();
      return table;
    }

    static Type ClrType(Field f) {
      switch (f.Type) {
        case 'N': case 'F': case 'B': case 'Y': return typeof(double);
        case 'I': return typeof(int);
        case 'D': case 'T': return typeof(DateTime);
        case 'L': return typeof(bool);
        default: return typeof(string);
      }
    }

    static object Value(Field f, byte[] b, int p, Encoding enc, Memo memo, byte version) {
      switch (f.Type) {
        case 'C': {
          string s = enc.GetString(b, p, f.Length).TrimEnd(' ', '\0');
          return s;
        }
        case 'N': case 'F': {
          string s = Encoding.ASCII.GetString(b, p, f.Length).Trim().Replace(',', '.');
          double d;
          if (s.Length == 0 || s.Trim('*').Length == 0 || !double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return DBNull.Value;
          return d;
        }
        case 'D': {
          string s = Encoding.ASCII.GetString(b, p, f.Length).Trim();
          DateTime d;
          if (s.Length == 8 && DateTime.TryParseExact(s, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out d)) return d;
          return DBNull.Value;
        }
        case 'L': {
          char c = char.ToUpperInvariant((char)b[p]);
          if (c == 'T' || c == 'Y') return true;
          if (c == 'F' || c == 'N') return false;
          return DBNull.Value;
        }
        case 'I': return BitConverter.ToInt32(b, p);
        case 'B':
          if (version == 0x30 || version == 0x31) return BitConverter.ToDouble(b, p);
          goto case 'M';
        case 'Y': return BitConverter.ToInt64(b, p) / 10000.0;
        case 'T': {
          int jd = BitConverter.ToInt32(b, p), ms = BitConverter.ToInt32(b, p + 4);
          if (jd == 0) return DBNull.Value;
          return new DateTime(1, 1, 1).AddDays(jd - 1721426).AddMilliseconds(ms);
        }
        case 'M': case 'G': {
          long block;
          if (f.Length == 4) block = BitConverter.ToInt32(b, p);
          else { var s = Encoding.ASCII.GetString(b, p, f.Length).Trim(); if (!long.TryParse(s, out block)) block = 0; }
          if (block <= 0 || memo == null) return DBNull.Value;
          var text = memo.Read(block, enc);
          return text == null ? (object)DBNull.Value : text;
        }
        default: {
          string s = enc.GetString(b, p, f.Length).TrimEnd(' ', '\0');
          return s;
        }
      }
    }

    class Memo : IDisposable {
      FileStream fs; bool fpt; int blockSize = 512; bool db4;

      public static Memo Open(string dbf, byte version) {
        string dir = Path.GetDirectoryName(Path.GetFullPath(dbf)), stem = Path.GetFileNameWithoutExtension(dbf);
        foreach (var ext in new[] { ".fpt", ".dbt" }) {
          string hit = Directory.GetFiles(dir).FirstOrDefault(x => string.Equals(Path.GetFileName(x), stem + ext, StringComparison.OrdinalIgnoreCase));
          if (hit == null) continue;
          var m = new Memo { fs = File.OpenRead(hit), fpt = ext == ".fpt" };
          var h = new byte[512]; m.fs.Read(h, 0, h.Length);
          if (m.fpt) { m.blockSize = (h[6] << 8) | h[7]; if (m.blockSize == 0) m.blockSize = 64; }
          else if (version == 0x8B || version == 0xCB) { m.db4 = true; int bs = BitConverter.ToUInt16(h, 20); if (bs > 0) m.blockSize = bs; }
          return m;
        }
        return null;
      }

      public string Read(long block, Encoding enc) {
        long pos = block * blockSize;
        if (pos >= fs.Length) return null;
        fs.Position = pos;
        var r = new BinaryReader(fs);
        if (fpt) {
          var hb = r.ReadBytes(8);
          if (hb.Length < 8) return null;
          int len = (hb[4] << 24) | (hb[5] << 16) | (hb[6] << 8) | hb[7];
          return enc.GetString(r.ReadBytes(len));
        }
        if (db4) {
          var hb = r.ReadBytes(8);
          if (hb.Length == 8 && hb[0] == 0xFF && hb[1] == 0xFF && hb[2] == 0x08 && hb[3] == 0x00) {
            int len = BitConverter.ToInt32(hb, 4) - 8;
            return enc.GetString(r.ReadBytes(Math.Max(0, len)));
          }
          fs.Position = pos;
        }
        // dBASE III: text up to 0x1A (0x1A 0x1A terminates the block chain).
        var ms = new MemoryStream(); int c;
        while ((c = fs.ReadByte()) >= 0 && c != 0x1A) ms.WriteByte((byte)c);
        return enc.GetString(ms.ToArray());
      }

      public void Dispose() { fs.Dispose(); }
    }
  }

  public sealed class OleDbConnection : DbConnection, ICloneable {
    string connectionString = "";
    ConnectionState state = ConnectionState.Closed;

    public OleDbConnection() { }
    public OleDbConnection(string connectionString) { ConnectionString = connectionString; }

    public override string ConnectionString { get { return connectionString; } set { connectionString = value ?? ""; } }
    public override string Database { get { return ""; } }
    public override string DataSource { get { return Setting("Data Source") ?? ""; } }
    public string Provider { get { return Setting("Provider") ?? ""; } }
    public override string ServerVersion { get { return "04.00.0000"; } }
    public override ConnectionState State { get { return state; } }
    public override int ConnectionTimeout { get { return 15; } }

    internal string Setting(string key) {
      var b = new DbConnectionStringBuilder();
      try { b.ConnectionString = connectionString; } catch (Exception) { return null; }
      object v; return b.TryGetValue(key, out v) ? v as string : null;
    }

    /// Host folder of the tables (the Jet "Data Source" is the directory with the .dbf files).
    internal string Folder {
      get {
        string ds = DataSource;
        string p = PathFix.Fix(ds);
        if (File.Exists(p) && !Directory.Exists(p)) p = Path.GetDirectoryName(Path.GetFullPath(p));
        return string.IsNullOrEmpty(p) ? Directory.GetCurrentDirectory() : p;
      }
    }

    public override void Open() {
      if (state == ConnectionState.Open) throw new InvalidOperationException("The connection is already open.");
      if (!Directory.Exists(Folder)) throw new InvalidOperationException("'" + DataSource + "' is not a valid path.");
      state = ConnectionState.Open;
      OnStateChange(new StateChangeEventArgs(ConnectionState.Closed, ConnectionState.Open));
    }
    public override void Close() {
      if (state == ConnectionState.Closed) return;
      state = ConnectionState.Closed;
      OnStateChange(new StateChangeEventArgs(ConnectionState.Open, ConnectionState.Closed));
    }
    public override void ChangeDatabase(string databaseName) { throw new NotSupportedException(); }
    protected override DbTransaction BeginDbTransaction(IsolationLevel isolationLevel) { throw new NotSupportedException("Transactions are not supported by the DBF substitute."); }
    public new OleDbCommand CreateCommand() { return new OleDbCommand { Connection = this }; }
    protected override DbCommand CreateDbCommand() { return CreateCommand(); }
    public object Clone() { return new OleDbConnection(connectionString); }
    public void ResetState() { }
    public static void ReleaseObjectPool() { }
  }

  public sealed class OleDbCommand : DbCommand, ICloneable {
    OleDbConnection connection;
    readonly Params parameters = new Params();

    public OleDbCommand() { }
    public OleDbCommand(string cmdText) { CommandText = cmdText; }
    public OleDbCommand(string cmdText, OleDbConnection connection) { CommandText = cmdText; this.connection = connection; }
    public OleDbCommand(string cmdText, OleDbConnection connection, DbTransaction transaction) : this(cmdText, connection) { }

    public override string CommandText { get; set; }
    public override int CommandTimeout { get; set; }
    public override CommandType CommandType { get; set; }
    public override bool DesignTimeVisible { get; set; }
    public override UpdateRowSource UpdatedRowSource { get; set; }
    public new OleDbConnection Connection { get { return connection; } set { connection = value; } }
    protected override DbConnection DbConnection { get { return connection; } set { connection = (OleDbConnection)value; } }
    protected override DbParameterCollection DbParameterCollection { get { return parameters; } }
    protected override DbTransaction DbTransaction { get; set; }

    public override void Cancel() { }
    public override void Prepare() { }
    protected override DbParameter CreateDbParameter() { throw new NotSupportedException("Parameters are not supported by the DBF substitute."); }
    public override int ExecuteNonQuery() { throw new NotSupportedException("The DBF substitute is read-only (SELECT only)."); }
    public override object ExecuteScalar() {
      var t = Query();
      return t.Rows.Count > 0 && t.Columns.Count > 0 ? t.Rows[0][0] : null;
    }
    public new OleDbDataReader ExecuteReader() { return new OleDbDataReader(Query()); }
    public new OleDbDataReader ExecuteReader(CommandBehavior behavior) { return new OleDbDataReader(Query()); }
    protected override DbDataReader ExecuteDbDataReader(CommandBehavior behavior) { return ExecuteReader(behavior); }
    public object Clone() { return new OleDbCommand(CommandText, connection); }

    static readonly Regex Select = new Regex(@"^\s*SELECT\s+(?<cols>.+?)\s+FROM\s+(?<table>""[^""]+""|\[[^\]]+\]|`[^`]+`|[^\s;]+)\s*;?\s*$", RegexOptions.IgnoreCase | RegexOptions.Singleline);

    internal DataTable Query() {
      if (connection == null) throw new InvalidOperationException("ExecuteReader: Connection property has not been initialized.");
      if (connection.State != ConnectionState.Open) throw new InvalidOperationException("ExecuteReader requires an open and available Connection.");
      string sql = CommandText ?? "";
      string table, cols;
      if (CommandType == CommandType.TableDirect) { table = sql; cols = "*"; }
      else {
        var m = Select.Match(sql);
        if (!m.Success) throw new NotSupportedException("The DBF substitute supports only 'SELECT <columns> FROM <table>': " + sql);
        table = m.Groups["table"].Value; cols = m.Groups["cols"].Value.Trim();
      }
      table = table.Trim().Trim('"', '[', ']', '`');
      var t = Dbf.Read(TablePath(table));
      if (cols == "*") return t;
      var names = cols.Split(',').Select(c => c.Trim().Trim('"', '[', ']', '`')).ToArray();
      var result = new DataTable(t.TableName);
      foreach (var n in names) {
        var c = t.Columns.Cast<DataColumn>().FirstOrDefault(x => string.Equals(x.ColumnName, n, StringComparison.OrdinalIgnoreCase));
        if (c == null) throw new ArgumentException("No value given for one or more required parameters. (" + n + ")");
        result.Columns.Add(c.ColumnName, c.DataType);
      }
      foreach (DataRow r in t.Rows) result.Rows.Add(names.Select(n => r[n]).ToArray());
      result.AcceptChanges();
      return result;
    }

    string TablePath(string table) {
      // Table names are file names in Data Source; a full DOS path (as UctoExp passes when
      // Path.GetFileName ran on it) is accepted too.
      string norm = PathFix.Norm(table);
      string name = Path.GetFileName(norm);
      var candidates = new List<string>();
      if (norm.Contains("/")) candidates.Add(PathFix.Fix(norm));
      string dir = connection.Folder;
      candidates.Add(Path.Combine(dir, name));
      if (!Path.HasExtension(name)) candidates.Add(Path.Combine(dir, name + ".dbf"));
      foreach (var c in candidates) {
        var hit = FindCI(c);
        if (hit != null) return hit;
      }
      throw new FileNotFoundException("The Microsoft Jet database engine could not find the object '" + table + "'.", Path.Combine(dir, name));
    }

    static string FindCI(string path) {
      if (File.Exists(path)) return path;
      var fixedPath = PathFix.Fix(path);
      if (File.Exists(fixedPath)) return fixedPath;
      return null;
    }

    sealed class Params : DbParameterCollection {
      readonly List<DbParameter> list = new List<DbParameter>();
      public override int Count { get { return list.Count; } }
      public override object SyncRoot { get { return list; } }
      public override bool IsFixedSize { get { return false; } }
      public override bool IsReadOnly { get { return false; } }
      public override bool IsSynchronized { get { return false; } }
      public override int Add(object value) { list.Add((DbParameter)value); return list.Count - 1; }
      public override void AddRange(Array values) { foreach (var v in values) Add(v); }
      public override void Clear() { list.Clear(); }
      public override bool Contains(object value) { return list.Contains((DbParameter)value); }
      public override bool Contains(string value) { return IndexOf(value) >= 0; }
      public override void CopyTo(Array array, int index) { ((ICollection)list).CopyTo(array, index); }
      public override IEnumerator GetEnumerator() { return list.GetEnumerator(); }
      public override int IndexOf(object value) { return list.IndexOf((DbParameter)value); }
      public override int IndexOf(string parameterName) { return list.FindIndex(p => p.ParameterName == parameterName); }
      public override void Insert(int index, object value) { list.Insert(index, (DbParameter)value); }
      public override void Remove(object value) { list.Remove((DbParameter)value); }
      public override void RemoveAt(int index) { list.RemoveAt(index); }
      public override void RemoveAt(string parameterName) { RemoveAt(IndexOf(parameterName)); }
      protected override DbParameter GetParameter(int index) { return list[index]; }
      protected override DbParameter GetParameter(string parameterName) { return list[IndexOf(parameterName)]; }
      protected override void SetParameter(int index, DbParameter value) { list[index] = value; }
      protected override void SetParameter(string parameterName, DbParameter value) { list[IndexOf(parameterName)] = value; }
    }
  }

  public sealed class OleDbDataAdapter : DbDataAdapter, ICloneable {
    public OleDbDataAdapter() { }
    public OleDbDataAdapter(OleDbCommand selectCommand) { SelectCommand = selectCommand; }
    public OleDbDataAdapter(string selectCommandText, OleDbConnection selectConnection) { SelectCommand = new OleDbCommand(selectCommandText, selectConnection); }
    public OleDbDataAdapter(string selectCommandText, string selectConnectionString) { SelectCommand = new OleDbCommand(selectCommandText, new OleDbConnection(selectConnectionString)); }

    public new OleDbCommand SelectCommand { get { return (OleDbCommand)base.SelectCommand; } set { base.SelectCommand = value; } }
    public new OleDbCommand InsertCommand { get { return (OleDbCommand)base.InsertCommand; } set { base.InsertCommand = value; } }
    public new OleDbCommand UpdateCommand { get { return (OleDbCommand)base.UpdateCommand; } set { base.UpdateCommand = value; } }
    public new OleDbCommand DeleteCommand { get { return (OleDbCommand)base.DeleteCommand; } set { base.DeleteCommand = value; } }

    // Fill(...) is inherited from DbDataAdapter (as in .NET): it opens the connection when
    // needed and reads OleDbCommand.ExecuteReader.

    object ICloneable.Clone() { return new OleDbDataAdapter(SelectCommand); }
  }

  /// Forward-only reader over the loaded table (DataTableReader is sealed, so this delegates).
  public sealed class OleDbDataReader : DbDataReader {
    readonly DataTableReader r;
    internal OleDbDataReader(DataTable t) { r = new DataTableReader(t); }
    public override int Depth { get { return 0; } }
    public override int FieldCount { get { return r.FieldCount; } }
    public override bool HasRows { get { return r.HasRows; } }
    public override bool IsClosed { get { return r.IsClosed; } }
    public override int RecordsAffected { get { return -1; } }
    public override object this[int ordinal] { get { return r[ordinal]; } }
    public override object this[string name] { get { return r[name]; } }
    public override void Close() { r.Close(); }
    public override bool GetBoolean(int i) { return r.GetBoolean(i); }
    public override byte GetByte(int i) { return r.GetByte(i); }
    public override long GetBytes(int i, long o, byte[] b, int bo, int l) { return r.GetBytes(i, o, b, bo, l); }
    public override char GetChar(int i) { return r.GetChar(i); }
    public override long GetChars(int i, long o, char[] b, int bo, int l) { return r.GetChars(i, o, b, bo, l); }
    public override string GetDataTypeName(int i) { return r.GetDataTypeName(i); }
    public override DateTime GetDateTime(int i) { return r.GetDateTime(i); }
    public override decimal GetDecimal(int i) { return r.GetDecimal(i); }
    public override double GetDouble(int i) { return r.GetDouble(i); }
    public override IEnumerator GetEnumerator() { return r.GetEnumerator(); }
    public override Type GetFieldType(int i) { return r.GetFieldType(i); }
    public override float GetFloat(int i) { return r.GetFloat(i); }
    public override Guid GetGuid(int i) { return r.GetGuid(i); }
    public override short GetInt16(int i) { return r.GetInt16(i); }
    public override int GetInt32(int i) { return r.GetInt32(i); }
    public override long GetInt64(int i) { return r.GetInt64(i); }
    public override string GetName(int i) { return r.GetName(i); }
    public override int GetOrdinal(string name) { return r.GetOrdinal(name); }
    public override DataTable GetSchemaTable() { return r.GetSchemaTable(); }
    public override string GetString(int i) { return r.GetString(i); }
    public override object GetValue(int i) { return r.GetValue(i); }
    public override int GetValues(object[] values) { return r.GetValues(values); }
    public override bool IsDBNull(int i) { return r.IsDBNull(i); }
    public override bool NextResult() { return false; }
    public override bool Read() { return r.Read(); }
  }
}
