# Akij Agro Feed — Shed-Condition Score & Farm Tiering

**Plan and progress tracker.** Single source of truth for this project.

| | |
|---|---|
| **Last updated** | 2026-08-12 |
| **Overall progress** | 5 of 8 phases complete — extraction layer and scoring engine built and tested; spec-mode figures blocked on warehouse access |
| **Current phase** | Phase 4 — Scoring engine (built; spec-mode validation pending DB) |
| **Authority** | `Technical Services (Poultry & Cattle) - App Contents.xlsx` — all 18 sheets read |
| **Scoring** | Two modes from one engine — **spec** (production) and **prototype** (reproduces the dashboard exactly). §4 |
| **Reporting window** | Rolling **90 days** |
| **Blocked on** | **Warehouse unreachable** — `203.202.241.211:1433` times out at TCP level (general outbound works). Spec-mode numbers need it. §9 |
| **Files** | `.env`, `.gitignore`, `PLAN.md`, `package.json`, `config/`, `src/`, `scripts/`, `test/`, `out/`, `dashboard.html`, `Farm_Condition_Report.xlsx`, `Farm_Condition_Scores_july.xlsx`, `Technical Services (Poultry & Cattle) - App Contents.xlsx` |

```
Phase 0    Access & environment         ████████████████████  DONE
Phase 1    Data discovery               ████████████████████  DONE
Phase 2    Scoring rule recovery        ████████████████████  DONE
Phase 2.5  Business-rule reconciliation ████████████████████  DONE
Phase 3    Extraction layer             ████████████████████  DONE (SQL untested vs live DB)
Phase 4    Scoring engine (both modes)  ███████████████░░░░░  BUILT — 18/18 unit gates pass
Phase 5    Bangla report renderer       ░░░░░░░░░░░░░░░░░░░░  not started
Phase 6    Mail + scheduler             ░░░░░░░░░░░░░░░░░░░░  not started
Phase 7    Data-gap & contact drive     ░░░░░░░░░░░░░░░░░░░░  not started
```

---

## 1. Context

Akij Agro Feed supplies ~5,900 registered farms across Bangladesh. Field officers record visits into the ERP; the data lands in the `DWH` warehouse, `farm` schema. Nothing today scores or ranks those farms, and no feedback returns to the farmer.

Goal: a scheduled, read-only job that scores every scorable farm on shed condition, assigns Green/Yellow/Red, and emails a Bangla advisory report to every farm below Green every three weeks, over a rolling 90-day window.

Three reference artefacts exist:

- **`Technical Services (Poultry & Cattle) - App Contents.xlsx` — the authority.** Its two *Farm condition Graph* sheets define the parameters, the marking scheme, the band cutoffs and the ammonia override. All 18 sheets read.
- **`dashboard.html` — the prototype.** A working dashboard that shipped precomputed scores and no scoring code. Its rule was fully reverse-engineered (§4.9) and proved *algebraically identical* to the spec's formula, but its **parameter set differs** (§4.7). It is frozen at 2026-07-19.
- **`Farm_Condition_Report.xlsx` — an export from that prototype**, used as the regression fixture for prototype mode (§6.1).

The engine implements **both** rules and switches by config. Production runs on the spec; prototype mode exists so the dashboard's numbers can be reproduced on demand and the difference explained rather than argued about.

---

## 2. Phase 0 — Access & environment · **DONE**

- [x] Warehouse reachable: `203.202.241.211,1433` / `DWH` as `mcp_user`, over ADO.NET. SQL Server 2019 CU32 on Ubuntu 20.04. 366 objects across 24 schemas
- [x] Credentials in `.env`
- [x] **No MCP server is configured anywhere** — `~/.claude/settings.json` holds only plugin/model settings, all four project entries in `~/.claude.json` carry `"mcpServers": {}`, no `%APPDATA%\Roaming\Claude\claude_desktop_config.json`, no `.mcp.json`. Production code connects directly via node `mssql`
- [x] Prototype captured as `dashboard.html`; its export captured as `Farm_Condition_Report.xlsx`
- [x] Authoritative workbook received (18 sheets, all read)

**Outstanding, not blocking:** `MSSQL_ENCRYPT=false` with `MSSQL_TRUST_SERVER_CERTIFICATE=false` means login and query traffic cross the network unencrypted, and the `mcp_user` password has been pasted into a chat transcript. Rotate the password and enable TLS on the SQL listener before go-live; confirm `mcp_user` holds `SELECT`-only rights. Add `.env` to `.gitignore` **before** the first commit.

---

## 3. Phase 1 — Data discovery · **DONE**

### 3.1 The nine candidate columns, all on `farm.tblFarmRecordArc`

Every one is a closed-domain label. **No free-text parsing anywhere in this system.**

| # | Parameter | Column | Col | Values (all-time counts) |
|---|---|---|---|---|
| 1 | Height of feeders | `strHeightOfFeeder` | 48 | Equal to back position 7,404 / Below than back position 1,862 / Upper than back position 1,241 |
| 2 | Height of drinkers | `strHeightOfDrinker` | 45 | Equal to back position 7,480 / Upper than back position 1,593 / Below than back position 1,420 |
| 3 | Litter materials | `strLitterMaterials` | 51 | Rice husk 4,174 / Others 2,758 / Wood shavings 1,975 / Sawdust 1,103 / Sand 277 / Straw 211 |
| 4 | Litter condition | `strLitterCondition` | 53 | Standard 6,773 / Dry 1,786 / Moist 1,207 / Dusty 593 / Heavy moist 91 |
| 5 | Curtain management | `StrCurtainManage` | 55 | Top to bottom 6,277 / Open up and down 2,173 / Bottom to Top 1,951 |
| 6 | Humidity | `strHumidity` | 38 | Within range 7,140 / High 3,016 / Low 336 |
| 7 | Ventilation | `strVentilation` | 42 | Satisfactory 9,271 / Unsatisfactory 1,185 |
| 8 | Ammonia concentration | `strAmonia` | 40 | Good (< 10 ppm) 8,710 / Alarming (11 - 25 ppm) 1,703 / Risky (> 25 ppm) 52 |
| 9 | Stocking density | `strStockingDensity` | 75 | Normal 2,086 / High 331 / **blank 13,195 (85%)** |

