import { useState } from "react";
import { useGetAll } from "./api";
import { DrillChart } from "./charts";
import { Screen, Loading, MetalToggle, WindowBar, GlanceRow, Caveat, SyncedAgo } from "./ui";
import { TRADING_WINDOWS } from "./windows";
import { usePin } from "./pin";
import { sliceWindow, lastChange, percentileRank, ordinal, fmtNum, fmtUsd, fmtCompact, fmtSigned, DASH } from "./stats";

// Trading (mobile-spec.md Section 4): one row per series for the selected
// metal, each drilling to one single-series chart. CoT positioning and
// "who's holding long positions" are deliberately not here (desktop-only).

const SERIES = (metal, d) => {
  const [lev, curve, vol, px] = d;
  return {
    lev: { rows: lev.map((r) => ({ date: r.date, value: r.paper_leverage })) },
    curve: { rows: curve.map((r) => ({ date: r.date, value: r.curve_spread_pct == null ? null : r.curve_spread_pct * 100 })) },
    vol: { rows: vol.map((r) => ({ date: r.date, value: r.volume })) },
    px: { rows: px.map((r) => ({ date: r.date, value: r.close })), raw: px },
  };
};

export default function Trading() {
  const [metal, setMetal] = useState("XAG");
  const [winKey, setWinKey] = useState("1y");
  const [drill, setDrill] = useState(null);
  const { pinnedDate, onPin } = usePin();
  const win = TRADING_WINDOWS.find((w) => w.key === winKey);
  const m = metal === "XAG" ? "silver" : "gold";
  const state = useGetAll([
    `/api/${m}/db/leverage/history`,
    `/api/curve-spread/db?metal=${metal}`,
    `/api/volume/db/history?metal=${metal}`,
    `/api/metals/prices/db/daily-range?metal=${metal}`,
  ]);

  const toggle = <MetalToggle metal={metal} onChange={(k) => { setMetal(k); setDrill(null); }} />;

  return (
    <Loading state={state}>
      {state.data && (() => {
        const S = SERIES(metal, state.data);
        const windowed = (k) => sliceWindow(S[k].rows, win);
        const pctLine = (k) => {
          const p = percentileRank(windowed(k));
          return p == null ? "percentile: not enough points in this window" : `${ordinal(p)} percentile, ${win.label}`;
        };
        const defs = {
          lev: { title: "Paper leverage", color: "#e0c14c", fmt: (v) => fmtNum(v) + "x", val: (v) => fmtNum(v) + "x", note: "Weekly: leverage uses the CFTC open-interest report, so it is as fresh as the latest CoT report." },
          curve: { title: "Curve spread", color: "#7b9fff", fmt: (v) => fmtSigned(v) + "%", val: (v) => fmtSigned(v) + "%", zero: true, note: "Front vs. next month. Positive is contango, negative is backwardation." },
          vol: { title: "Volume", color: "#919bb0", fmt: (v) => fmtNum(v, 0), val: (v) => fmtCompact(v), bar: true, note: "Contracts. Real volume history is short and grows forward, so a long window may be mostly empty." },
          px: { title: "Price high / low", color: "#5aa9e6", fmt: (v) => fmtUsd(v), val: (v) => fmtUsd(v), note: "Daily close shown; touch a date for that day's high and low." },
        };

        if (drill) {
          const d = defs[drill];
          const rows = windowed(drill);
          return (
            <Screen title={`${metal === "XAG" ? "Silver" : "Gold"} · ${d.title}`} onBack={() => setDrill(null)} sub={d.note}>
              <WindowBar windows={TRADING_WINDOWS} value={winKey} onChange={setWinKey} />
              <DrillChart
                lines={[{ key: drill, name: d.title, color: d.color, rows, kind: d.bar ? "bar" : "line" }]}
                format={(v) => d.fmt(v)}
                barColor={() => d.color}
                zeroLine={!!d.zero}
                pinnedDate={pinnedDate}
                onPin={onPin}
                detail={drill === "px" ? (date) => {
                  const r = S.px.raw.find((x) => x.date === date);
                  return r ? [{ label: "High", value: fmtUsd(r.high) }, { label: "Low", value: fmtUsd(r.low) }] : [];
                } : undefined}
              />
              {drill === "curve" && <Caveat>Both months are paper contracts. This is not a spot-versus-futures gap.</Caveat>}
            </Screen>
          );
        }

        const rowFor = (k, extra = {}) => {
          const d = defs[k];
          const lc = lastChange(windowed(k));
          return (
            <GlanceRow
              key={k}
              label={d.title}
              value={lc ? d.val(lc.value) : DASH}
              sub={<>{lc?.change != null ? `${fmtSigned(lc.change)} vs prior · ` : ""}{k === "curve" && lc ? (lc.value >= 0 ? "contango · " : "backwardation · ") : ""}{pctLine(k)}</>}
              asOf={lc?.date}
              spark={windowed(k)}
              sparkColor={d.color}
              onTap={() => setDrill(k)}
              {...extra}
            />
          );
        };
        const pxLast = S.px.raw.length ? S.px.raw[S.px.raw.length - 1] : null;
        return (
          <>
            <h2 className="m-h2">Trading <SyncedAgo sourceKey={["silver_leverage", "futures_curve_spread", "metals_prices"]} /></h2>
            {toggle}
            <WindowBar windows={TRADING_WINDOWS} value={winKey} onChange={setWinKey} />
            {rowFor("lev")}
            {rowFor("curve")}
            {rowFor("vol")}
            <GlanceRow
              label="Price high / low"
              value={pxLast ? fmtUsd(pxLast.close) : DASH}
              sub={pxLast ? `High ${fmtUsd(pxLast.high)} · Low ${fmtUsd(pxLast.low)}` : undefined}
              asOf={pxLast?.date}
              spark={windowed("px")}
              sparkColor={defs.px.color}
              onTap={() => setDrill("px")}
            />
            <Caveat>Percentiles compare each series with its own history over the selected window. They are descriptive, not a signal.</Caveat>
          </>
        );
      })()}
    </Loading>
  );
}
