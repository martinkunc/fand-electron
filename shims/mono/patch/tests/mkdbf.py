#!/usr/bin/env python3
"""Writes a DBF the way FAND's WrDBaseHd does (dBASE III, 0x83 with a .DBT memo, CP852,
language-driver byte 0), with one deleted record. Usage: mkdbf.py <out.dbf>"""
import struct, sys, datetime, os

def main(path):
    fields = [("CISLO", "N", 5, 0), ("NAZEV", "C", 30, 0), ("DATUMPOŘ", "D", 8, 0),
              ("CASTKA", "N", 12, 2), ("PLATCE", "L", 1, 0), ("POZN", "M", 10, 0)]
    rows = [
        (" ", ["1", "Škoda Auto a.s.", "20260928", "1234.50", "T", "Poznámka k firmě\r\nřádek 2"]),
        (" ", ["2", "Žluťoučký kůň", "", "-5.00", "F", None]),
        ("*", ["3", "Smazaný záznam", "20260101", "1.00", "T", None]),
        (" ", ["", "", "", "", "?", None]),
    ]
    memo_blocks = [b""]  # block 0 = header
    recs = []
    for flag, vals in rows:
        rec = flag.encode("ascii")
        for (name, t, ln, dec), v in zip(fields, vals):
            if t == "M":
                if v:
                    memo_blocks.append(v.encode("cp852") + b"\x1a\x1a")
                    v = str(len(memo_blocks) - 1).rjust(ln)
                else:
                    v = ""
                rec += v.encode("ascii").ljust(ln, b" ")
            elif t in "ND":
                rec += v.encode("ascii").rjust(ln, b" ")
            else:
                rec += v.encode("cp852").ljust(ln, b" ")[:ln]
        recs.append(rec)
    hdr_len = 32 + 32 * len(fields) + 1
    rec_len = 1 + sum(f[2] for f in fields)
    d = datetime.date(2026, 9, 28)
    out = struct.pack("<BBBBIHH20x", 0x83, d.year - 1900, d.month, d.day, len(recs), hdr_len, rec_len)
    for name, t, ln, dec in fields:
        out += name.encode("cp852")[:11].ljust(11, b"\0") + t.encode("ascii") + b"\0" * 4 + bytes([ln, dec]) + b"\0" * 14
    out += b"\r" + b"".join(recs) + b"\x1a"
    open(path, "wb").write(out)
    dbt = os.path.splitext(path)[0] + (".DBT" if path.endswith(".DBF") else ".dbt")
    blocks = [struct.pack("<I", len(memo_blocks)).ljust(512, b"\0")]
    for b in memo_blocks[1:]:
        blocks.append(b.ljust(((len(b) + 511) // 512) * 512, b"\0"))
    open(dbt, "wb").write(b"".join(blocks))

main(sys.argv[1])
