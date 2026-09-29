# UCTOGRAF.EXE – "ÚčtoGraf": interactive charts of Účto data

`{tisk}\UCTOGRAF.EXE` (141 KB, 2007). A **native VB6** app using the **MSChart 2.0** control
(`MSCHRT20.OCX`), `COMCTL32.OCX` and `COMDLG32.OCX`. Settings in `{tisk}\UCTOGRAF.INI`
(CP1250). Version comment "Tisk grafů z programu účto". It shows a window with a chart the
user can restyle, print (A4) or save (WMF/BMP).

## How Účto invokes it

Two FAND wrappers (`MODUL01_PRO/0596_P_UctoGraf.txt`, `0597_P_UctoGrafK.txt`):

```
UctoGraf(PARAM1:file; Údaje; Filtr; Záhlaví; Zápatí; Legenda; OsaX; OsaY; Typ)
  Údaje:=replace(',',Údaje,'\13\10'); j:=linecnt(Údaje);
  forall VetaP (evalb(Filtr)) do begin               { one data line per record }
    data += ' ' + <field1>;<field2>;…;<fieldj>          { field1: Datum→'DD.MM.YY', RokMes→'YY/MM', text, else str(num,'0') }
  end;
  par:=str(linecnt(data),'0')+','+str(j,'0')+crlf+
       '"'+Trail(Záhlaví)+'","'+Trail(cond(Zápatí<>'':Zápatí,else:PARAM2.Hlavička))+'"'+crlf+
       Legenda+crlf+
       '"'+OsaX+'","'+cond(OsaY<>'':OsaY,else:'Částka')+'"'+crlf+
       XPath(UCTOTXT2.Path)+crlf+cond(Typ<>'':Typ,else:'S2,V');
  puttxt(UCTOTXT3,par); copyfile(UCTOTXT3,UCTOTXT,mode='LW');     { params → UCTOTXT.UUU, CP1250 }
  puttxt(UCTOTXT3,data); copyfile(UCTOTXT3,UCTOTXT2,mode='LW');   { data   → UCTOTXT2.UUU, CP1250 }
  if PARAM3.DOSBox then proc(ExecWin,(FILE.Path,'$ '+UCTOTXT.Path))
  else begin puttxt(UCTOTXT3,FILE.Path+' $ '+UCTOTXT.Path); exec('{tisk}\caller.exe','# '+UCTOTXT3.Path,nocancel); end;
```

`UctoGrafK` (pie) differs: one data line ` ;v1;v2;…;vn` (at most 50 values), legend
`#name1#name2…`, header `1,<n+1>`, and type `K%,V`.

| | |
|---|---|
| Command line | `$ <UCTOTXT.UUU>`, started through [CALLER](caller.md) (asynchronous) |
| Param file (CP1250) | line 1 `rows,cols`; line 2 `"title","footer"`; line 3 legend: `#`-separated series names, the text before the first `#` being the category label (e.g. `Rok#Zisk/Ztráta`, `#Tarif#Příplatky#…`); line 4 `"X axis","Y axis"`; line 5 the data file path; line 6 the type |
| Data file (CP1250) | one line per category: ` <label>;<v1>;…` (a leading space, `;`-separated, integers) |
| Type | `S2`/`S3` bar 2D/3D, `L2`/`L3` line 2D/3D, `K` pie, `K%` pie in %. After the comma: `V` or `N` (inferred: `V` = series side by side, "údaje samostatně"; `N` = stacked, "údaje v součtu", used for the wage components `S2,N`) |

Callers (menu "grafy", item suffix `g`):
MODUL09 přehledy (`0260_P_PrehlPenize` daily/weekly/monthly cash movements and balances,
`0243_P_Roky`/`0240_P_RokySG` years profit/loss, `0234/0235/0233_P_MesiceSG*` months,
`0250–0253_P_SrovnaniSG*` comparisons of up to 10 years, `0216_P_JmeniMesice` net worth,
`0319_P_DphSestavy` VAT `S2,N`, `0086/0088_P_Doklady*`), MODUL04 `0492_P_GrafyMWin`
(wages: gross, components, deductions, averages, all `S2,N`), and MODUL01 `0062_P_TiskUcto`.
Pie charts come from `UctoGrafK`: income/expense structure by category.

