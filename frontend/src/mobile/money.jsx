import { useEffect, useState } from "react";
import { useGet } from "./api";
import { DrillChart } from "./charts";
import { Screen, Loading, WindowBar, GlanceRow, Caveat, Collapsible, SyncedAgo } from "./ui";
import { MONEY_WINDOWS, MONEY_NEAR_WINDOWS, SINCE_2000 } from "./windows";
import { MECHANISM_CARDS } from "./mechanism_cards";
import { usePin } from "./pin";
import {
  sliceWindow, lastChange, realValues, pctSince, indexTo100, firstCommonDate, divergenceBands,
  fmtNum, fmtSigned, fmtSignedPct, fmtUsdCompact, fmtPct,
  sinceLabel, todayIso, DASH,
} from "./stats";

// Money (mobile-spec.md Section 6): a list of questions, each with a one-line
// answer that drills into one chart. Reads existing /db routes only.

const moneyPath = (since) => `/api/fred/money-supply/db?window=custom&start=${since}&end=${todayIso()}`;
const rows = (arr, key = "value_trillions") => (arr || []).map((r) => ({ date: r.date, value: r[key] }));

function yearsAgo(n) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

// Preset years or a typed date. Custom "since 2000" is the default (it is
// longer than the 20Y preset, so it is a Custom range selected on load).
function SincePicker({ since, onChange }) {
  return (
    <div className="m-since">
      <div className="m-seg m-seg--scroll" role="group" aria-label="Range">
        {[2, 5, 10, 20].map((y) => (
          <button key={y} type="button" className="m-seg-btn" onClick={() => onChange(yearsAgo(y))}>{y}Y</button>
        ))}
        <button type="button" className={"m-seg-btn" + (since === SINCE_2000 ? " m-seg-btn--on" : "")} onClick={() => onChange(SINCE_2000)}>Since 2000</button>
      </div>
      <label className="m-since-label">Since
        <input className="m-input" type="date" value={since} max={todayIso()} onChange={(e) => e.target.value && onChange(e.target.value)} />
      </label>
    </div>
  );
}

