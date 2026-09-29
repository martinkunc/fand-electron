# SkodaXml.exe – ISDOC invoice → ŠKODA AUTO EDI XML ("Faktura Škoda XML")

`{free}\SkodaXml.exe` (292 KB, .NET Framework 4.0 WinForms, assembly `FakturaSkoda`
0.0.1.5, © Martin Zemek, built Feb 2020). This is a **stand-alone add-on** for suppliers of
ŠKODA AUTO a.s. It opens an ISDOC invoice that Účto exported, lets the user fill in the
order number, delivery-note number and supplier code, and saves the invoice in Škoda's EDI
XML format (`<EDIfile>`), which is then uploaded to Škoda's supplier portal.
Decompiled source: `work/decompiled/{free}_SkodaXml/` (entry `FakturaSkoda/Program.cs`,
UI `FakturaSkoda.UI/FormMain.cs`, conversion `FakturaSkoda.Skoda/Import.cs`).

## How Účto calls it

**Účto never calls it directly.** No chapter, `.BAT` or `FAND.CFG` string names
`SkodaXml` or `{FREE}`. The help text (`HELP.T00`) lists `{FREE}` as "doplňkové programy"
(add-on programs). Two ways it reaches the user:

1. **File association.** Účto exports invoices to ISDOC in MODUL06: invoice print menu
   **"Faktura ISDOC"** (`MODUL06_PRO/0131_P_FaktSF6x.txt`, `0163_P_FaktTisk1.txt` →
   `proc(FakturaI,…)`, `0097_P_FakturaI.txt`). For each marked invoice it runs the report
   `FakturaI` (ISDOC 6.0.1, `http://isdoc.cz/namespace/2013`), converts it to UTF-8
   (`proc(Utf8,…)`), and saves it to `{MAIL}\<pattern>.isdoc`. The pattern is
   `PAR06A3.FaIsSoub`, default `?d_?f ?o (?c)`, set in "FAKTURA ISDOC" parameters
   `0019_E_ParFaIsdoc.txt`. Then:
   ```
   if PAR06A3.FaIsRun then begin if PARAM3.SyncW then delay(1000);
     proc(CallAssoc,(p+s)); if exitcode=2 then PAR06A3.FaIsRun:=false; end;
   ```
   `FaIsRun` ("spustit asociovaný ISDOC Reader", default `true`) opens the last exported file
   with the Windows-associated program. If the user associated `.isdoc` with
   `SkodaXml.exe`, it starts with `args[0]` = that file.
2. **Manual start** from `{FREE}` (Explorer/shortcut) with no args. It then shows an open
   dialog "Faktura účto isdoc (*.isdoc)|*.isdoc".

| | |
|---|---|
| Command line | optional `args[0]` = path of an `.isdoc` file |
| Working dir | wherever it is started from; settings `fskoda.json` are read and written in the **current directory** |
| Input | ISDOC 6.0.1 XML (UTF-8) as produced by Účto's report `FakturaI` |
| Output | `<OutputFolderName or Desktop>\<invoice ID or "faktura-skoda">.xml`, or the fixed name `SkodaInvoiceFileName` from settings |
| Exit code / result | none; the user closes the window |

## What it does (decompiled C#)

1. `FormMain_Shown` → `SkodaFakturaTest01`: load the file (from args or the dialog, where a
   cancel shows "Importní soubor neexistuje."). `IsdocHelper.GetInvoice` →
   `XmlSerializer<Invoice>` (ISDOC classes in `FakturaSkoda.Isdoc/`). A missing file →
   "Soubor\r\n<path> nebyl nalezen."; a wrong structure → "Vstupní soubor neodpovídá
   požadované struktuře."