Match ammonia on a normalised prefix (`Risky`, `Alarming`, `Good`), never the full literal, so an upstream spacing change cannot silently kill the override.

The spec sheet spells two values differently from the warehouse — `Wood savings` for `Wood shavings`, `Saw dust` for `Sawdust`. Both score 50 either way, so it is cosmetic, but match on the warehouse spelling.

**Correction to a common claim:** `strHumidity` is not free text needing numeric parsing — 0 rows parse as numeric, 10,492 are one of three labels. `strTemperature` genuinely is free text, is captured on the visit form, and is **not** scored.

### 3.2 Scorable population — spec mode

At least one scored parameter recorded:

| Farm type | Group | Visits 90d | Farms 90d | Visits 365d | Farms 365d |
|---|---|---|---|---|---|
| Broiler | meat bird | 3,923 | 1,407 | 5,568 | 1,877 |
| Layer | layer | 2,763 | 667 | 3,903 | 833 |
| Colour | meat bird | 1,132 | 346 | 1,405 | 433 |
| Sonali | meat bird | 766 | 220 | 981 | 291 |
| Duck | layer | 153 | 43 | 171 | 44 |
| **Total** | | **8,737** | **2,683** | **12,028** | **3,478** |

Measured before stocking density joined the set, so a floor. **Re-measure in Phase 3.**

Cattle (665 farms) and Fish (643 farms) record none of the nine, ever. Both go to the data-gap list.

### 3.3 Defects

1. **Duplicate rows** — 1,315 `(intFarmId, intShadeId, date)` groups hold 3,052 rows in 365 days. Deduplicated in spec mode, **kept** in prototype mode
2. **Future-dated rows** — 2 rows beyond today, max 2027-04-28. Filtered in spec mode, **kept** in prototype mode
3. **`strFarmType` value `Colour ` carries a trailing space** — trim everywhere or 1,405 visits vanish
4. **Empty strings, not NULLs** — presence tests must be `NULLIF(LTRIM(RTRIM(col)), '') IS NOT NULL`. A bare `IS NOT NULL` counts blanks as recorded, changing every denominator and therefore every score
5. **Case drift** — the curtain column is `StrCurtainManage` (capital `S`). One canonical mapping in config
6. **Age sanity limits** (sheet *Sheet10*): Broiler 42 days, Sonali 70, Layer 700. Flag breaches for review; do not drop — age does not affect the score, but a breach signals a bad record

---

## 4. Phases 2 + 2.5 — The rule · **DONE**

### 4.1 Shared formula — identical in both modes

```
parameter mark:  good value -> 100      any other recorded value -> 50

visit score:
  params = the mode's parameter set, restricted to those NOT blank on this row
  if params is empty                -> visit excluded entirely
  if ammonia starts with "Risky"    -> visit score = 0        (overrides everything)
  else                              -> mean of the marks       ( = 50 + 50*good/count )

farm score = plain arithmetic mean of its visit scores in the window
display    = round half away from zero to 1 decimal
band       = from the UNROUNDED mean:  >= 80 Green/A | >= 65 Yellow/B | else Red/C
```

The spec expresses this as "mark each parameter 100 or 50 and average them"; the prototype computes `50 × (1 + good/count)`. Same arithmetic. The Broiler sheet's own worked example confirms it: nine marks of `100,100,100,100,50,50,50,50,50` → 72.222 (cell D7).

### 4.2 Good values — identical in both modes

| Parameter | Column | Scores 100 | Scores 50 |
|---|---|---|---|
| Height of feeders | `strHeightOfFeeder` | `Equal to back position` | Upper, Below |
| Height of drinkers | `strHeightOfDrinker` | `Equal to back position` | Upper, Below |
| Litter materials | `strLitterMaterials` | `Rice husk` | Wood shavings, Sawdust, Sand, Straw, Others |
| Litter condition | `strLitterCondition` | `Standard` | Dry, Dusty, Moist, Heavy moist |
| Curtain management | `StrCurtainManage` | `Bottom to Top` | Top to bottom, Open up and down |
| Humidity | `strHumidity` | `Within range` | High, Low |
| Ventilation | `strVentilation` | `Satisfactory` | Unsatisfactory |
| Ammonia concentration | `strAmonia` | `Good (< 10 ppm)` | Alarming — `Risky` forces the visit to 0 |
| Stocking density | `strStockingDensity` | `Normal` | High |

Two are counter-intuitive and confirmed official off the spec sheet: **curtain `Bottom to Top` scores 100 while `Top to bottom` scores 50**, and **`Rice husk` is the only litter material scoring 100**. Both were raised as suspected errors. They are not.

### 4.3 Mode A — **spec** (production)

Parameter sets differ by livestock group:

- **Meat bird — Broiler, Sonali, Colour — 9 parameters:** all of the above
- **Layer group — Layer and Duck — 5 parameters:** curtain, humidity, ventilation, ammonia, stocking density. Feeder height, drinker height, litter material and litter condition are **excluded even when recorded**
- **Cattle and Fish — not scored**

Duck sits in the Layer group on the workbook's own evidence: sheet *Report* row 8 is headed **"Layer/Duck"** and lists exactly the Layer field set. Corroborated by *Correction - app info* row 18, *"Optional for Layer"* on the feeder fields.

Cattle's visit form does carry a *Farm Condition* field, but unlike the meat-bird and Layer forms it is **not marked "(Auto)"** — Cattle condition is entered by hand, so no computed rule exists or is expected.

Cleaning: deduplicate to the highest `intRecordId` per `(farm, shed, date)`; exclude future dates.

### 4.4 Mode B — **prototype** (dashboard-compatible)

**One parameter set for every farm type: the first 8 rows of §4.2. Stocking density is not used at all.**

Cleaning: **none.** Duplicates counted twice, future dates included, no farm-type filter, no minimum parameter count. Cattle and Fish fall out on their own because they record none of the eight — not because they are excluded.

This mode is not a compromise on correctness; it is a diagnostic. It exists so any question of the form "why does this farm differ from the dashboard" can be answered by running both and diffing.

### 4.5 Filters apply to visits, not to farms

True in both modes, and the single easiest thing to get wrong.

Date range, company, farm type, region, territory and age all filter **individual visit rows first**; farms are then grouped from whatever survives. **Company lives on the visit row**, so a company filter changes a farm's visit count and therefore its average — it does not merely subset the farm list.

This is what took longest to establish against `Farm_Condition_Report.xlsx`, and it is what makes that file reproducible (§6.1).

### 4.6 Rounding — two rules that must be copied precisely

1. **Round half away from zero, not half to even.** A visit with 5 of 8 recorded parameters good scores `81.25`, which must become **81.3**. Banker's rounding gives 81.2 and is wrong. In Node `Math.round(v*10)/10` is correct; in .NET use `MidpointRounding.AwayFromZero`
2. **The band comes from the unrounded farm mean.** Display the rounded value, branch on the raw one. A farm averaging 79.96 displays `80.0` and grades **Yellow**. No farm currently hits this (verified: 0 of 3,098), but the first that does must grade correctly

### 4.7 What separates the two modes, and what it costs

| | Spec | Prototype |
|---|---|---|
| Stocking density | 9th parameter | omitted |
| Layer / Duck | 5 parameters | 8 parameters |
| Duplicate shed-day rows | deduplicated | counted twice |
| Future-dated rows | excluded | included |

Measured over 365 days, 3,480 farms: **179 farms (5.1%) land in a different band** — Layer 149, Broiler 28, Colour 1, Sonali 1. Roughly **1 in 6 Layer farms** was mis-tiered by the prototype.

Measured on the `Farm_Condition_Report.xlsx` window (2026-07-01→08-31, company = AKIJ Agro Feed Limited), same visit rows, rule swapped only:

| | Farms | Green | Yellow | Red | Agreement with the export |
|---|---|---|---|---|---|
| Prototype | 510 | 323 | 139 | 48 | 499/500 |
| Spec | 506 | 329 | 125 | 52 | **457/500 (91.4%)** |

Four farms vanish under spec: Layer or Duck farms whose only recorded fields are ones the Layer set excludes.

### 4.8 What the bands demand

**Meat bird / prototype-9, all recorded** — `50 + 50g/9`:

| Good | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|---|
| Score | 50.0 | 55.6 | 61.1 | 66.7 | 72.2 | 77.8 | 83.3 | 88.9 | 94.4 | 100 |
| Band | Red | Red | Red | Yellow | Yellow | Yellow | Green | Green | Green | Green |

**Prototype, all 8 recorded** — `50 + 6.25g`: Green from 5 of 8 (81.3); Yellow at 3–4 (68.8, 75.0); Red at 2 or fewer.

**Layer group, all 5 recorded** — `50 + 10g`:

| Good | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| Score | 50 | 60 | 70 | 80 | 90 | 100 |
| Band | Red | Red | Yellow | Green | Green | Green |

Layer moves in 10-point jumps and **Yellow is reachable only at exactly 2 of 5** — a single point, not a range. State this to stakeholders: Layer and Duck tiering is far coarser, and one parameter can move a Layer farm two bands.

The floor is 50 in every case. Only a Risky ammonia reading produces a genuine 0.

### 4.9 Evidence that the prototype rule is exactly right

The prototype shipped scores with no scoring code; the rule was reconstructed and then verified twice:

| Test | Result |
|---|---|
| Every scored visit in `dashboard.html` | **10,049 / 10,051 exact**, 0 score mismatches. The 2 failures are rows since deleted from DWH |
| `Farm_Condition_Report.xlsx`, 2026-07-01→08-31, company = AKIJ Agro Feed Limited | **500 / 500 exact** on both score and visit count |

Without the company filter the same replay drops to 464/500 — which is how §4.5 was established.

Note on that export: 505 farms qualified but the dashboard's condition table hard-caps at **500 rows sorted by average descending**, so 5 farms and 7 visits were silently dropped. Its Summary sheet reports "Total farms 500", which is the export's own count, not the population.

### 4.10 The band cutoffs — the workbook contradicts itself

| Source | Green | Yellow | Red |
|---|---|---|---|
| *Farm condition Graph* sheets — explicit Range table with A/B/C | 80–100 | 65–79 | 0–64 |
| *Necessary info* row 51 — prose note | ≥80 | 50–79 | <50 |

