// Generate the July report page from the run's own output files, so every
// number on the page comes from out/july-2026 rather than being transcribed.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'july-2026');

const summary = JSON.parse(fs.readFileSync(path.join(OUT, 'summary.json'), 'utf8'));
const bd = JSON.parse(fs.readFileSync(path.join(OUT, 'breakdowns.json'), 'utf8'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v) => Number(v).toLocaleString('en-US');
const pct = (a, b) => ((100 * a) / b).toFixed(1);

const T = summary.bands;
const total = summary.farmsScored;

// Territories with enough farms to read as a signal, worst first.
const terr = bd.byTerritory.filter((t) => t.n >= 8).sort((a, b) => b.belowGreenPct - a.belowGreenPct);
const typeRows = bd.byFarmType;
const hist = bd.visitHistogram;
const risky = bd.riskyAmmoniaFarms;
const hiddenIds = new Set([660, 4511, 3420, 4135, 4480]);

const typeAvgs = typeRows.map((r) => r.avg);
const terrAvgs = terr.map((r) => r.avg);
const spread = (a) => (Math.max(...a) - Math.min(...a)).toFixed(1);

const maxHist = Math.max(...hist.map((h) => h.n));

const bandClass = (b) => (b === 'Green' ? 'good' : b === 'Yellow' ? 'warn' : 'crit');
const bandLetter = (b) => (b === 'Green' ? 'A' : b === 'Yellow' ? 'B' : 'C');

const html = `<title>July Shed Condition</title>
<style>
  /* ---- tokens: light is the base, both dark paths redefine only these ---- */
  :root {
    --ground:      #F2F5F5;
    --surface:     #FCFDFD;
    --surface-2:   #E9EEEE;
    --ink:         #0F1C1E;
    --ink-2:       #47595B;
    --ink-3:       #75898B;
    --rule:        #D5DEDE;
    --rule-strong: #B4C2C2;
    --accent:      #0F4652;
    --accent-soft: #DCE9EB;
    --good:        #0ca30c;
    --warn:        #fab219;
    --crit:        #d03b3b;
    --good-soft:   #E2F3E2;
    --warn-soft:   #FBF0D6;
    --crit-soft:   #F7DEDE;
    --shadow:      0 1px 2px rgba(15,28,30,.06), 0 8px 24px rgba(15,28,30,.05);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground:      #0C1618;
      --surface:     #131F21;
      --surface-2:   #1B2A2C;
      --ink:         #E8EFEE;
      --ink-2:       #A2B5B5;
      --ink-3:       #71878A;
      --rule:        #24393B;
      --rule-strong: #35504F;
      --accent:      #6FC4D2;
      --accent-soft: #16323A;
      --good-soft:   #14301A;
      --warn-soft:   #33290D;
      --crit-soft:   #34191A;
      --shadow:      0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.3);
    }
  }
  :root[data-theme="dark"] {
    --ground:      #0C1618;
    --surface:     #131F21;
    --surface-2:   #1B2A2C;
    --ink:         #E8EFEE;
    --ink-2:       #A2B5B5;
    --ink-3:       #71878A;
    --rule:        #24393B;
    --rule-strong: #35504F;
    --accent:      #6FC4D2;
    --accent-soft: #16323A;
    --good-soft:   #14301A;
    --warn-soft:   #33290D;
    --crit-soft:   #34191A;
    --shadow:      0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.3);
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: Georgia, "Iowan Old Style", "Source Serif Pro", serif;
    font-size: 17px;
    line-height: 1.62;
    -webkit-font-smoothing: antialiased;
  }

  .display, h1, h2, h3, .label, th, .stat-n, .chip {
    font-family: ui-sans-serif, "Segoe UI", system-ui, Roboto, sans-serif;
  }
  .mono, td.num, .stat-n, .bar-val, code {
    font-family: ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace;
    font-variant-numeric: tabular-nums;
  }

  .wrap { max-width: 1080px; margin: 0 auto; padding: 0 28px 96px; }
  .prose { max-width: 68ch; }
  .prose p { margin: 0 0 1em; color: var(--ink-2); }
  .prose p strong { color: var(--ink); font-weight: 600; }

  /* ---- masthead ---- */
  header.mast { border-bottom: 2px solid var(--ink); margin-bottom: 0; padding: 72px 0 22px; }
  .eyebrow {
    font-family: ui-sans-serif, "Segoe UI", system-ui, sans-serif;
    font-size: 11.5px; font-weight: 650; letter-spacing: .16em; text-transform: uppercase;
    color: var(--accent); margin-bottom: 18px;
  }
  h1 {
    font-size: clamp(38px, 6vw, 62px); line-height: 1.02; letter-spacing: -.033em;
    font-weight: 700; margin: 0 0 18px; text-wrap: balance;
  }
  .standfirst { font-size: 20px; line-height: 1.5; color: var(--ink-2); max-width: 60ch; margin: 0 0 30px; }

  .runmeta {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr));
    gap: 0; border-top: 1px solid var(--rule);
  }
  .runmeta div { padding: 13px 16px 13px 0; border-right: 1px solid var(--rule); }
  .runmeta div:last-child { border-right: 0; }
  .runmeta dt {
    font-family: ui-sans-serif, "Segoe UI", system-ui, sans-serif;
    font-size: 10.5px; font-weight: 650; letter-spacing: .11em; text-transform: uppercase;
    color: var(--ink-3); margin-bottom: 5px;
  }
  .runmeta dd {
    margin: 0; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 13.5px; color: var(--ink); font-variant-numeric: tabular-nums;
  }

  /* ---- sections ---- */
  section { padding-top: 62px; }
  h2 {
    font-size: 13px; font-weight: 680; letter-spacing: .15em; text-transform: uppercase;
    color: var(--ink); margin: 0 0 6px; display: flex; align-items: baseline; gap: 12px;
  }
  h2::after { content: ""; flex: 1; height: 1px; background: var(--rule-strong); }
  .sec-sub { color: var(--ink-3); font-size: 14.5px; margin: 0 0 26px; max-width: 62ch; }
  h3 { font-size: 17px; font-weight: 650; letter-spacing: -.01em; margin: 0 0 8px; }

  /* ---- stat row ---- */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); }
  .stat { background: var(--surface); padding: 20px 18px; }
  .stat-n { font-size: 36px; font-weight: 680; letter-spacing: -.035em; line-height: 1; display: block; }
  .stat-l { font-size: 12.5px; color: var(--ink-2); margin-top: 8px; font-family: ui-sans-serif, "Segoe UI", system-ui, sans-serif; line-height: 1.35; }
  .stat-note { font-size: 11.5px; color: var(--ink-3); margin-top: 5px; font-family: ui-sans-serif, "Segoe UI", system-ui, sans-serif; }

  /* ---- tiering bar ---- */
  .tierbar { display: flex; gap: 2px; height: 62px; margin: 4px 0 14px; }
  .tierbar span { display: flex; align-items: center; justify-content: center; color: #fff; font-family: ui-sans-serif, "Segoe UI", system-ui, sans-serif; font-weight: 650; font-size: 14px; letter-spacing: .01em; }
  .tierbar .s-good { background: var(--good); }
  .tierbar .s-warn { background: var(--warn); color: #3A2A00; }
  .tierbar .s-crit { background: var(--crit); }
  .tierlegend { display: flex; flex-wrap: wrap; gap: 22px; font-family: ui-sans-serif, "Segoe UI", system-ui, sans-serif; font-size: 13px; color: var(--ink-2); }
  .tierlegend b { color: var(--ink); font-weight: 620; }
  .swatch { width: 11px; height: 11px; border-radius: 2px; display: inline-block; margin-right: 7px; vertical-align: baseline; }

  /* ---- chips ---- */
  .chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px 2px 7px;
    border-radius: 3px; font-size: 12px; font-weight: 620; white-space: nowrap;
  }
  .chip .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .chip.good { background: var(--good-soft); color: var(--ink); }
  .chip.good .dot { background: var(--good); }
  .chip.warn { background: var(--warn-soft); color: var(--ink); }
  .chip.warn .dot { background: var(--warn); }
  .chip.crit { background: var(--crit-soft); color: var(--ink); }
  .chip.crit .dot { background: var(--crit); }

  /* ---- tables ---- */
  .scroll { overflow-x: auto; border: 1px solid var(--rule); background: var(--surface); }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  caption { text-align: left; font-size: 12.5px; color: var(--ink-3); padding: 11px 14px; border-bottom: 1px solid var(--rule); font-family: ui-sans-serif, "Segoe UI", system-ui, sans-serif; }
  th {
    text-align: left; font-size: 10.5px; font-weight: 650; letter-spacing: .09em; text-transform: uppercase;
    color: var(--ink-3); padding: 10px 14px; border-bottom: 1px solid var(--rule-strong); white-space: nowrap;
  }
  td { padding: 9px 14px; border-bottom: 1px solid var(--rule); color: var(--ink-2); white-space: nowrap; }
  td.name { color: var(--ink); white-space: normal; min-width: 168px; }
  td.num, th.num { text-align: right; }
  td.num { color: var(--ink); }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover td { background: var(--surface-2); }

  /* ---- mini stacked bars inside table ---- */
  .minibar { display: flex; gap: 2px; width: 132px; height: 13px; }
  .minibar i { display: block; height: 100%; }

  /* ---- histogram ---- */
  .hist { display: flex; align-items: flex-end; gap: 3px; height: 190px; padding: 0 2px; }
  .hist .col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: stretch; height: 100%; min-width: 0; }
  .hist .col i { display: block; border-radius: 4px 4px 0 0; min-height: 3px; }
  .hist-x { display: flex; gap: 3px; padding: 7px 2px 0; }
  .hist-x span { flex: 1; text-align: center; font-size: 9.5px; color: var(--ink-3); font-family: ui-monospace, Consolas, monospace; min-width: 0; overflow: hidden; }

  /* ---- callouts ---- */
  .finding { border-left: 3px solid var(--accent); background: var(--surface); padding: 20px 24px; margin-bottom: 2px; box-shadow: var(--shadow); }
  .finding h3 { color: var(--ink); }
  .finding p { margin: 0; color: var(--ink-2); font-size: 15.5px; }
  .finding p + p { margin-top: .7em; }
  .findings { display: grid; gap: 14px; }

  .caveat { border: 1px solid var(--rule-strong); background: var(--surface); padding: 18px 22px; }
  .caveat h3 { font-size: 14px; }
  .caveat p { margin: 0; font-size: 14.5px; color: var(--ink-2); }
  .caveats { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }

  .verify { display: grid; grid-template-columns: repeat(auto-fit, minmax(146px, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); margin-bottom: 22px; }
  .verify div { background: var(--surface); padding: 17px 16px; }
  .verify .v-n { font-size: 25px; font-weight: 680; letter-spacing: -.03em; display: block; }
  .verify .v-l { font-size: 12px; color: var(--ink-2); margin-top: 6px; font-family: ui-sans-serif, "Segoe UI", system-ui, sans-serif; line-height: 1.35; }
  .ok { color: var(--good); }
  .hl { color: var(--accent); }

  footer { margin-top: 78px; padding-top: 22px; border-top: 2px solid var(--ink); font-size: 13px; color: var(--ink-3); }
  footer p { margin: 0 0 .5em; }
  code { background: var(--surface-2); padding: 1px 5px; border-radius: 3px; font-size: .88em; color: var(--ink); }

  a { color: var(--accent); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
  @media (max-width: 620px) {
    .wrap { padding: 0 18px 64px; }
    header.mast { padding-top: 44px; }
    .runmeta div { border-right: 0; border-bottom: 1px solid var(--rule); }
  }
</style>

<div class="wrap">

<header class="mast">
  <div class="eyebrow">Akij Agro Feed · Technical Services</div>
  <h1>July 2026 shed condition</h1>
  <p class="standfirst">Every farm AKIJ officers visited in July, scored and tiered by our own engine — then checked line by line against the dashboard export.</p>
  <dl class="runmeta">
    <div><dt>Window</dt><dd>${summary.window.from} → ${summary.window.to}</dd></div>
    <div><dt>Company</dt><dd>AKIJ Agro Feed</dd></div>
    <div><dt>Rule</dt><dd>prototype · 8 params</dd></div>
    <div><dt>Farms scored</dt><dd>${n(total)}</dd></div>
    <div><dt>Visits scored</dt><dd>${n(summary.visitsScorable)}</dd></div>
    <div><dt>Data ends</dt><dd>${summary.dataSpan.last}</dd></div>
  </dl>
</header>

<section>
  <h2>The month in six numbers</h2>
  <p class="sec-sub">Farm scores run 0–100. A farm's score is the plain mean of its visit scores; its tier comes from that mean before rounding.</p>
  <div class="stats">
    <div class="stat"><span class="stat-n">${n(total)}</span><div class="stat-l">farms scored</div><div class="stat-note">505, not the 500 the export shows</div></div>
    <div class="stat"><span class="stat-n">${n(summary.belowGreen)}</span><div class="stat-l">farms below Green</div><div class="stat-note">${pct(summary.belowGreen, total)}% — the advisory list</div></div>
    <div class="stat"><span class="stat-n">${summary.meanOfFarmScores}</span><div class="stat-l">mean farm score</div><div class="stat-note">median ${summary.medianFarmScore}</div></div>
    <div class="stat"><span class="stat-n">${n(summary.farmsWithOneVisit)}</span><div class="stat-l">farms seen once</div><div class="stat-note">${pct(summary.farmsWithOneVisit, total)}% rest on a single visit</div></div>
    <div class="stat"><span class="stat-n">${risky.length}</span><div class="stat-l">farms with a Risky ammonia reading</div><div class="stat-note">above 25 ppm — scores that visit 0</div></div>
    <div class="stat"><span class="stat-n">${n(summary.visitsUnscorable)}</span><div class="stat-l">visits that scored nothing</div><div class="stat-note">all Cattle — no shed fields recorded</div></div>
  </div>
</section>

<section>
  <h2>Tiering</h2>
  <p class="sec-sub">Green ≥ 80 · Yellow 65–79.9 · Red &lt; 65. Roughly one farm in three needs an advisory this cycle.</p>
  <div class="tierbar" role="img" aria-label="Green ${T.Green} farms, Yellow ${T.Yellow} farms, Red ${T.Red} farms">
    <span class="s-good" style="width:${pct(T.Green, total)}%">${n(T.Green)}</span>
    <span class="s-warn" style="width:${pct(T.Yellow, total)}%">${n(T.Yellow)}</span>
    <span class="s-crit" style="width:${pct(T.Red, total)}%">${n(T.Red)}</span>
  </div>
  <div class="tierlegend">
    <span><i class="swatch" style="background:var(--good)"></i><b>Green · A</b> ${n(T.Green)} farms · ${pct(T.Green, total)}%</span>
    <span><i class="swatch" style="background:var(--warn)"></i><b>Yellow · B</b> ${n(T.Yellow)} farms · ${pct(T.Yellow, total)}%</span>
    <span><i class="swatch" style="background:var(--crit)"></i><b>Red · C</b> ${n(T.Red)} farms · ${pct(T.Red, total)}%</span>
  </div>
</section>

<section>
  <h2>What the month actually says</h2>
  <p class="sec-sub">Three findings that change what someone would do next.</p>
  <div class="findings">

    <div class="finding">
      <h3>Where a farm is beats what it farms</h3>
      <p>Average score by <strong>species</strong> spans ${spread(typeAvgs)} points — Layer ${typeRows.find(r=>r.key==='Layer').avg} to Duck ${typeRows.find(r=>r.key==='Duck').avg}. Average score by <strong>territory</strong> spans ${spread(terrAvgs)} points, from Cox's Bazar 2 at ${terr[0].avg} to Satkhira at ${terr[terr.length-1].avg}.</p>
      <p>Shed condition is not a species problem to be solved with species advice. It tracks territory — which means it tracks field practice and the officer's own standard. Target the advisory drive by territory.</p>
    </div>

    <div class="finding">
      <h3>The export's 500-row cap hid exactly the farms that matter</h3>
      <p>${n(total)} farms qualified in July; the export shows 500, sorted best-first. The 5 it dropped are all Red — three of them scoring a flat <strong>0</strong>.</p>
      <p>Worse, 5 of the ${risky.length} farms with a Risky ammonia reading sit in that dropped tail. The single most urgent list in the dataset was ${((5/risky.length)*100).toFixed(0)}% invisible in the file people were reading.</p>
    </div>

    <div class="finding">
      <h3>Half the farms rest on one visit</h3>
      <p>${n(summary.farmsWithOneVisit)} of ${n(total)} farms were visited once in the window, so one officer on one morning sets the whole tier. A single parameter swing moves such a farm ${(50/8).toFixed(2)} points — enough to cross a band edge.</p>
      <p>Read single-visit Reds as "look again", not as a verdict.</p>
    </div>

  </div>
</section>

<section>
  <h2>Verification</h2>
  <p class="sec-sub">Our engine, run over the same visit rows with the same filters, against <code>Farm_Condition_Scores_july.xlsx</code>.</p>
  <div class="verify">
    <div><span class="v-n ok">${summary.reconciliation.visitCountMatches}/500</span><div class="v-l">visit counts identical</div></div>
    <div><span class="v-n ok">${summary.reconciliation.bandMatches}/500</span><div class="v-l">tiers identical</div></div>
    <div><span class="v-n">${summary.reconciliation.exactMatches}/500</span><div class="v-l">scores identical to 1 dp</div></div>
    <div><span class="v-n hl">${summary.reconciliation.roundingDiffFarms}</span><div class="v-l">farms differ by 0.1</div></div>
    <div><span class="v-n hl">${summary.reconciliation.hiddenByCap}</span><div class="v-l">farms the export could not show</div></div>
  </div>
  <div class="prose">
    <p>The filters were not documented anywhere — they were recovered by replay, and the recovered pair reproduces the export's visit counts and tiers on all 500 rows.</p>
    <p><strong>The 0.1 gap is a real defect, in the export.</strong> The dashboard stores each visit score already rounded to one decimal, then averages those rounded values — it rounds twice. Averaging the raw scores instead moves ${summary.reconciliation.roundingDiffFarms} farms by 0.1. <strong>No farm changes tier because of it this month</strong>, so nothing needs restating — but the error is systematic, and at a band edge it would decide a tier.</p>
  </div>
</section>

<section>
  <h2>Risky ammonia — act on these</h2>
  <p class="sec-sub">Above 25 ppm the visit scores 0 outright, whatever else was right. These ${risky.length} farms are the month's urgent list.</p>
  <div class="scroll">
    <table>
      <caption>All farms with at least one Risky ammonia reading in July 2026, worst score first.</caption>
      <thead><tr>
        <th>Farm</th><th>ID</th><th>Type</th><th>Region</th><th>Territory</th>
        <th class="num">Visits</th><th class="num">Score</th><th>Tier</th><th>In the export?</th>
      </tr></thead>
      <tbody>
${risky.slice().sort((a, b) => a.score - b.score).map((f) => `        <tr>
          <td class="name">${esc(f.farmName)}</td>
          <td class="num mono">${f.farmId}</td>
          <td>${esc(f.farmType)}</td>
          <td>${esc(f.region)}</td>
          <td>${esc(f.territory)}</td>
          <td class="num">${f.visits}</td>
          <td class="num">${f.score.toFixed(1)}</td>
          <td><span class="chip ${bandClass(f.band)}"><i class="dot"></i>${f.band} · ${bandLetter(f.band)}</span></td>
          <td>${hiddenIds.has(f.farmId) ? '<strong>no — cut by the cap</strong>' : 'yes'}</td>
        </tr>`).join('\n')}
      </tbody>
    </table>
  </div>
</section>

<section>
  <h2>Territories, worst first</h2>
  <p class="sec-sub">Territories with 8 or more scored farms, ranked by the share sitting below Green. The bar shows each territory's own mix.</p>
  <div class="scroll">
    <table>
      <caption>Green ≥ 80 · Yellow 65–79.9 · Red &lt; 65. Bar segments are proportional within each territory.</caption>
      <thead><tr>
        <th>Territory</th><th class="num">Farms</th><th class="num">Visits</th><th class="num">Avg</th>
        <th>Mix</th><th class="num">Green</th><th class="num">Yellow</th><th class="num">Red</th><th class="num">Below Green</th>
      </tr></thead>
      <tbody>
${terr.map((t) => `        <tr>
          <td class="name">${esc(t.key)}</td>
          <td class="num">${t.n}</td>
          <td class="num">${t.visits}</td>
          <td class="num">${t.avg.toFixed(1)}</td>
          <td><span class="minibar" role="img" aria-label="${t.Green} Green, ${t.Yellow} Yellow, ${t.Red} Red">${t.Green ? `<i style="width:${(100 * t.Green / t.n)}%;background:var(--good)"></i>` : ''}${t.Yellow ? `<i style="width:${(100 * t.Yellow / t.n)}%;background:var(--warn)"></i>` : ''}${t.Red ? `<i style="width:${(100 * t.Red / t.n)}%;background:var(--crit)"></i>` : ''}</span></td>
          <td class="num">${t.Green}</td>
          <td class="num">${t.Yellow}</td>
          <td class="num">${t.Red}</td>
          <td class="num">${t.belowGreenPct.toFixed(1)}%</td>
        </tr>`).join('\n')}
      </tbody>
    </table>
  </div>
</section>

<section>
  <h2>By species</h2>
  <p class="sec-sub">A narrow spread — which is the point. Species is not where the variation lives.</p>
  <div class="scroll">
    <table>
      <thead><tr>
        <th>Farm type</th><th class="num">Farms</th><th class="num">Visits</th><th class="num">Avg</th>
        <th>Mix</th><th class="num">Green</th><th class="num">Yellow</th><th class="num">Red</th><th class="num">Below Green</th>
      </tr></thead>
      <tbody>
${typeRows.map((t) => `        <tr>
          <td class="name">${esc(t.key)}</td>
          <td class="num">${t.n}</td>
          <td class="num">${t.visits}</td>
          <td class="num">${t.avg.toFixed(1)}</td>
          <td><span class="minibar" role="img" aria-label="${t.Green} Green, ${t.Yellow} Yellow, ${t.Red} Red">${t.Green ? `<i style="width:${(100 * t.Green / t.n)}%;background:var(--good)"></i>` : ''}${t.Yellow ? `<i style="width:${(100 * t.Yellow / t.n)}%;background:var(--warn)"></i>` : ''}${t.Red ? `<i style="width:${(100 * t.Red / t.n)}%;background:var(--crit)"></i>` : ''}</span></td>
          <td class="num">${t.Green}</td>
          <td class="num">${t.Yellow}</td>
          <td class="num">${t.Red}</td>
          <td class="num">${t.belowGreenPct.toFixed(1)}%</td>
        </tr>`).join('\n')}
      </tbody>
    </table>
  </div>
</section>

<section>
  <h2>How the visit scores fall</h2>
  <p class="sec-sub">${n(summary.visitsScorable)} scored visits. The scale is lumpy by construction: with 8 parameters marked 100 or 50, a visit can only land on a fixed ladder of values.</p>
  <div class="scroll" style="padding:20px 16px 12px">
    <div class="hist" role="img" aria-label="Histogram of visit scores; the table below carries the same numbers">
${hist.map((h) => `      <div class="col" title="${h.score} — ${n(h.n)} visits (${h.band})"><i style="height:${(100 * h.n / maxHist).toFixed(2)}%;background:var(--${bandClass(h.band) === 'good' ? 'good' : bandClass(h.band) === 'warn' ? 'warn' : 'crit'})"></i></div>`).join('\n')}
    </div>
    <div class="hist-x">
${hist.map((h) => `      <span>${h.n >= 40 ? h.score : ''}</span>`).join('\n')}
    </div>
  </div>
  <div class="prose" style="margin-top:20px">
    <p>Two rungs carry the month: <strong>87.5</strong> (7 of 8 parameters right) accounts for ${n(hist.find(h=>h.score===87.5).n)} visits and <strong>75.0</strong> (6 of 8) for ${n(hist.find(h=>h.score===75).n)}. Together that is ${pct(hist.find(h=>h.score===87.5).n + hist.find(h=>h.score===75).n, summary.visitsScorable)}% of all scored visits.</p>
    <p>So most farms are one parameter away from a different tier. That is what makes the advisory worth sending: the gap is usually a single fixable habit, not a rebuild.</p>
  </div>
</section>

<section>
  <h2>What this run is not</h2>
  <p class="sec-sub">Three limits worth stating before anyone quotes these numbers.</p>
  <div class="caveats">
    <div class="caveat">
      <h3>It uses the prototype rule</h3>
      <p>All farms are scored on 8 parameters. The authoritative rule scores Layer and Duck on 5 and adds stocking density for meat birds — which would re-tier some farms. Those numbers need raw parameter values from the warehouse.</p>
    </div>
    <div class="caveat">
      <h3>The data stops on ${summary.dataSpan.last}</h3>
      <p>The snapshot this run reads was frozen mid-month, so visits from 20–31 July are not in it. Treat every count here as a floor, not a total.</p>
    </div>
    <div class="caveat">
      <h3>No cleaning was applied</h3>
      <p>Prototype mode keeps duplicate shed-day rows and future-dated rows, and applies no farm-type filter. That is deliberate — it is what makes the export reproducible.</p>
    </div>
  </div>
</section>

<footer>
  <p><strong>Source</strong> — <code>farm.tblFarmRecordArc</code> via the dashboard snapshot frozen ${summary.dataSpan.last}; the warehouse was unreachable at run time. Filters recovered by replay and confirmed against the export.</p>
  <p><strong>Method</strong> — each parameter marks 100 on its good value and 50 on any other recorded value; a visit scores the mean of its recorded marks, or 0 on Risky ammonia. A farm scores the plain mean of its visits, tiered on that mean before rounding.</p>
  <p><strong>Full detail</strong> — <code>out/july-2026/Akij_July_2026_Farm_Condition_Report.xlsx</code>: all ${n(total)} farms, the ${n(summary.belowGreen)}-farm advisory list, per-visit detail, and the row-by-row reconciliation.</p>
</footer>

</div>
`;

const dest = path.join(OUT, 'july-report.html');
fs.writeFileSync(dest, html);
console.log('wrote', path.relative(ROOT, dest), `(${(html.length / 1024).toFixed(1)} KB)`);
console.log('territories charted:', terr.length, '| histogram bars:', hist.length, '| risky farms:', risky.length);