2. `Import.ConvertToSkodaInvoice` maps ISDOC → `EDIfile`:
   * `Communication/InterchangeRef` = `""`; `From/EdiID` = supplier
     `PartyIdentification/UserID`; `To/EdiID` = constant `"O0013000001VW      R3A"`.
   * `Message/@TypeIdentifier`: ISDOC `DocumentType` 1→`380` Faktura, 2→`381` Dobropis,
     3→`383` Vrubopis, 4→`386` Zálohová faktura (default `380`).
   * `Header`: `UniqDocNo`=`ID`, `IssueDate`, `ValidityDate`=`TaxPointDate`,
     `DueDate`=`PaymentMeans/Payment[0]/Details/Items[0]`, `InvoiceCurrency`=`LocalCurrencyCode`,
     `MaterialIndication`=`PM` (the user can choose PM Výrobní materiál / OM Ostatní materiál /
     S Služby), and `Registration/TextLine1` = supplier `RegisterIdentification` with newlines
     folded to spaces.
   * `Partner[0]` (`SE` = supplier): code `UserID` (overridden by settings
     `SkodaSupplierCodeNumber`), name, `StreetName BuildingNumber`, city, ZIP, `GovID`=IČO,
     `VATregID`=DIČ, and `Bank` from `Details.Items[1..6]` (account, bank code, bank name,
     IBAN, SWIFT, VS). These are **positional** and rely on the element order of Účto's
     ISDOC `PaymentMeans` block.
   * `Partner[1]` (`BY` = buyer, `PartCodeIssuer`=`92`) from `AccountingCustomerParty`.
   * `PaymentTerms`: type `1`, time-ref `140`, `RelatedDate` = due date.
   * `LineItem[]` for every ISDOC line with quantity > 0: `LineNo`=`ID`. `ArticleNo` is the
     text between two `*` in the line description (`"*ABC123* Šroub"` → `ABC123`), and
     `ArtDescript` is the rest. `InvoicedQty` `0.00`, `MeaUnit`=`unitCode`,
     `GrossItemAmount`=`LineExtensionAmount`. `UnitPrice`: amount/qty, and if < 1 it is
     scaled ×100 with `UnitGrossBasis=100`. `VAT` rate and amount. `DocumentRefs`
     `OrderNo`/`DeliveryNoteNo` are empty until the user fills them (editable grid columns
     "Objednávka", "Dod. list", "Kód položky"); an empty value becomes `0` on save.
   * `TaxInformation/TextLine1` = the first line's `VATNote`.
   * `InvCurrencyTotal`: `InvoiceTotal`=PayableAmount, `InvoiceNetTotal`=TaxExclusiveAmount,
     `TotalLineItems`, `TotalVAT`, `Rounding`.
   * `InvoiceTax[]` per ISDOC `TaxSubTotal`: `Qualifier=VAT`, `TaxCategory` from the
     percentage table **S=21, L=15, Z=0** (H, E have no percentage). **Bug:** since 2024
     the Czech reduced rate is **12 %**. `GetTaxCategory(12)` finds nothing and throws
     (NullReference), so any invoice with a 12 % line fails ("Chyba: …"). The UI summary
     also throws "Neznámá sazba DPH (…)" for other categories.
3. The UI (WinForms) shows the header (type, number, dates, currency, VS, order, delivery
   note, processing indicator), supplier and customer panels, the line grid, and VAT totals
   per rate. Toolbar: open, save, settings, about, quit ("Přejete si aplikaci ukončit?").
4. **Save** (`toolStripBtnSave_Click`): the supplier code must be non-empty and not `00000`
   ("Číslo dodavatele musí být vyplněno dle smlouvy se ŠKODA AUTO a.s.."). Then
   `SkodaHelper.SaveToXml`: `XmlSerializer` without namespaces, indented, into a UTF-8
   string writer (declaration `encoding="utf-8"`). **Diacritics are stripped** (NFD, drop
   non-spacing marks, NFC), and the file is written UTF-8 without a BOM. MessageBox
   "Faktura byla uložena do:\n\r<path>".
5. Settings dialog (`FormSettings`) → `fskoda.json` (JavaScriptSerializer) with
   `OutputFolderName`, `SkodaInvoiceFileName`, `UseDefaultSkodaInvoiceFileName`,
   `SkodaSupplierCodeNumber`, `LogName`.