## What it does (strings)

* It reads the params (`s:CtiGrafParam`) and the data (`s:CtiUctoData`); errors "Graf
  nelze zobrazit. chybné parametry".
* It shows an MSChart. The window menu lets the user switch between "sloupcový graf 2D",
  "sloupcový graf 3D (CTRL+Levé tlačítko myši pro otáčení)", "čárový graf 2D/3D",
  "koláčový graf", "koláčový graf v %", "údaje v součtu" / "údaje samostatně", and choose
  which series to show ("Musíte vybrat alespoň jeden údaj."). The texts can be edited
  through input boxes ("Zadejte titulek grafu:", "…text zápatí grafu:", "…text popisku
  osy:"). Value tooltips use `Hodnota údaje "…": ` with the number format `# ### ###`.
* It prints ("Graf se vytiskne na A4.") and saves as `.wmf`/`.bmp` (with an overwrite
  prompt).
* `UCTOGRAF.INI` ([GLOBAL]: full screen, legend for a single series, centre window, pie
  legend outside; [FONTY]: font sizes for the title 16, footer 12, legend 7, axis titles 10,
  axis values 7; [TEXTY]: underline/bold flags for the title, footer and axis labels, and
  the legend frame).
* A missing OCX → "Před prvním použitím programu ÚčtoGraf musíte doinstalovat vyžadované
  komponenty…"

## Replacement design (Node/TypeScript + Electron)

Module `src/engine/helpers/uctograf.ts`, key `uctograf.exe`. Effort **M**. Priority
**low–medium** (nice to have; the data are also available as text reports).

1. Parse the param and data files (**CP1250**, `iconv-lite`). Build a `ChartSpec { title,
   footer, categoryLabel, series[], categories[], values[][], xTitle, yTitle, kind,
   stacked }`.
2. `ctx.host.showChart(spec)` → the Electron main process opens a separate
   `BrowserWindow` (not the DOS console) that renders the spec with **Apache ECharts**
   (bundled; bar/line/pie, stacking, a percentage pie via a label formatter, tooltips with
   Czech number formatting `Intl.NumberFormat('cs-CZ')`). Replace 3D with 2D plus a
   perspective-free style, which is enough.
3. Window toolbar: type switch, stacked/separate, series checkboxes, edit
   title/footer/axis (inline inputs), **Tisk** (`webContents.print`, A4 landscape) and
   **Uložit** (PNG via `echarts.getDataURL`, or SVG with the SVG renderer; WMF/BMP are
   obsolete).
4. Read `UCTOGRAF.INI` for the initial font sizes and flags, and write it back when the
   user changes settings (keep the file format: `[SECTION]`, `key=A/N/number`, CP1250).
5. Fire-and-forget. The helper resolves once the window is open, as CALLER does not
   wait. Headless mode records the spec.

## Test approach

* Parser: the output of `UctoGraf` for `PrehlPenize` from the engine on `{prik}` (CP1250),
  and a hand-made pie file (`1,6` + ` ;10;20;…`). Snapshot the `ChartSpec` JSON.
* Legend parsing: `Rok#Zisk/Ztráta` → category label `Rok`, series `[Zisk/Ztráta]`;
  `#Tarif#Příplatky` → an empty category label and 2 series.
* Type parsing: `S2,V`, `S2,N` (stacked), `K%,V`, and garbage → the default `S2,V`.
* Renderer: a Playwright/Electron smoke test that opens the chart window with a spec and
  checks for a canvas and the title text (optional, CI with xvfb).
* EngineDriver: MODUL09 → Grafy → "Měsíční pohyby peněz" → the helper is invoked
  through `caller.exe` with `$ …UCTOTXT.UUU`.