**Resolved: 80 / 65 / 0.** Confirmed independently by the footnote on `Farm_Condition_Report.xlsx` itself: *">=80 Green · A, 65–79.9 Yellow · B, <65 Red · C"*.

Impact of the alternative, 90-day window, 2,639 farms: Yellow 677 → 889 and Red **226 → 14**. The prose reading is untenable on its own terms — the scale floors at 50, so a Red tier starting below 50 is reachable only through a Risky ammonia reading. All 14 of those farms got there that way, none through management. A tier management cannot fall into is not a tier.

### 4.11 Stocking density is scored only where recorded

Blank on 13,195 of 15,606 rows (85%). It could be derived — *Necessary info* carries a floor-space standard (0.3 / 0.45 / 0.6 / 0.8 / 1.0 / 1.25 / 1.5 sft per bird by age band) and *Farmers Cost-Benefit* defines "Required floor spaces (auto)", so `numFloorSpaceSft ÷ numNoOfHousee` against the standard would yield Normal or High.

**Declined.** The spec averages what was recorded; deriving a value the officer did not observe exceeds what the business authorised and would change scores silently. Recorded values only. Consequence accepted: denominators swing 8/9 for meat birds and 4/5 for the Layer group. The real fix is field collection, tracked in Phase 7.

### 4.12 `config/scoring.json` — spec mode

```json
{
  "_authority": "Technical Services (Poultry & Cattle) - App Contents.xlsx, sheets 'Farm condition Graph for Broile' and 'Farm condition Graph for Layer'",
  "mode": "spec",
  "bands": { "green": 80, "yellow": 65, "fromUnroundedMean": true },
  "rounding": { "decimals": 1, "mode": "halfAwayFromZero" },
  "marks": { "good": 100, "bad": 50 },
  "window": { "mode": "rollingDays", "days": 90 },
  "minParametersRecorded": 1,
  "dedupeShedDay": true,
  "excludeFutureDates": true,
  "ammoniaOverride": { "column": "strAmonia", "matchPrefix": "Risky", "visitScore": 0, "propagateToFarm": false },
  "parameters": {
    "feederHeight":    { "column": "strHeightOfFeeder",  "good": "Equal to back position", "label_bn": "ফিডারের উচ্চতা" },
    "drinkerHeight":   { "column": "strHeightOfDrinker", "good": "Equal to back position", "label_bn": "ড্রিংকারের উচ্চতা" },
    "litterMaterial":  { "column": "strLitterMaterials", "good": "Rice husk",              "label_bn": "লিটারের উপকরণ" },
    "litterCondition": { "column": "strLitterCondition", "good": "Standard",               "label_bn": "লিটারের অবস্থা" },
    "curtain":         { "column": "StrCurtainManage",   "good": "Bottom to Top",          "label_bn": "পর্দা ব্যবস্থাপনা" },
    "humidity":        { "column": "strHumidity",        "good": "Within range",           "label_bn": "আর্দ্রতা" },
    "ventilation":     { "column": "strVentilation",     "good": "Satisfactory",           "label_bn": "বায়ু চলাচল" },
    "ammonia":         { "column": "strAmonia",          "good": "Good (< 10 ppm)",        "label_bn": "অ্যামোনিয়া" },
    "stockingDensity": { "column": "strStockingDensity", "good": "Normal",                 "label_bn": "মজুদ ঘনত্ব" }
  },
  "livestockGroups": {
    "meatBird": { "farmTypes": ["Broiler","Sonali","Colour"],
      "parameters": ["feederHeight","drinkerHeight","litterMaterial","litterCondition","curtain","humidity","ventilation","ammonia","stockingDensity"] },
    "layer": { "farmTypes": ["Layer","Duck"],
      "parameters": ["curtain","humidity","ventilation","ammonia","stockingDensity"] }
  },
  "excludedFarmTypes": ["Cattle","Fish"],
  "ageLimits": { "Broiler": 42, "Sonali": 70, "Colour": 70, "Layer": 700, "Duck": 700 }
}
```

### 4.13 `config/scoring.prototype.json` — prototype mode

Identical file with these overrides. Same `parameters` block, same good values, same bands, same rounding.

```json
{
  "mode": "prototype",
  "minParametersRecorded": 1,
  "dedupeShedDay": false,
  "excludeFutureDates": false,
  "livestockGroups": {
    "all": { "farmTypes": null,
      "parameters": ["feederHeight","drinkerHeight","litterMaterial","litterCondition","curtain","humidity","ventilation","ammonia"] }
  },
  "excludedFarmTypes": []
}
```

`farmTypes: null` means every type falls in one group. Cattle and Fish then score nothing and disappear naturally, which is exactly what the dashboard does.

---

## 5. Build

```
akij-farm-report/
  .env                          # DONE
  .gitignore
  config/
    scoring.json                # §4.12 — spec mode, production default
    scoring.prototype.json      # §4.13 — dashboard-compatible
    recommendations.bn.json     # Bangla advisory text, per parameter
    recipients.json             # channel routing
  src/
    db.js                       # pooled read-only connection + ping()
    extract.js                  # §5.1 — mode-aware SQL
    score.js                    # §4.1 formula, pure, config-driven
    report.js                   # Bangla HTML + PDF per below-Green farm
    mail.js                     # Nodemailer, SEND_TO_ALL kill switch
    run.js                      # orchestrator
  out/                          # generated reports, one folder per cycle
  logs/                         # audit, reconciliation, data-gap, parity
  scripts/
    build-fixtures.js           # dashboard.html + Farm_Condition_Report.xlsx -> test fixtures
  test/
    score.test.js               # §6.2 spec fixtures + §6.3 structural
    prototype.test.js           # §6.1 prototype-mode regression
    fixtures/prototype.json     # 12,612 dashboard visit rows
    fixtures/export-500.json    # the 500 exported farm rows + their filters
```