Output skeleton (element order from `[XmlElement(Order=n)]`; empty elements are omitted):
```xml
<?xml version="1.0" encoding="utf-8"?>
<EDIfile>
  <Communication><InterchangeRef /><From><EdiID>…</EdiID></From><To><EdiID>O0013000001VW      R3A</EdiID></To></Communication>
  <Interchange>
    <Message TypeIdentifier="380">
      <Header>
        <UniqDocNo>FV2026001</UniqDocNo><IssueDate>2026-09-01</IssueDate><ValidityDate>…</ValidityDate>
        <DueDate>…</DueDate><InvoiceCurrency>CZK</InvoiceCurrency><MaterialIndication>PM</MaterialIndication>
        <Registration><TextLine1>…</TextLine1><TextLine2 /><TextLine3 /></Registration>
        <TaxInformation><TextLine1>…</TextLine1></TaxInformation>
        <Partner><PartTypeCode>SE</PartTypeCode><PartCode>12345</PartCode>…<Bank>…</Bank></Partner>
        <Partner><PartTypeCode>BY</PartTypeCode>…</Partner>
        <PaymentTerms><PaymentTermsType>1</PaymentTermsType><PaymentTimeRef>140</PaymentTimeRef><RelatedDate>…</RelatedDate></PaymentTerms>
        <LineItem><LineNo>1</LineNo><ArticleNo>…</ArticleNo><ArtDescript>…</ArtDescript><InvoicedQty>2.00</InvoicedQty>
          <MeaUnit>ks</MeaUnit><GrossItemAmount>…</GrossItemAmount>
          <DocumentRefs><OrderNo>…</OrderNo><DeliveryNoteNo>…</DeliveryNoteNo></DocumentRefs>
          <UnitPrice><UnitGross>…</UnitGross><UnitGrossBasis>1</UnitGrossBasis></UnitPrice>
          <VAT><VATrate>21.00</VATrate><VATperItem>…</VATperItem></VAT></LineItem>
        <InvCurrencyTotal>…</InvCurrencyTotal>
        <InvoiceTax><Qualifier>VAT</Qualifier><TaxCategory>S</TaxCategory><TaxRate>21.00</TaxRate>…</InvoiceTax>
      </Header>
    </Message>
  </Interchange>
</EDIfile>
```
(Child order inside `UnitPrice`, `VAT`, `DocumentRefs`, `Registration` and `CheckSums` must be
taken from the respective `FakturaSkoda.Skoda/*.cs` `Order=` attributes when implementing.)

## Replacement design (Node/TypeScript)

This is not an Účto-integrated helper, so there is no EXEC key. Options:

* **Recommended: a small built-in tool** in the Electron shell (menu "Nástroje → Faktura
  Škoda XML…"). It is also offered after an ISDOC export when the user enables
  "open associated ISDOC reader". The engine's `CallAssoc` for `.isdoc` goes to
  `ctx.host.openPath`, and the OS may have its own ISDOC reader. We can add a setting "open
  ISDOC in Faktura Škoda" that routes to our tool instead.
* Module `src/tools/skodaxml/` (TS, no engine dependency):
  * `isdoc.ts`: parse ISDOC 6.0.1 with `fast-xml-parser` by **element name**, not by
    position (read `PaymentDueDate`, `ID`, `BankCode`, `Name`, `IBAN`, `BIC`,
    `VariableSymbol` from `Details`). This fixes the fragile `Items[n]` indexing.
  * `convert.ts`: the mapping above, as a pure function `isdocToSkoda(isdoc, opts)`.
    VAT category by rate: 21→`S`, **12→`L`** (and 15/10→`L` for older invoices), 0→`Z`;
    exempt → `E`. Make the table data-driven.
  * `serialize.ts`: an ordered element writer (`xmlbuilder2`) that omits empty elements, with
    `normalize('NFD').replace(/\p{Mn}/gu,'')` for the diacritics strip, written UTF-8 without
    a BOM.
  * UI: a React form in an Electron window (header fields, editable Objednávka / Dod. list /
    Kód položky per line, VAT summary, Save → `dialog.showSaveDialog` with the default folder
    and name from settings). Settings go in the app's user-data JSON instead of `fskoda.json`
    in the cwd.
* No network or certificates are needed. The upload to Škoda's portal stays manual.

Still worth replacing: **low priority.** Only a few users (Škoda suppliers) need it, it is
not wired into Účto, and the Windows exe can still be run by those users on Windows. If
ported, fix the 12 % VAT bug.

## Test approach

* Fixtures: ISDOC files produced by the engine's `FakturaI` report from the `{prik}` sample
  invoices (FAKT_VH/FAKT_VP), including a 21 %, a 12 % and a 0 % line, a credit note
  (DocumentType 2), and a description with `*ART*`.
* Golden output: run the original `SkodaXml.exe` once (Wine/VM) on 21 %-only fixtures and
  commit the XML. Compare canonicalized. For 12 % fixtures, assert our table maps to `L` (the
  original crashes).
* Unit tests: `GetArticleNo`/`GetArticleName` edge cases (0, 1, 2, 3 asterisks),
  `UnitPrice` scaling for < 1, and diacritics stripping.