function CardView({ id, onClose }) {
  const c = MECHANISM_CARDS.find((x) => x.id === id);
  if (!c) return null;
  return (
    <div className="m-card m-card--open">
      <div className="m-card-head"><strong>{c.title}</strong><button type="button" className="m-btn m-btn--quiet" onClick={onClose}>Close</button></div>
      <div className="m-card-body">
        {c.body.map((p, i) => <p key={i}>{p}</p>)}
        <p className="m-caveat"><strong>In AV:</strong> {c.inAv}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- M1
function Growth({ onBack }) {
  const [since, setSince] = useState(SINCE_2000);
  const [measure, setMeasure] = useState("m2");
  const [view, setView] = useState("measure"); // 'measure' | 'power'
  const { pinnedDate, onPin } = usePin();
  const st = useGet(moneyPath(since));
  const metals = useGet(view === "power" ? `/api/metals/prices/db?window=custom&start=${since}&end=${todayIso()}` : null);
  const label = measure === "m2" ? "M2 money stock" : "Fed balance sheet";

  return (
    <Screen title="How much has the money pool grown?" onBack={onBack}>
      <SincePicker since={since} onChange={setSince} />
      <div className="m-seg" role="group" aria-label="Measure">
        <button type="button" className={"m-seg-btn" + (measure === "m2" ? " m-seg-btn--on" : "")} aria-pressed={measure === "m2"} onClick={() => setMeasure("m2")}>M2</button>
        <button type="button" className={"m-seg-btn" + (measure === "walcl" ? " m-seg-btn--on" : "")} aria-pressed={measure === "walcl"} onClick={() => setMeasure("walcl")}>Fed balance sheet</button>
      </div>
      <div className="m-seg" role="group" aria-label="Chart">
        <button type="button" className={"m-seg-btn" + (view === "measure" ? " m-seg-btn--on" : "")} onClick={() => setView("measure")}>{label}</button>
        <button type="button" className={"m-seg-btn" + (view === "power" ? " m-seg-btn--on" : "")} onClick={() => setView("power")}>Purchasing power</button>
      </div>
      <Loading state={st}>
        {st.data && (() => {
          const r = rows(st.data[measure]);
          const g = pctSince(r, since);
          if (view === "measure") {
            return (
              <>
                <div className="m-big">{g ? fmtSignedPct(g.pct, 0) : DASH} <span className="m-big-sub">since {g ? sinceLabel(g.from) : sinceLabel(since)}</span></div>
                {g && g.from > since && <div className="m-sub">Data for this series begins {g.from}.</div>}
                <DrillChart lines={[{ key: measure, name: label, color: "#4caf76", rows: r, kind: "line" }]} format={(v) => "$" + fmtNum(v, 2) + "T"} axisFormat={(v) => "$" + fmtNum(v, 0) + "T"} pinnedDate={pinnedDate} onPin={onPin} />
              </>
            );
          }
          return (
            <Loading state={metals}>
              {metals.data && (() => {
                const pp = rows(st.data.purchasing_power, "index");
                const gold = metals.data.xau.map((x) => ({ date: x.date, value: x.price }));
                const silver = metals.data.xag.map((x) => ({ date: x.date, value: x.price }));
                const base = firstCommonDate([pp, gold, silver]);
                if (!base) return <div className="m-empty">Not enough data to compare.</div>;
                const b = base > since ? base : since;
                const ppI = indexTo100(pp, b);
                const lines = [
                  { key: "fiat", name: "Dollar (nominal)", color: "#919bb0", rows: ppI.map((x) => ({ date: x.date, value: 100 })), kind: "line", dash: "4 4" },
                  { key: "pp", name: "Purchasing power (CPI)", color: "#e05252", rows: ppI, kind: "line" },
                  { key: "gold", name: "Gold", color: "#e0c14c", rows: indexTo100(gold, b), kind: "line" },
                  { key: "silver", name: "Silver", color: "#5aa9e6", rows: indexTo100(silver, b), kind: "line" },
                ];
                return (
                  <>
                    <div className="m-sub">All four indexed to 100 at {b}. Monthly data.</div>
                    <div className="m-legend">{lines.map((l) => <span key={l.key}><i className="m-swatch" style={{ background: l.color }} />{l.name}</span>)}</div>
                    <DrillChart lines={lines} format={(v) => fmtNum(v, 1)} pinnedDate={pinnedDate} onPin={onPin} />
                  </>
                );
              })()}
            </Loading>
          );
        })()}
      </Loading>
      <Caveat>Purchasing power is derived from CPI. Gold and silver are month-end closes.</Caveat>
    </Screen>
  );
}

// ---------------------------------------------------------------- M2
const ANNOTATIONS = [
  { date: "2008-11-26", mark: "Q", title: "QE era" },
  { date: "2022-06-01", mark: "T", title: "QT era" },
];

function Created({ onBack }) {
  const [since, setSince] = useState(SINCE_2000);
  const [sub, setSub] = useState(null); // 'walcl' | 'm2' | 'credit' | 'qeqt'
  const [card, setCard] = useState(null);
  const [qeWin, setQeWin] = useState("45d");
  const { pinnedDate, onPin } = usePin();
  const st = useGet(moneyPath(since));
  const tr = useGet("/api/fred/transmission/db");

  return (
    <Screen title="How much money has been created or destroyed?" onBack={sub ? () => setSub(null) : onBack}>
      <Loading state={st}>
        {st.data && (() => {
          const walcl = rows(st.data.walcl), m2 = rows(st.data.m2);
          const credit = (tr.data?.series?.TOTBKCR || []).map((x) => ({ date: x.date, value: x.value })).filter((x) => x.date >= since);
          const chg = (r) => { const v = realValues(r.filter((x) => x.date >= since)); return v.length > 1 ? { abs: v[v.length - 1].value - v[0].value, pct: (v[v.length - 1].value / v[0].value - 1) * 100, from: v[0].date, to: v[v.length - 1].date } : null; };
          const cw = chg(walcl), cm = chg(m2), cc = chg(credit);

          if (sub) {
            const spec = {
              walcl: { title: "Fed balance sheet", rows: walcl.filter((x) => x.date >= since), fmt: (v) => "$" + fmtNum(v, 2) + "T", color: "#e05252" },
              m2: { title: "M2", rows: m2.filter((x) => x.date >= since), fmt: (v) => "$" + fmtNum(v, 2) + "T", color: "#4caf76" },
              credit: { title: "Total bank credit", rows: credit, fmt: (v) => "$" + fmtNum(v / 1000, 2) + "T", color: "#7b9fff" },
            };
            if (sub === "qeqt") {
              const w = MONEY_NEAR_WINDOWS.find((x) => x.key === qeWin);
              const bars = walcl.map((x, i) => (i === 0 || x.value == null || walcl[i - 1].value == null ? null : { date: x.date, value: (x.value - walcl[i - 1].value) * 1000 })).filter(Boolean);
              return (
                <>
                  <h3 className="m-h3">QE / QT: weekly change in the Fed balance sheet</h3>
                  <WindowBar windows={MONEY_NEAR_WINDOWS} value={qeWin} onChange={setQeWin} />
                  <DrillChart lines={[{ key: "q", name: "Weekly change", color: "#4caf76", rows: sliceWindow(bars, w), kind: "bar" }]} format={(v) => (v >= 0 ? "+$" : "−$") + fmtNum(Math.abs(v), 1) + "B"} axisFormat={(v) => fmtNum(v, 0)} pinnedDate={pinnedDate} onPin={onPin} unit="" />
                  <Caveat>Green weeks grew the balance sheet (QE), red weeks shrank it (QT). Billions of dollars.</Caveat>
                </>
              );
            }
            const sp = spec[sub];
            return (
              <>
                <h3 className="m-h3">{sp.title}</h3>
                <DrillChart lines={[{ key: sub, name: sp.title, color: sp.color, rows: sp.rows, kind: "line" }]} format={sp.fmt} axisFormat={sub === "credit" ? (v) => fmtNum(v / 1000, 1) + "T" : (v) => fmtNum(v, 1) + "T"} pinnedDate={pinnedDate} onPin={onPin} />
              </>
            );
          }

          const base = firstCommonDate([walcl.filter((x) => x.date >= since), m2.filter((x) => x.date >= since)]);
          const idxW = base ? indexTo100(walcl, base) : [];
          const idxM = base ? indexTo100(m2, base) : [];
          const bands = divergenceBands(idxM, idxW, 3);
          const first = idxM[0]?.date, lastD = idxM[idxM.length - 1]?.date;
          const anns = ANNOTATIONS.filter((a) => first && a.date >= first && a.date <= lastD).map((a) => ({ ...a, onTap: () => setCard(5) }));
          return (
            <>
              <SincePicker since={since} onChange={setSince} />
              <div className="m-section">Two layers, shown separately</div>
              <div className="m-legend">
                <span><i className="m-swatch" style={{ background: "#e05252" }} />Fed balance sheet</span>
                <span><i className="m-swatch" style={{ background: "#4caf76" }} />M2</span>
                <span><i className="m-swatch" style={{ background: "#d9a441", opacity: 0.5 }} />Moving opposite ways</span>
              </div>
              <div className="m-sub">Both indexed to 100 at {base ?? DASH}. Tap a marker for the mechanism behind it.</div>
              {base ? (
                <DrillChart
                  lines={[{ key: "m2", name: "M2", color: "#4caf76", rows: idxM, kind: "line" }, { key: "w", name: "Fed balance sheet", color: "#e05252", rows: idxW, kind: "line" }]}
                  bands={bands} annotations={anns} format={(v) => fmtNum(v, 0)} pinnedDate={pinnedDate} onPin={onPin}
                />
              ) : <div className="m-empty">Not enough data to compare.</div>}
              {card && <CardView id={card} onClose={() => setCard(null)} />}
              <Caveat>A shaded band marks a quarter in which the two moved in opposite directions. It is a description of the two lines, not a signal.</Caveat>
              <div className="m-section">Fed layer</div>
              <GlanceRow label="Fed balance sheet" value={cw ? (cw.abs >= 0 ? "+$" : "−$") + fmtNum(Math.abs(cw.abs), 2) + "T" : DASH} sub={cw ? `${fmtSignedPct(cw.pct, 0)} since ${sinceLabel(cw.from)}` : undefined} asOf={cw?.to} spark={walcl.filter((x) => x.date >= since)} sparkColor="#e05252" onTap={() => setSub("walcl")} />
              <GlanceRow label="QE / QT, weekly change" value={(() => { const lc = lastChange(walcl); return lc?.change != null ? (lc.change >= 0 ? "+$" : "−$") + fmtNum(Math.abs(lc.change * 1000), 1) + "B" : DASH; })()} sub="Last week vs. the week before" asOf={lastChange(walcl)?.date} onTap={() => setSub("qeqt")} />
              <div className="m-section">Bank layer</div>
              <GlanceRow label="M2" value={cm ? (cm.abs >= 0 ? "+$" : "−$") + fmtNum(Math.abs(cm.abs), 2) + "T" : DASH} sub={cm ? `${fmtSignedPct(cm.pct, 0)} since ${sinceLabel(cm.from)}` : undefined} asOf={cm?.to} spark={m2.filter((x) => x.date >= since)} sparkColor="#4caf76" onTap={() => setSub("m2")} />
              <GlanceRow label="Total bank credit (the mechanism behind M2)" value={cc ? (cc.abs >= 0 ? "+$" : "−$") + fmtNum(Math.abs(cc.abs / 1000), 2) + "T" : DASH} sub={cc ? `${fmtSignedPct(cc.pct, 0)} since ${sinceLabel(cc.from)}` : tr.loading ? "loading" : undefined} asOf={cc?.to} spark={credit} sparkColor="#7b9fff" onTap={cc ? () => setSub("credit") : undefined} />
            </>
          );
        })()}
      </Loading>
    </Screen>
  );
}

// ---------------------------------------------------------------- M3
const YIELDS = [
  ["dgs3mo", "3-month"], ["dgs2", "2-year"], ["dgs5", "5-year"], ["dgs10", "10-year"], ["dgs30", "30-year"],
  ["dfii10", "10-year real"], ["t10y2y", "10Y − 2Y spread"], ["t10y3mo", "10Y − 3M spread"],
];

function Treasuries({ onBack }) {
  const [drill, setDrill] = useState(null);
  const [winKey, setWinKey] = useState("45d");
  const { pinnedDate, onPin } = usePin();
  const st = useGet(moneyPath(SINCE_2000));
  const au = useGet("/api/treasury-auctions/db");
  const win = MONEY_NEAR_WINDOWS.find((w) => w.key === winKey);

  return (
    <Screen title="What happened last in Treasuries?" onBack={drill ? () => setDrill(null) : onBack}>
      <Loading state={st}>
        {st.data && au.data && (() => {
          const d = st.data;
          const series = {};
          for (const [k] of YIELDS) if (k !== "t10y3mo") series[k] = (d[k] || []).map((r) => ({ date: r.date, value: r.value }));
          const m3 = new Map((d.dgs3mo || []).map((r) => [r.date, r.value]));
          series.t10y3mo = (d.dgs10 || []).filter((r) => m3.has(r.date) && r.value != null && m3.get(r.date) != null).map((r) => ({ date: r.date, value: r.value - m3.get(r.date) }));
          const auctions = au.data.filter((a) => a.bid_to_cover_ratio != null).sort((a, b) => (a.auction_date < b.auction_date ? -1 : 1));
          const latestA = auctions[auctions.length - 1];

          if (drill?.kind === "yield") {
            return (
              <>
                <h3 className="m-h3">{drill.label}</h3>
                <WindowBar windows={MONEY_NEAR_WINDOWS} value={winKey} onChange={setWinKey} />
                <DrillChart lines={[{ key: drill.key, name: drill.label, color: "#7b9fff", rows: sliceWindow(series[drill.key], win), kind: "line" }]} format={(v) => fmtNum(v, 2) + "%"} zeroLine={drill.key.startsWith("t10")} pinnedDate={pinnedDate} onPin={onPin} />
              </>
            );
          }
          if (drill?.kind === "auction") {
            const same = auctions.filter((a) => a.security_type === latestA.security_type).map((a) => ({ date: a.auction_date, value: a.bid_to_cover_ratio }));
            return (
              <>
                <h3 className="m-h3">{latestA.security_type} auctions · bid-to-cover</h3>
                <WindowBar windows={MONEY_NEAR_WINDOWS.slice(0, 4)} value={winKey === "all" ? "2y" : winKey} onChange={setWinKey} />
                <DrillChart lines={[{ key: "b", name: "Bid-to-cover", color: "#7b9fff", rows: sliceWindow(same, win), kind: "line" }]} format={(v) => fmtNum(v, 2)} pinnedDate={pinnedDate} onPin={onPin} />
                <Caveat>Auction data covers roughly the last four months.</Caveat>
              </>
            );
          }

          const feed = YIELDS.map(([k, label]) => ({ key: k, label, lc: lastChange(series[k]) })).filter((x) => x.lc).sort((a, b) => (a.lc.date < b.lc.date ? 1 : -1));
          const t = latestA.total_accepted || 0;
          const pct = (v) => (t ? fmtPct((v / t) * 100, 0) : DASH);
          return (
            <>
              <div className="m-section">Latest auction</div>
              <GlanceRow
                label={`${latestA.security_type} · ${latestA.security_term}`}
                value={`${fmtNum(latestA.bid_to_cover_ratio, 2)} bid-to-cover`}
                sub={`Indirect ${pct(latestA.indirect_bidder_accepted)} · Direct ${pct(latestA.direct_bidder_accepted)} · Dealers ${pct(latestA.primary_dealer_accepted)} · SOMA ${pct(latestA.soma_accepted)} of accepted`}
                asOf={latestA.auction_date}
                spark={auctions.filter((a) => a.security_type === latestA.security_type).map((a) => ({ date: a.auction_date, value: a.bid_to_cover_ratio }))}
                onTap={() => { setWinKey("1y"); setDrill({ kind: "auction" }); }}
              />
              <div className="m-section">Yields, newest first</div>
              {feed.map(({ key, label, lc }) => (
                <GlanceRow key={key} label={label} value={fmtNum(lc.value, 2) + "%"} sub={lc.change != null ? `${fmtSigned(lc.change, 2)} pp vs prior reading` : undefined} asOf={lc.date} spark={sliceWindow(series[key], { days: 45 })} sparkColor="#7b9fff" onTap={() => { setWinKey("45d"); setDrill({ kind: "yield", key, label }); }} />
              ))}
              <Caveat>Yields are daily closes; spreads are computed from them. Change is in percentage points.</Caveat>
            </>
          );
        })()}
      </Loading>
      {au.error && <div className="m-empty m-empty--err">Auction data unavailable ({au.error}).</div>}
    </Screen>
  );
}

// ---------------------------------------------------------------- M4
const SOMA_PATH = "/api/fed-operational-flow/db?since=2099-12-31"; // soma_holdings + cumulative_net ignore `since`; a future date skips the multi-MB operations lists

function Holders({ onBack }) {
  const [drill, setDrill] = useState(null);
  const { pinnedDate, onPin } = usePin();
  const st = useGet(moneyPath(SINCE_2000));
  const soma = useGet(SOMA_PATH);

  return (
    <Screen title="Who is holding US debt?" onBack={drill ? () => setDrill(null) : onBack}>
      <Loading state={st}>
        {st.data && (() => {
          const tic = st.data.tic_countries || {};
          const total = rows(st.data.tic_grand_total);
          const tl = lastChange(total);
          if (drill?.kind === "tic") {
            const r = drill.key === "__total" ? total : rows(tic[drill.key]);
            return (
              <>
                <h3 className="m-h3">{drill.key === "__total" ? "All foreign holders" : drill.key}</h3>
                <DrillChart lines={[{ key: "t", name: "Holdings", color: "#7b9fff", rows: r, kind: "line" }]} format={(v) => "$" + fmtNum(v, 3) + "T"} axisFormat={(v) => "$" + fmtNum(v, 2) + "T"} pinnedDate={pinnedDate} onPin={onPin} />
                <Caveat>Data begins when FRED's series do (2006). Foreign holdings lag about two months by design.</Caveat>
              </>
            );
          }
          if (drill?.kind === "soma") {
            const h = (soma.data?.soma_holdings || []).map((x) => ({ date: x.as_of_date, value: x.total }));
            return (
              <>
                <h3 className="m-h3">Federal Reserve (SOMA) holdings</h3>
                <DrillChart lines={[{ key: "s", name: "SOMA total", color: "#e05252", rows: h, kind: "line" }]} format={(v) => fmtUsdCompact(v)} axisFormat={(v) => fmtUsdCompact(v, 0)} pinnedDate={pinnedDate} onPin={onPin} />
                <Caveat>Includes mortgage-backed securities as well as Treasuries. History starts in 2003.</Caveat>
              </>
            );
          }
          const countries = Object.entries(tic).map(([name, arr]) => ({ name, lc: lastChange(rows(arr)) })).filter((x) => x.lc).sort((a, b) => b.lc.value - a.lc.value);
          const sh = soma.data?.soma_holdings;
          const sl = sh?.length ? sh[sh.length - 1] : null;
          const treas = sl ? (sl.bills ?? 0) + (sl.notesbonds ?? 0) + (sl.tips ?? 0) + (sl.tips_inflation_compensation ?? 0) + (sl.frn ?? 0) : null;
          return (
            <>
              <div className="m-card m-card--note"><strong>Foreign holdings as of {tl?.date ?? DASH}.</strong> About two months behind today by design: this is how the Treasury publishes it.</div>
              <GlanceRow label="All foreign holders" value={tl ? "$" + fmtNum(tl.value, 2) + "T" : DASH} sub="Long-term Treasuries" asOf={tl?.date} spark={total} onTap={() => setDrill({ kind: "tic", key: "__total" })} />
              <GlanceRow label="Federal Reserve (SOMA)" value={sl ? fmtUsdCompact(sl.total) : DASH} sub={treas != null ? `of which Treasuries ${fmtUsdCompact(treas)}; the rest is mortgage-backed and agency` : soma.loading ? "loading" : undefined} asOf={sl?.as_of_date} spark={(sh || []).map((x) => ({ date: x.as_of_date, value: x.total }))} sparkColor="#e05252" onTap={sl ? () => setDrill({ kind: "soma" }) : undefined} />
              <div className="m-section">Foreign holders by country</div>
              {countries.map((c) => (
                <GlanceRow key={c.name} label={c.name} value={"$" + fmtNum(c.lc.value, 3) + "T"} sub={tl ? `${fmtPct((c.lc.value / tl.value) * 100, 1)} of foreign total` : undefined} asOf={c.lc.date} onTap={() => setDrill({ kind: "tic", key: c.name })} />
              ))}
              <Caveat>These two slices are not the whole. Domestic private holders (banks, funds, pensions and households) are not in AV. Foreign holdings are recorded by the country of the custodian that holds the security, not necessarily the owner, and cover long-term Treasuries only (no T-bills). Cayman Islands is part of Total Caribbean, so do not add them.</Caveat>
            </>
          );
        })()}
      </Loading>
    </Screen>
  );
}

// ---------------------------------------------------------------- M5
function useDebounced(v, ms = 350) {
  const [x, setX] = useState(v);
  useEffect(() => { const id = setTimeout(() => setX(v), ms); return () => clearTimeout(id); }, [v, ms]);
  return x;
}

function BankScreen({ cert, onBack, onOpen }) {
  const { pinnedDate, onPin } = usePin();
  const st = useGet(`/api/bank-registry/db/bank/${cert}`);
  const hist = useGet(`/api/bank-registry/db/bank/${cert}/history`);
  return (
    <Screen title={st.data?.bank?.name ?? "Bank"} onBack={onBack} sub={st.data ? `${st.data.bank.city ?? ""}${st.data.bank.state ? ", " + st.data.bank.state : ""}` : undefined}>
      <Loading state={st}>
        {st.data && (() => {
          const { bank, reserve_bank: rb } = st.data;
          const share = bank.total_assets != null && bank.district_active_assets ? (bank.total_assets / bank.district_active_assets) * 100 : null;
          const rbAssets = rb?.balance_sheet?.total_assets;
          const ratio = bank.total_assets != null && rbAssets ? bank.total_assets / rbAssets : null;
          return (
            <>
              <div className="m-acq">
                <div className="m-kv"><span>Assets</span><span>{fmtUsdCompact(bank.total_assets)}</span></div>
                <div className="m-kv"><span>Deposits</span><span>{fmtUsdCompact(bank.deposits)}</span></div>
                <div className="m-kv"><span>Equity</span><span>{fmtUsdCompact(bank.equity)}</span></div>
                <div className="m-row-asof">as of {bank.financials_as_of ?? DASH}</div>
              </div>
              <div className="m-acq">
                <div className="m-kv"><span>District</span><span>{bank.fed_district ? `${bank.fed_district}${rb?.city ? " · " + rb.city : ""}` : DASH}</span></div>
                <div className="m-kv"><span>District rank</span><span>{bank.district_rank != null ? `#${bank.district_rank} of ${bank.district_active_sized_count}` : DASH}</span></div>
                <div className="m-kv"><span>Share of district assets</span><span>{share != null ? fmtPct(share, 1) : DASH}</span></div>
                <div className="m-kv"><span>Size vs. its Reserve Bank</span><span>{ratio != null ? `${fmtNum(ratio, 1)}× the balance sheet` : DASH}</span></div>
                <div className="m-kv"><span>Charter / regulator</span><span>{bank.charter_class ?? DASH} / {bank.regulator ?? DASH}</span></div>
                <div className="m-kv"><span>Holding company</span><span>{bank.holding_company ?? DASH}</span></div>
              </div>
              <div className="m-section">Assets since 2002</div>
              <Loading state={hist}>
                {hist.data && hist.data.length > 0 && (() => {
                  const r = hist.data.map((h) => ({ date: h.date, value: h.total_assets }));
                  const anns = [];
                  hist.data.forEach((h, i) => { if (i > 0 && h.fed_district !== hist.data[i - 1].fed_district) anns.push({ date: h.date, mark: String(h.fed_district ?? "?") }); });
                  return (
                    <>
                      <DrillChart lines={[{ key: "a", name: "Total assets", color: "#7b9fff", rows: r, kind: "line" }]} annotations={anns} format={(v) => fmtUsdCompact(v)} axisFormat={(v) => fmtUsdCompact(v, 0)} pinnedDate={pinnedDate} onPin={onPin}
                        detail={(date) => { const h = hist.data.find((x) => x.date === date); return h ? [{ label: "District", value: h.fed_district ?? DASH }, { label: "District rank", value: h.district_rank != null ? "#" + h.district_rank : DASH }, { label: "U.S. rank", value: h.us_rank != null ? "#" + h.us_rank : DASH }] : []; }} />
                      {anns.length > 0 && <div className="m-sub">Numbered markers show the quarter the bank's Fed district changed.</div>}
                    </>
                  );
                })()}
              </Loading>
              {bank.holding_company_peers?.length > 0 && (
                <>
                  <div className="m-section">Same holding company</div>
                  {bank.holding_company_peers.map((p) => (
                    <GlanceRow key={p.cert} label={p.name} value={fmtUsdCompact(p.total_assets)} sub={`District ${p.fed_district ?? DASH}`} onTap={() => onOpen(p.cert)} />
                  ))}
                </>
              )}
              <Caveat>The district is the FDIC's record of where the bank is chartered. It is not necessarily the Reserve Bank the bank actually deals with.</Caveat>
            </>
          );
        })()}
      </Loading>
    </Screen>
  );
}

function BankLookup({ onBack }) {
  const [q, setQ] = useState("");
  const [district, setDistrict] = useState("");
  const [cert, setCert] = useState(null);
  const dq = useDebounced(q.trim());
  const ready = dq.length >= 2 || district;
  const st = useGet(ready ? `/api/bank-registry/db?q=${encodeURIComponent(dq)}${district ? `&district=${district}` : ""}&limit=50` : null);
  if (cert) return <BankScreen cert={cert} onBack={() => setCert(null)} onOpen={setCert} />;
  return (
    <Screen title="Bank lookup" onBack={onBack}>
      <input className="m-input" type="search" inputMode="search" placeholder="Bank name (2+ letters)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Bank name" />
      <select className="m-input" style={{ marginTop: 8 }} value={district} onChange={(e) => setDistrict(e.target.value)} aria-label="Fed district">
        <option value="">Any Fed district</option>
        {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>District {i + 1}</option>)}
      </select>
      {!ready && <div className="m-empty">Type a name or pick a district.</div>}
      {ready && <Loading state={st}>
        {st.data && st.data.length === 0 && <div className="m-empty">No banks found.</div>}
        {st.data?.map((b) => (
          <GlanceRow key={b.cert} label={`District ${b.fed_district ?? DASH}${b.active ? "" : " · inactive"}`} value={b.name} sub={`${b.city ?? ""}${b.state ? ", " + b.state : ""} · ${fmtUsdCompact(b.total_assets)}`} onTap={() => setCert(b.cert)} />
        ))}
        {st.data?.length === 50 && <div className="m-sub">Showing the first 50. Narrow the search.</div>}
      </Loading>}
    </Screen>
  );
}

// ---------------------------------------------------------------- M6
const SOMA_WINDOWS = [...MONEY_WINDOWS, { key: "all", label: "All", all: true }];

function Mechanics({ onBack }) {
  const [drill, setDrill] = useState(null);
  const [winKey, setWinKey] = useState("all");
  const { pinnedDate, onPin } = usePin();
  const soma = useGet(SOMA_PATH);
  const bg = useGet("/api/fed-money-creation-vs-bank-growth/db");
  const win = SOMA_WINDOWS.find((w) => w.key === winKey);

  if (drill === "soma") {
    return (
      <Screen title="SOMA holdings vs. cumulative purchases" onBack={() => setDrill(null)}>
        <WindowBar windows={SOMA_WINDOWS} value={winKey} onChange={setWinKey} />
        <Loading state={soma}>
          {soma.data && (() => {
            const h = soma.data.soma_holdings.map((x) => ({ date: x.as_of_date, value: x.total }));
            const c = soma.data.cumulative_net.map((x) => ({ date: x.date, value: x.cumulative_net }));
            const lh = h[h.length - 1]?.value, lc = c[c.length - 1]?.value;
            return (
              <>
                <div className="m-legend"><span><i className="m-swatch" style={{ background: "#e05252" }} />Published SOMA total</span><span><i className="m-swatch" style={{ background: "#919bb0" }} />Derived running net of purchases</span></div>
                <DrillChart lines={[{ key: "h", name: "Published SOMA total", color: "#e05252", rows: sliceWindow(h, win), kind: "line" }, { key: "c", name: "Derived running net", color: "#919bb0", rows: sliceWindow(c, win), kind: "line", dash: "5 4" }]} format={(v) => fmtUsdCompact(v, 2)} axisFormat={(v) => fmtUsdCompact(v, 0)} pinnedDate={pinnedDate} onPin={onPin} />
                <Caveat>The derived line runs {lh && lc ? fmtNum(lc / lh, 1) + "×" : "well"} above the published total. Securities that mature roll off the portfolio without ever being recorded as a sale, so a purchase that replaces a maturity looks the same as a purchase of new money in the operations record. The published total is the figure of record; the derived line is a cross-check.</Caveat>
              </>
            );
          })()}
        </Loading>
      </Screen>
    );
  }
  if (drill === "bank") {
    return (
      <Screen title="U.S. bank assets vs. SOMA" onBack={() => setDrill(null)} sub="Quarterly">
        <WindowBar windows={SOMA_WINDOWS} value={winKey} onChange={setWinKey} />
        <Loading state={bg}>
          {bg.data && (
            <>
              <div className="m-legend"><span><i className="m-swatch" style={{ background: "#7b9fff" }} />Total U.S. bank assets</span><span><i className="m-swatch" style={{ background: "#e05252" }} />SOMA holdings</span></div>
              <DrillChart lines={[{ key: "b", name: "Bank assets", color: "#7b9fff", rows: sliceWindow(bg.data.map((x) => ({ date: x.quarter, value: x.total_bank_assets })), win), kind: "line" }, { key: "s", name: "SOMA", color: "#e05252", rows: sliceWindow(bg.data.map((x) => ({ date: x.quarter, value: x.soma_holdings })), win), kind: "line" }]} format={(v) => fmtUsdCompact(v, 2)} axisFormat={(v) => fmtUsdCompact(v, 0)} pinnedDate={pinnedDate} onPin={onPin} />
              <Caveat>These are two independently measured totals shown side by side. This is correlation only: no source says which banks, if any, received Fed-created reserves, so nothing here shows one causing the other. Quarterly is the finest resolution the bank data allows.</Caveat>
            </>
          )}
        </Loading>
      </Screen>
    );
  }
  return (
    <Screen title="How money is created and destroyed" onBack={onBack}>
      <GlanceRow label="SOMA holdings vs. cumulative purchases" value="Chart" sub="Published total against the derived running net" onTap={() => setDrill("soma")} />
      <GlanceRow label="U.S. bank assets vs. SOMA" value="Chart" sub="Quarterly, correlation only" onTap={() => setDrill("bank")} />
      <div className="m-section">Mechanism cards</div>
      {MECHANISM_CARDS.map((c) => (
        <Collapsible key={c.id} title={`${c.id}. ${c.title}`}>
          {c.body.map((p, i) => <p key={i}>{p}</p>)}
          <p className="m-caveat"><strong>In AV:</strong> {c.inAv}</p>
        </Collapsible>
      ))}
    </Screen>
  );
}

// ---------------------------------------------------------------- home
export default function Money() {
  const [screen, setScreen] = useState(null);
  const st = useGet(moneyPath(SINCE_2000));
  const back = () => setScreen(null);
  if (screen === "growth") return <Growth onBack={back} />;
  if (screen === "created") return <Created onBack={back} />;
  if (screen === "treasuries") return <Treasuries onBack={back} />;
  if (screen === "holders") return <Holders onBack={back} />;
  if (screen === "banks") return <BankLookup onBack={back} />;
  if (screen === "mechanics") return <Mechanics onBack={back} />;

  const d = st.data;
  const m2 = d ? pctSince(rows(d.m2), SINCE_2000) : null;
  const wal = d ? pctSince(rows(d.walcl), SINCE_2000) : null;
  const y10 = d ? lastChange((d.dgs10 || []).map((r) => ({ date: r.date, value: r.value }))) : null;
  const tl = d ? lastChange(rows(d.tic_grand_total)) : null;
  return (
    <>
      <h2 className="m-h2">Money <SyncedAgo sourceKey={["money_supply", "fed_transmission"]} /></h2>
      <GlanceRow label="How much has the money pool grown?" value={m2 ? `M2 ${fmtSignedPct(m2.pct, 0)}` : DASH} sub={m2 ? `since ${sinceLabel(m2.from)}${wal ? ` · Fed balance sheet ${fmtSignedPct(wal.pct, 0)}` : ""}` : st.loading ? "loading" : undefined} asOf={m2?.to} onTap={() => setScreen("growth")} />
      <GlanceRow label="How much money has been created or destroyed?" value="Fed layer and bank layer" sub="Shown separately, never combined" onTap={() => setScreen("created")} />
      <GlanceRow label="What happened last in Treasuries?" value={y10 ? `10-year ${fmtNum(y10.value, 2)}%` : DASH} sub={y10?.change != null ? `${fmtSigned(y10.change, 2)} pp vs prior reading` : undefined} asOf={y10?.date} onTap={() => setScreen("treasuries")} />
      <GlanceRow label="Who is holding US debt?" value={tl ? `Foreign $${fmtNum(tl.value, 2)}T` : DASH} sub="Plus the Federal Reserve" asOf={tl?.date} onTap={() => setScreen("holders")} />
      <GlanceRow label="Look up a bank" value="Search" sub="Size, district, history" onTap={() => setScreen("banks")} />
      <GlanceRow label="How is money created and destroyed?" value="Explainers" sub="SOMA charts and five mechanism cards" onTap={() => setScreen("mechanics")} />
    </>
  );
}