Cleaning happens **in SQL** inside `extract.js` and varies by mode, so `score.js` stays a pure function of a clean row. That purity is what makes the fixtures meaningful.

### 5.1 Phase 3 — Extraction layer · **NEXT**

- [ ] `package.json` (CommonJS; deps `mssql`, `dotenv`; tests via built-in `node:test`), `.gitignore`
- [ ] `src/db.js` — pooled read-only connection from `.env`; `ping()` returns `@@VERSION`
- [ ] `config/scoring.json` and `config/scoring.prototype.json` — exactly §4.12 and §4.13
- [ ] `src/extract.js` — mode-aware, with the full row-filter set from §4.5: date range, company, farm type, region, territory, age
- [ ] Flag rows breaching the §3.3 age limits rather than dropping them
- [ ] Output a per-visit CSV with all nine parameter values plus farm/region/territory/officer for the report layer
- [ ] **Re-measure §3.2** under the corrected per-group sets and update the table

**Spec mode** — dedupe and future-date guard on:

```sql
WITH ranked AS (
  SELECT r.intFarmId, r.intShadeId, r.intRecordId, r.dteRecordedDate, r.numAgeOfBirds,
         LTRIM(RTRIM(r.strFarmType))                     AS farmType,
         LTRIM(RTRIM(r.strCompany))                      AS company,
         NULLIF(LTRIM(RTRIM(r.strHeightOfFeeder)),   '') AS feederHeight,
         NULLIF(LTRIM(RTRIM(r.strHeightOfDrinker)),  '') AS drinkerHeight,
         NULLIF(LTRIM(RTRIM(r.strLitterMaterials)),  '') AS litterMaterial,
         NULLIF(LTRIM(RTRIM(r.strLitterCondition)),  '') AS litterCondition,
         NULLIF(LTRIM(RTRIM(r.StrCurtainManage)),    '') AS curtain,
         NULLIF(LTRIM(RTRIM(r.strHumidity)),         '') AS humidity,
         NULLIF(LTRIM(RTRIM(r.strVentilation)),      '') AS ventilation,
         NULLIF(LTRIM(RTRIM(r.strAmonia)),           '') AS ammonia,
         NULLIF(LTRIM(RTRIM(r.strStockingDensity)),  '') AS stockingDensity,
         ROW_NUMBER() OVER (
           PARTITION BY r.intFarmId, r.intShadeId, CAST(r.dteRecordedDate AS date)
           ORDER BY r.intRecordId DESC) AS rn
  FROM farm.tblFarmRecordArc r
  WHERE r.dteRecordedDate <= GETDATE()
    AND CAST(r.dteRecordedDate AS date) BETWEEN @fromDate AND @toDate
    AND LTRIM(RTRIM(r.strFarmType)) IN ('Broiler','Sonali','Colour','Layer','Duck')
    AND (@company IS NULL OR LTRIM(RTRIM(r.strCompany)) = @company)
)
SELECT * FROM ranked WHERE rn = 1;
```

**Prototype mode** — same column list, no `ranked` CTE, no `<= GETDATE()`, no farm-type filter:

```sql
SELECT  /* same columns, minus rn */
FROM farm.tblFarmRecordArc r
WHERE CAST(r.dteRecordedDate AS date) BETWEEN @fromDate AND @toDate
  AND (@company IS NULL OR LTRIM(RTRIM(r.strCompany)) = @company);
```

Tables joined for the report layer:

| Table | Rows | Role |
|---|---|---|
| `farm.tblFarmRecordArc` | 15,372 | The only scoring source. One row per officer visit |
| `farm.tblFarmRegistrationArc` | 5,892 (5,688 active) | Farm master — code, name, thana/district/division, lat/long |
| `farm.tblFarmerRegistrationArc` | 5,991 | Owner — name, phone (100%), email (60 valid), dealer, zone |
| `farm.tblAgroTourPlanArc` | 58,204 | Officer↔farm mapping and territory hierarchy |
| `farm.tblShadesRegistrationArc` | 5,899 | Shed master — names sheds in the report |
| `farm.tblMedicineRecordArc` | 1,655 | Optional: disease events as context beside a Red score |

### 5.2 Phase 4 — Scoring engine

- [ ] `scripts/build-fixtures.js` — parse `DATA` (line 230, terminated by `];`) and `LK` (line 231) from `dashboard.html` into `fixtures/prototype.json` (12,612 rows); parse `Farm_Condition_Report.xlsx` into `fixtures/export-500.json` with its filters recorded. Run once, commit
- [ ] `src/score.js` — pure, config-driven:
  - `markFor(parameterId, value)` → 100 on the configured `good`, else 50. **Throws on an unrecognised value** — a silent 50 moves farms between bands
  - `scoreVisit(row, group)` → mean of marks over the group's recorded parameters; `0` when ammonia starts with `Risky`; `null` when nothing recorded
  - `scoreFarm(visitScores)` → `{ mean, display, band }`, half-away-from-zero to 1 dp, band from the **unrounded** mean
  - `groupFor(farmType, config)` → resolves against `livestockGroups`; returns the single `all` group in prototype mode
- [ ] `src/run.js` — `--mode spec|prototype` (default `spec`), `--from`, `--to`, `--company`, `--farm-type`, `--region`, `--territory`, `--only-farm`, `--out`. Writes `out/<cycle>/farms.csv`, `out/<cycle>/visits.csv`, `logs/data-gaps-<date>.csv`
- [ ] `--compare-modes` — run both modes over identical rows and emit `logs/mode-diff-<date>.csv`: farm, type, spec score, prototype score, spec band, prototype band, reason. Expect ~179 farms over a 365-day window, Layer-dominated. **This is the artefact that settles "why doesn't this match the dashboard" arguments**
- [ ] Both gates green (§6)
- [ ] Review the spec-mode distribution with the agronomy team against named farms

### 5.3 Phase 5 — Bangla report renderer

- [ ] `config/recommendations.bn.json` — one short corrective action per parameter, plus a stronger variant for ammonia Risky. Nine parameters, binary marks, so ~11–13 strings. Domain writing, not code
- [ ] Embed **Noto Sans Bengali** so conjuncts render as glyphs, not boxes
- [ ] `src/report.js` — one-pager per below-Green farm: score, band badge, parameter scorecard for that farm's group, the parameters costing the most, corrective actions, trend across recent visits
- [ ] **Benchmark line available** — *Broiler / Brown layer / White layer Performance Standard* sheets give age → body weight, intake, FCR. Decide whether to include in the trend section
- [ ] Sheet *Prescription contents* defines a veterinary prescription layout. Confirm whether the advisory should follow it or stay separate
- [ ] Review 5–10 real farms as PDF before any mail is sent

### 5.4 Phase 6 — Mail and scheduler

- [ ] `config/recipients.json`, `src/mail.js` (Nodemailer, `SEND_TO_ALL` kill switch), `--dry-run` default, per-run message cap
- [ ] One dry-run cycle to `.eml`, then one live send to your own address
- [ ] Windows Task Scheduler entry, every 3 weeks

Coverage measured: farmer email **60 of 5,991** (1.0%), farmer phone **5,991 of 5,991** (100%), dealer email **261 of 700** linked dealers (37%).

**Officer email — corrected.** An earlier version of this plan said officer emails do not exist, because `saas.empEmployeeBasicInfoArc` has no email column. True of that table, but workbook sheets *Report* and *Sheet12* carry a populated **"Visitor Email"** column with real addresses (`tazul@akijagrofeed.com`). Officer emails exist in the source application. **Action: locate that field.** Supporting context from *kpi data*: Farm Visit carries **40% of a Technical Services Officer's KPI**, the largest single weight — officers are already measured on the activity this report reflects.

Build internal-first — a territory digest to zone/area managers and officers — and keep `report.js` channel-agnostic so dealer relay and direct-to-farmer switch on by config. Gmail's ~500/day limit means batching across days or a transactional provider.

### 5.5 Phase 7 — Data-gap and contact drive

- [ ] Data-gap notice for Cattle and Fish. Cattle's *Farm Condition* is manual by design, so the gap is data capture, not scoring
- [ ] **Stocking-density collection drive** — blank on 85% of rows. Highest-value field fix; §4.11 records why derivation was declined
- [ ] Missing-contact worklist so officers collect farmer emails during visits

---

## 6. Verification

### 6.1 Prototype-mode gate — exact, blocking

Prototype mode has a known-correct answer, so it is tested exactly.

- **Export replay** — `fixtures/export-500.json` with its recorded filters (date `2026-07-01`–`2026-08-31`, company `AKIJ Agro Feed Limited`) must reproduce **500 of 500** rows on both average score and visit count. Already demonstrated. One mismatch fails the build
- **Full-dataset replay** — `fixtures/prototype.json`: **10,049 of 10,051** visit scores exact, the only permitted exceptions being the two rows deleted from DWH (farm 2264 / 2026-05-12, farm 4252 / 2026-06-22)
- **Filter semantics** — assert that removing the company filter drops the export replay to **464/500**. This pins §4.5: filters act on visits, not farms. If this assertion ever passes at 500, the filter is being applied at the wrong level
- **Cap behaviour** — assert 505 farms qualify for that window while the export holds 500, and that the 5 omitted are the lowest-scoring

### 6.2 Spec-mode fixtures, transcribed from the workbook

- Broiler sheet worked example: marks `100,100,100,100,50,50,50,50,50` → **72.2** → Yellow (cell D7 reads 72.222…)
- Layer sheet worked example: marks `50,100,100,50,100` → **80.0** → Green (cell D7 reads 80)
- Ammonia Risky with every other parameter good → **0** → Red
- Meat bird: 6 of 9 → 83.3 Green; 3 of 9 → 66.7 Yellow; 2 of 9 → 61.1 Red
- Layer group: 3 of 5 → 80.0 Green; 2 of 5 → 70.0 Yellow; 1 of 5 → 60.0 Red
- `81.25` → `81.3` — banker's rounding gives 81.2 and must fail loudly
- Farm averaging `79.96` → displays `80.0`, grades **Yellow**

### 6.3 Structural assertions

- **Layer-group restriction** — no Layer or Duck spec score is influenced by feeder height, drinker height, litter material or litter condition, even when populated
- **Duck included** in spec mode, scored on five parameters
- **Cattle and Fish** absent from scored output in both modes, present on the data-gap list
- **Dedupe** — spec mode: no `(farm, shed, date)` key survives twice; the raw 365-day window has 1,315 collision groups, the cleaned set 0. **Prototype mode: all 3,052 rows survive**
- **Date guard** — spec mode drops the 2027-04-28 row; prototype mode keeps it
- **Trailing space** — Colour farms present and non-zero (1,405 visits in 365d)
- **Unknown labels** — a full run logs zero unrecognised values and throws on the first
- **Mode diff** — `--compare-modes` over 365 days yields ~**179 farms**, Layer-dominated (149)
- **Distribution smoke test** — spec mode over 90 days lands near **Green 1,736 / Yellow 677 / Red 226** (measured before Duck was added). A run where nearly everything is Green means a `good` value is mis-transcribed. Catches what unit tests cannot
- **Connection** — `node -e "require('./src/db').ping()"` returns the server version
- **Report** — render 5 real farms to PDF, confirm Bangla conjuncts render as glyphs, confirm every number matches a direct SQL query
- **Mail** — full dry run to `.eml`, then one live send to your own address, then the real cycle with `SEND_TO_ALL` enabled

---

## 6A. The July 2026 run · **DONE, prototype mode only**

First end-to-end run of the real engine. Output in `out/july-2026/`.

### 6A.1 Filters were undocumented and had to be recovered

`Farm_Condition_Scores_july.xlsx` carries no filter footnote and no Summary sheet — just 500 rows on the dashboard's eight condition columns. `scripts/recover-july-filters.js` replays candidate windows and companies:

| Window | Company | Farms | Exact on score + visits |
|---|---|---|---|
| 2026-07-01→07-31 | AKIJ Agro Feed Limited | 505 | **500/500** |
| 2026-07-01→07-31 | all companies | 894 | 263/500 |
| 2026-06-30→08-01 | AKIJ Agro Feed Limited | 523 | 436/500 |

**Recovered: 2026-07-01→07-31, company = AKIJ Agro Feed Limited, prototype rule.** `..07-19` and `..08-31` return identical results, which independently re-confirms the snapshot freeze date.

### 6A.2 Results — 505 farms, not 500

| | Farms | % |
|---|---|---|
| Green · A | 320 | 63.4 |
| Yellow · B | 137 | 27.1 |
| Red · C | 48 | 9.5 |
| **Below Green — the advisory list** | **185** | **36.6** |

1,207 visits in window, 1,002 scorable, 205 unscorable — **all 205 Cattle**, confirming §3.2 from a second direction. Mean farm score 81.44. **265 of 505 farms (52.5%) rest on a single visit.**

### 6A.3 The 500-row cap drops the farms that most need the report

505 farms qualified; the export shows the best 500. All 5 dropped are Red, three scoring a flat 0 — and **5 of the 7 Risky-ammonia farms in the month sit in that dropped tail**. The export was sorted best-first, so the cap removes precisely the advisory population. Our report is uncapped.

### 6A.4 New defect — the dashboard rounds twice

`dashboard.html` stores each visit score **already rounded to 1 dp** (93.75 held as 93.8; 24 distinct values, exactly the 1 dp images of the 24 achievable scores) and then averages those rounded values. §4.1 says the farm score is the mean of its visit scores — the raw ones.

Averaging raw scores instead moves **39 of 500 farms by 0.1**. **No farm changes band in July**, so nothing needs restating, but the error is systematic and would decide a tier at a band edge.

The 24 achievable prototype scores have distinct 1 dp images, so the map back is injective and the exact score is recoverable — `score.js: recoverExactVisitScore()`. That is how the July run gets exact farm means from a snapshot that only stored rounded ones.

Reconciliation after that correction: **500/500 visit counts, 500/500 bands, 461/500 scores exact**, the 39 differences all being this defect.

### 6A.5 Condition tracks territory, not species

| Cut | Range of average score | Spread |
|---|---|---|
| Farm type (5) | Layer 80.6 → Duck 84.9 | **4.3 pts** |
| Territory (28 with ≥8 farms) | Cox's Bazar 2 65.6 → Satkhira 99.0 | **33.4 pts** |

Cox's Bazar 2: 0 Green of 25 farms. Faridpur 88.5% below Green, Nilphamari 91.7%. Against Satkhira 23/23 Green and Pabna 1 21/21 Green.

Species-level advice is the wrong instrument. **Target the advisory drive by territory** — and treat the uniformly perfect territories as a data-quality question for Phase 7, since a 99.0 average is as unusual as a 65.6 one.

### 6A.6 Most farms are one parameter from a different tier

Two rungs carry the month: 87.5 (7 of 8 right) on 338 visits and 75.0 (6 of 8) on 168 — **50.5% of all scored visits**. The corrective action is usually a single habit, not a rebuild, which is the case for the advisory itself.

### 6A.7 What the July run is not

- **Prototype rule, not the spec rule.** Layer and Duck are scored on 8 parameters here; the spec scores them on 5 and adds stocking density for meat birds. Per §4.7 that re-tiers roughly 1 in 6 Layer farms — 148 Layer + 10 Duck farms in this window are exposed to it
- **The snapshot ends 2026-07-19.** Visits from 20–31 July are absent. Every count is a floor
- **No cleaning.** Duplicates and future-dated rows retained, per §4.4

**Spec-mode July cannot be computed from any file on disk.** The snapshot holds precomputed scores, never raw parameter values, and regrouping onto the Layer 5-parameter set requires knowing *which* parameters were good. It needs `farm.tblFarmRecordArc`.

---

## 7. Open items

None block Phases 3 and 4.

| # | Item | Blocks | Note |
|---|---|---|---|
| 0 | **Warehouse access** — `203.202.241.211:1433` times out | Spec mode, §6.1 gates, all production runs | Not a local network fault: outbound to other hosts succeeds, this host does not answer. VPN, IP allow-list or firewall. §9 |
| 1 | Where does the source app store **Visitor Email**? | Phase 6 | Officer emails exist (§5.4); locate the field or obtain an export |
| 2 | Bangla advisory text — ~11–13 strings | Phase 5 | Domain writing. It is what makes the report worth reading |
| 3 | Report format — HTML body, PDF, or the *Prescription contents* layout | Phase 5 | Recommendation: Bangla HTML plus PDF attachment |
| 4 | Include performance-standard benchmark lines in the trend section? | Phase 5 | Standards exist in the workbook, ready to use |
| 5 | Recipients — internal digest, dealer relay, or direct-to-farmer | Phase 6 | Recommendation: internal-first, renderer stays channel-agnostic |

**Closed:** curtain direction and litter material (official, §4.2), band cutoffs (§4.10), Duck (§4.3), stocking-density derivation (§4.11), reporting window (90 days rolling), Cattle condition rule (manual by design, §4.3), prototype reproducibility (§4.4, §4.9).

---

## 8. Change log

| Date | Change |
|---|---|
| 2026-08-11 | Warehouse access verified; scored columns, value domains, coverage and defects established (Phases 0–1) |
| 2026-08-11 | Prototype rule reverse-engineered from `dashboard.html` and validated — 10,049/10,051 visits exact, 0 score mismatches (Phase 2) |
| 2026-08-11 | Snapshot gap identified: `dashboard.html` frozen at 2026-07-19; the warehouse holds 2,994 rows it never saw |
| 2026-08-11 | 9-parameter production-KPI design withdrawn; plan rebuilt around shed condition and converted into this tracker |
| 2026-08-11 | **Workbook received and made the authority.** Formula matches the reverse-engineered one exactly; parameter set did not (Phase 2.5) |
| 2026-08-11 | Corrections applied: stocking density added, Layer restricted to 5 parameters. Impact 179 farms (5.1%), Layer 149 |
| 2026-08-11 | All 18 workbook sheets read. Band contradiction found and resolved to 80/65/0 — 212 farms hinge on it (§4.10) |
| 2026-08-11 | Duck moved into the Layer group on the evidence of sheet *Report* row 8 ("Layer/Duck"). 44 farms unblocked |
| 2026-08-11 | Stocking-density derivation considered and declined; recorded values only (§4.11) |
| 2026-08-11 | Reporting window set to rolling 90 days; officer-email claim corrected; age limits, growth standards and KPI weights recorded |
| 2026-08-11 | `Farm_Condition_Report.xlsx` analysed. Provenance established — artifact dashboard, 2026-07-01→08-31, company = AKIJ Agro Feed Limited. **Replayed at 500/500 exact** (§4.9) |
| 2026-08-11 | **Filters proven to act on visits, not farms** (§4.5) — dropping the company filter changes the replay from 500/500 to 464/500 |
| 2026-08-11 | **Prototype mode finalized as a first-class config** (§4.4, §4.13). One engine, two modes, `--compare-modes` to diff them |
| 2026-08-12 | Phase 3 built: `package.json`, `.gitignore` (with `.env` in it, before any commit), `src/db.js`, `src/extract.js` with both SQL variants, both config files exactly as §4.12/§4.13 |
| 2026-08-12 | Phase 4 engine built: `src/score.js`, pure and config-driven, throws on unrecognised labels. **18/18 unit gates pass**, including both workbook worked examples and the 81.25→81.3 rounding gate |
| 2026-08-12 | **Warehouse unreachable** — TCP timeout to `203.202.241.211:1433` while other outbound succeeds. Spec-mode figures blocked (§9) |
| 2026-08-12 | **July 2026 run completed in prototype mode** off the frozen snapshot (§6A). 505 farms, 320/137/48, 185 below Green |
| 2026-08-12 | July export's filters recovered by replay — 2026-07-01→07-31, AKIJ Agro Feed Limited — reproducing 500/500 (§6A.1) |
| 2026-08-12 | **New defect: the dashboard rounds twice** — stores visit scores at 1 dp, then averages the rounded values. 39 of 500 farms off by 0.1, 0 band changes. Exact scores proved recoverable and recovered (§6A.4) |
| 2026-08-12 | **The 500-row cap drops the advisory population** — all 5 hidden farms Red, and 5 of the month's 7 Risky-ammonia farms among them (§6A.3) |
| 2026-08-12 | Condition tracks **territory (33.4-point spread), not species (4.3)** — retarget the advisory drive by territory (§6A.5) |

---

## 9. Warehouse access — blocked

Checked 2026-08-12. `src/db.js` fails with `Failed to connect to 203.202.241.211:1433 - Could not connect (sequence)`. A bare TCP probe times out, while probes to other public hosts on 443 and 53 connect immediately, so the block is specific to this host, not local networking or a sandbox.

Likely a VPN requirement, an IP allow-list on the SQL listener, or a firewall change. Nothing in the code path can work around it.

**Unblocks when access returns, in order:**

1. `npm run ping` — confirm the login and read the server version
2. `src/extract.js` spec SQL over 2026-07-01→07-31 — **the first real spec-mode July numbers**, directly comparable to §6A.2
3. Re-measure §3.2 under the corrected per-group parameter sets
4. The §6.1 gates that need raw rows: full-dataset replay at 10,049/10,051, the 464/500 filter-semantics assertion, and the dedupe/date-guard structural checks
5. `--compare-modes` over the July window — the artefact that settles spec-vs-prototype questions

Carry over from §2: rotate the `mcp_user` password, enable TLS on the listener, and confirm the login holds `SELECT` only. `.env` is now in `.gitignore`.
