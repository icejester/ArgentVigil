// Trading Simulator (specs/margin-simulator-spec.md) — a sub-page of the
// Trading tab, opened from the "Paper Games" header. Makes futures leverage
// visible: hypothetical long and short accounts, a price move (slider) or a
// day-by-day price path (time mode), and each account's margin balance as a
// percent of what it first posted.
//
// What's real: the margin rate (seeded from CME notices, GET
// /api/futures-margins/db), each contract's size (same route), and in
// "Real window" mode the price path (real daily closes, GET
// /api/metals/prices/db/daily-range). What's synthetic: the participants —
// contract counts and entry prices are generated, never real traders.
// Illustration only: no prediction, no trading.
//
// All math runs here in the browser; nothing is persisted except a setup
// the user explicitly saves (Story #4, /api/margin-sim/scenarios).

import { useEffect, useMemo, useRef, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { apiFetch } from "./api_client";
import ChartStaleness from "./chart_staleness";
import { MM_PIE_COLORS, TEXT_MUTED } from "./palette";
import { xTicks } from "./date_utils";

// Side identity colors — validated as a 2-slot categorical palette on the
// #141820 panel surface (dataviz validator: CVD ΔE 26.8, normal 31.8, all
// checks pass). Deliberately NOT green/red: long vs short is identity, not
// good vs bad — red is reserved for the margin-call status below.
const LONG_COLOR = MM_PIE_COLORS[0];
const SHORT_COLOR = MM_PIE_COLORS[1];
const CALL_COLOR = "#e05252";
const MUTED = TEXT_MUTED;
const INK = "#c8d0de";
const GRID = "#2e3547";

const MIN_TOTAL = 5;
const MAX_TOTAL = 10;
const SLIDER_RANGE_PCT = 30;
const STEP_MOVES = [-5, -2, -1, 1, 2, 5];
const PLAY_MS = 250;
const DEFAULT_SEEDED_DAYS = 60;

// --- deterministic randomness -------------------------------------------
// Seeded so "Reshuffle"/"New path" are reproducible and a saved setup can
// record its seed instead of the whole generated array.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const newSeed = () => Math.floor(Math.random() * 2 ** 31);
const round2 = (x) => Math.round(x * 100) / 100;

// Long contract counts are random; the SAME total is then split across the
// shorts, so the book is balanced (every long contract has a short on the
// other side). That's what makes a price move exactly zero-sum below.
export function makeParticipants(nLong, nShort, seed) {
  const rand = mulberry32(seed);
  const longs = Array.from({ length: nLong }, () => ({
    side: "long",
    contracts: 1 + Math.floor(rand() * 12),
    entry_offset_pct: round2((rand() * 2 - 1) * 4),
  }));
  let total = longs.reduce((s, p) => s + p.contracts, 0);
  if (total < nShort) {
    longs[0].contracts += nShort - total;
    total = nShort;
  }
  const weights = Array.from({ length: nShort }, () => 0.3 + rand());
  const wSum = weights.reduce((s, w) => s + w, 0);
  const counts = weights.map((w) => Math.max(1, Math.floor((total * w) / wSum)));
  let diff = total - counts.reduce((s, c) => s + c, 0);
  for (let i = 0; diff > 0; i = (i + 1) % nShort, diff--) counts[i] += 1;
  while (diff < 0) {
    const i = counts.indexOf(Math.max(...counts));
    counts[i] -= 1;
    diff += 1;
  }
  const shorts = counts.map((c) => ({
    side: "short",
    contracts: c,
    entry_offset_pct: round2((rand() * 2 - 1) * 4),
  }));
  return [...longs, ...shorts];
}

// Generated path: a random walk of daily log returns, normal(0, vol).
function generatedPath(start, days, volPct, seed) {
  const rand = mulberry32(seed);
  const out = [start];
  for (let i = 1; i < days; i++) {
    const u = Math.max(rand(), 1e-12);
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    out.push(out[i - 1] * Math.exp((z * volPct) / 100));
  }
  return out;
}

function steppedPath(start, moves) {
  const out = [start];
  for (const m of moves) out.push(out[out.length - 1] * (1 + m / 100));
  return out;
}

// --- the accounting --------------------------------------------------------
// One account at one price. Initial margin is posted at the participant's
// entry price; every price change since is marked to market into the
// balance (summing daily settlements = price change since entry, since this
// sim never tops an account back up). CME sets margin as a percent of
// contract VALUE, so the maintenance requirement moves with the price — a
// rally raises it for longs and shorts alike.
function accountAt(p, entry, price, oz, initPct, maintPct) {
  const units = oz * p.contracts;
  const sign = p.side === "long" ? 1 : -1;
  const posted = (initPct / 100) * entry * units;
  const balance = posted + sign * (price - entry) * units;
  const maint = maintPct != null ? (maintPct / 100) * price * units : null;
  return {
    posted,
    balance,
    marginPct: (balance / posted) * 100,
    callLinePct: maint != null ? (maint / posted) * 100 : null,
    inCall: maint != null && balance < maint,
    wiped: balance <= 0,
  };
}

const fmtUsd = (v) =>
  v == null ? "—" : `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const fmtSignedUsd = (v) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const fmtPrice = (v) => (v == null ? "—" : `$${v.toFixed(3)}`);
const fmtPct = (v, d = 1) => (v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(d)}%`);
const parseRate = (s) => {
  const v = parseFloat(s);
  return Number.isFinite(v) && v > 0 && v < 100 ? v : null;
};
const labelFor = (participants, idx) => {
  const side = participants[idx].side;
  const n = participants.slice(0, idx + 1).filter((p) => p.side === side).length;
  return `${side === "long" ? "Long" : "Short"} ${n}`;
};

const SIDE_LEGEND = [
  {
    key: "long",
    legendLabel: "Long accounts",
    color: LONG_COLOR,
    eli5:
      "A long holds contracts that gain when price rises. Each long here posted initial margin when it opened — the margin rate times the contract's value at its entry price — and every day the exchange moves cash into or out of that account by the day's price change times the ounces held. Falling prices drain it.",
  },
  {
    key: "short",
    legendLabel: "Short accounts",
    color: SHORT_COLOR,
    eli5:
      "A short holds the other side: it gains when price falls. The book is balanced — total short contracts equal total long contracts — so every dollar a price move takes from the longs lands in the shorts' accounts, and the reverse. Rising prices drain the shorts.",
  },
];

export default function MarginSimulator({ onClose }) {
  const [margins, setMargins] = useState(null);
  const [prices, setPrices] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [contract, setContract] = useState("SI");
  const [initInput, setInitInput] = useState("");
  const [maintInput, setMaintInput] = useState("");
  const [rateIsSeeded, setRateIsSeeded] = useState(true);

  const [nLong, setNLong] = useState(5);
  const [nShort, setNShort] = useState(5);
  const [participantSeed, setParticipantSeed] = useState(newSeed);
  const [participants, setParticipants] = useState(() => makeParticipants(5, 5, participantSeed));

  const [mode, setMode] = useState("slider");
  const [movePct, setMovePct] = useState(0);
  const [source, setSource] = useState("generated");
  const [genDays, setGenDays] = useState(30);
  const [genVol, setGenVol] = useState(2);
  const [genSeed, setGenSeed] = useState(newSeed);
  const [steps, setSteps] = useState([]);
  const [customStep, setCustomStep] = useState("");
  const [seededStart, setSeededStart] = useState("");
  const [seededEnd, setSeededEnd] = useState("");
  const [day, setDay] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [clickedSide, setClickedSide] = useState(null);
  // A loaded setup's own rate, applied by the rate effect below after it
  // runs for the (possibly changed) contract — so the prefill can't
  // overwrite it.
  const pendingRateRef = useRef(null);
  const [loadNonce, setLoadNonce] = useState(0);

  useEffect(() => {
    apiFetch("/api/futures-margins/db")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setMargins(d.data))
      .catch((e) => setLoadError(`Could not load margin figures: ${e.message}`));
    apiFetch("/api/metals/prices/db/daily-range?metal=XAG&since=2000-01-01")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setPrices(d.data))
      .catch((e) => setLoadError(`Could not load silver price history: ${e.message}`));
  }, []);

  // Completed trading days only — today's bar can still be moving.
  const completed = useMemo(() => {
    if (!prices) return null;
    const today = new Date().toLocaleDateString("en-CA");
    return prices.filter((r) => r.date < today && r.close != null);
  }, [prices]);
  const lastClose = completed?.length ? completed[completed.length - 1] : null;

  useEffect(() => {
    if (!completed?.length || seededEnd) return;
    setSeededEnd(completed[completed.length - 1].date);
    setSeededStart(completed[Math.max(0, completed.length - DEFAULT_SEEDED_DAYS)].date);
  }, [completed, seededEnd]);

  // The rate the sim runs on. Prefilled from the contract's latest seeded
  // row; a contract with no row of its own (Micro Silver today) is
  // prefilled from the standard contract's and marked as an assumption.
  const contractMeta = margins?.contracts?.[contract];
  const seededRow = contractMeta?.latest ?? null;
  const fallbackRow = !seededRow ? margins?.contracts?.SI?.latest ?? null : null;
  const prefillRow = seededRow ?? fallbackRow;
  useEffect(() => {
    if (!margins) return;
    const pending = pendingRateRef.current;
    pendingRateRef.current = null;
    if (pending?.user_entered) {
      setInitInput(pending.initial_pct != null ? String(pending.initial_pct) : "");
      setMaintInput(pending.maintenance_pct != null ? String(pending.maintenance_pct) : "");
      setRateIsSeeded(false);
      return;
    }
    setInitInput(prefillRow?.initial_pct != null ? String(prefillRow.initial_pct) : "");
    setMaintInput(prefillRow?.maintenance_pct != null ? String(prefillRow.maintenance_pct) : "");
    setRateIsSeeded(seededRow != null);
  }, [margins, contract, loadNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const initPct = parseRate(initInput);
  const maintPct = parseRate(maintInput);
  const oz = contractMeta?.oz ?? null;

  const setCounts = (l, s) => {
    setNLong(l);
    setNShort(s);
    setParticipants(makeParticipants(l, s, participantSeed));
  };
  const reshuffle = () => {
    const seed = newSeed();
    setParticipantSeed(seed);
    setParticipants(makeParticipants(nLong, nShort, seed));
  };

  // --- the price path -----------------------------------------------------
  const seededRows = useMemo(() => {
    if (!completed || !seededStart || !seededEnd || seededStart > seededEnd) return [];
    return completed.filter((r) => r.date >= seededStart && r.date <= seededEnd);
  }, [completed, seededStart, seededEnd]);

  const path = useMemo(() => {
    if (!lastClose) return [];
    if (mode === "slider") return [{ label: "Now", price: lastClose.close * (1 + movePct / 100) }];
    if (source === "generated")
      return generatedPath(lastClose.close, genDays, genVol, genSeed).map((price, i) => ({ label: `Day ${i}`, price }));
    if (source === "stepped")
      return steppedPath(lastClose.close, steps).map((price, i) => ({ label: `Day ${i}`, price }));
    return seededRows.map((r) => ({ label: r.date, price: r.close }));
  }, [mode, source, lastClose, movePct, genDays, genVol, genSeed, steps, seededRows]);

  // Start price the entries are spread around: the last real close in
  // slider mode, the path's first day in time mode.
  const startPrice = mode === "slider" ? lastClose?.close ?? null : path[0]?.price ?? null;

  useEffect(() => {
    setDay(source === "stepped" ? Math.max(0, path.length - 1) : 0);
    setPlaying(false);
  }, [mode, source, genDays, genVol, genSeed, seededStart, seededEnd]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (source === "stepped") setDay(Math.max(0, path.length - 1));
  }, [steps.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastDay = Math.max(0, path.length - 1);
  const dayIdx = mode === "slider" ? 0 : Math.min(day, lastDay);

  const playRef = useRef(null);
  useEffect(() => {
    if (!playing) return undefined;
    playRef.current = setInterval(() => {
      setDay((d) => {
        if (d >= lastDay) {
          setPlaying(false);
          return d;
        }
        return d + 1;
      });
    }, PLAY_MS);
    return () => clearInterval(playRef.current);
  }, [playing, lastDay]);

  const ready = oz != null && initPct != null && startPrice != null && path.length > 0;

  // Per participant, per day: the account. Plus the first day a margin call
  // happens (time mode) — flagged, never auto-topped-up.
  const tracks = useMemo(() => {
    if (!ready) return null;
    return participants.map((p) => {
      const entry = startPrice * (1 + p.entry_offset_pct / 100);
      const days = path.map((pt) => accountAt(p, entry, pt.price, oz, initPct, maintPct));
      const firstCall = days.findIndex((a) => a.inCall);
      const firstWipe = days.findIndex((a) => a.wiped);
      return { p, entry, days, firstCall, firstWipe };
    });
  }, [ready, participants, startPrice, path, oz, initPct, maintPct]);

  const priceNow = path[dayIdx]?.price ?? null;
  const moveSinceStart = priceNow != null && startPrice != null ? priceNow - startPrice : null;
  const totalContracts = (side) => participants.filter((p) => p.side === side).reduce((s, p) => s + p.contracts, 0);
  const sideChange = (side) =>
    moveSinceStart == null || oz == null ? null : (side === "long" ? 1 : -1) * moveSinceStart * oz * totalContracts(side);

  const total = nLong + nShort;

  if (loadError) {
    return (
      <div className="comex-panel">
        <SimHeader onClose={onClose} />
        <div className="error-box">{loadError}</div>
      </div>
    );
  }
  if (!margins || !prices) {
    return (
      <div className="comex-panel">
        <SimHeader onClose={onClose} />
        <div className="loading">Loading margin figures and price history…</div>
      </div>
    );
  }

  const rateNote = seededRow
    ? rateIsSeeded
      ? `CME rate effective ${seededRow.effective_date}`
      : `Your own rate — CME's on file is ${fmtPct(seededRow.initial_pct, 0)} initial / ${fmtPct(seededRow.maintenance_pct, 0)} maintenance (effective ${seededRow.effective_date})`
    : fallbackRow
      ? `No Micro Silver rate on file — prefilled from the standard contract's ${fmtPct(fallbackRow.initial_pct, 0)} (effective ${fallbackRow.effective_date}). Treat it as your own assumption.`
      : "No margin rate on file for this contract — enter one to run the simulation.";

  return (
    <div className="comex-panel">
      <SimHeader onClose={onClose} />
      <div className="comex-panel-note">
        Hypothetical accounts, real margin rules. Contract counts and entry prices are generated — no real traders. This
        shows how a price move flows through margin accounts; it is not a forecast.
      </div>

      {/* Setup */}
      <div className="msim-controls">
        <label className="form-inline-label">
          Contract
          <select value={contract} onChange={(e) => setContract(e.target.value)}>
            {Object.entries(margins.contracts).map(([key, c]) => (
              <option key={key} value={key}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="form-inline-label">
          Initial margin %
          <input
            type="number" step="0.1" min="0.1" max="99" className="msim-num"
            value={initInput}
            onChange={(e) => { setInitInput(e.target.value); setRateIsSeeded(false); }}
          />
        </label>
        <label className="form-inline-label">
          Maintenance %
          <input
            type="number" step="0.1" min="0.1" max="99" className="msim-num"
            value={maintInput}
            onChange={(e) => { setMaintInput(e.target.value); setRateIsSeeded(false); }}
          />
        </label>
        {seededRow && !rateIsSeeded && (
          <button
            type="button" className="comex-range-btn"
            onClick={() => {
              setInitInput(String(seededRow.initial_pct ?? ""));
              setMaintInput(String(seededRow.maintenance_pct ?? ""));
              setRateIsSeeded(true);
            }}
          >
            Use CME rate
          </button>
        )}
        <ChartStaleness sourceKey="futures_margins" />
      </div>
      <div className="comex-panel-note">
        {rateNote}
        {seededRow?.source_url && rateIsSeeded && (
          <> · <a className="mm-link" href={seededRow.source_url} target="_blank" rel="noreferrer">source</a></>
        )}
        {initPct != null && maintPct != null && maintPct >= initPct && (
          <div>
            Maintenance is at or above initial, so an account falls below maintenance on almost any move against it.
            For speculative accounts CME has typically set initial above maintenance — try a higher initial rate to see
            the difference.
          </div>
        )}
      </div>

      <div className="msim-controls">
        <Stepper label="Longs" value={nLong} onChange={(v) => setCounts(v, nShort)} canDec={nLong > 1 && total > MIN_TOTAL} canInc={total < MAX_TOTAL} />
        <Stepper label="Shorts" value={nShort} onChange={(v) => setCounts(nLong, v)} canDec={nShort > 1 && total > MIN_TOTAL} canInc={total < MAX_TOTAL} />
        <button type="button" className="comex-range-btn" onClick={reshuffle}>Reshuffle accounts</button>
        <span className="comex-panel-note">{total} accounts · {totalContracts("long")} contracts each side</span>
      </div>

      {/* Mode */}
      <div className="comex-range-selector">
        {[["slider", "Price slider"], ["time", "Day by day"]].map(([key, label]) => (
          <button
            key={key} type="button"
            className={`comex-range-btn${mode === key ? " comex-range-btn--active" : ""}`}
            onClick={() => setMode(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "slider" && lastClose && (
        <div className="msim-slider">
          <input
            type="range" min={-SLIDER_RANGE_PCT} max={SLIDER_RANGE_PCT} step="0.5"
            value={movePct} onChange={(e) => setMovePct(parseFloat(e.target.value))}
          />
          <div className="msim-slider-readout">
            <strong>{fmtPrice(priceNow)}</strong>
            <span style={{ color: MUTED }}>
              {movePct > 0 ? "+" : ""}{movePct.toFixed(1)}% from the last close {fmtPrice(lastClose.close)} ({lastClose.date})
            </span>
            {movePct !== 0 && <button type="button" className="comex-range-btn" onClick={() => setMovePct(0)}>Reset</button>}
          </div>
        </div>
      )}

      {mode === "time" && (
        <TimeControls
          source={source} setSource={setSource}
          genDays={genDays} setGenDays={setGenDays} genVol={genVol} setGenVol={setGenVol}
          regenerate={() => setGenSeed(newSeed())}
          steps={steps} setSteps={setSteps} customStep={customStep} setCustomStep={setCustomStep}
          completed={completed} seededStart={seededStart} setSeededStart={setSeededStart}
          seededEnd={seededEnd} setSeededEnd={setSeededEnd} seededCount={seededRows.length}
        />
      )}

      {!ready && (
        <div className="comex-panel-note">
          {initPct == null
            ? "Enter an initial margin rate to run the simulation."
            : mode === "time" && source === "seeded"
              ? "Pick a date range with at least one trading day."
              : "Waiting for price data."}
        </div>
      )}

      {ready && mode === "time" && (
        <>
          <DayScrubber
            day={dayIdx} lastDay={lastDay} label={path[dayIdx]?.label} price={priceNow}
            setDay={(d) => { setPlaying(false); setDay(d); }}
            playing={playing} togglePlay={() => {
              if (!playing && dayIdx >= lastDay) setDay(0);
              setPlaying((p) => !p);
            }}
          />
          <div className="comex-chart-block">
            <div className="comex-chart-subheader">Price path</div>
            <PricePathChart path={path} dayIdx={dayIdx} onPickDay={(d) => { setPlaying(false); setDay(d); }} />
          </div>
          <div className="comex-chart-block">
            <div className="comex-chart-subheader">Margin balance, % of what each account posted</div>
            <MarginPathChart
              tracks={tracks} participants={participants} path={path} dayIdx={dayIdx} clickedSide={clickedSide}
              onPickDay={(d) => { setPlaying(false); setDay(d); }}
            />
            <SideLegend clickedSide={clickedSide} setClickedSide={setClickedSide} />
          </div>
        </>
      )}

      {ready && (
        <>
          <ZeroSumLine sideChange={sideChange} startLabel={mode === "slider" ? "the last close" : "day 0"} />
          <ParticipantBook
            tracks={tracks} participants={participants} dayIdx={dayIdx} timeMode={mode === "time"} path={path}
            clickedSide={clickedSide}
          />
        </>
      )}

      <ScenarioPanel
        current={{
          contract,
          participants,
          margin_rate_used: {
            initial_pct: initPct,
            maintenance_pct: maintPct,
            user_entered: !rateIsSeeded,
            effective_date: rateIsSeeded ? seededRow?.effective_date ?? null : null,
          },
          price_source_type: mode === "slider" ? "slider" : source,
          price_source_params:
            mode === "slider"
              ? { move_pct: movePct }
              : source === "generated"
                ? { days: genDays, daily_vol_pct: genVol, seed: genSeed }
                : source === "stepped"
                  ? { moves_pct: steps }
                  : { start: seededStart, end: seededEnd },
        }}
        onLoad={(s) => {
          setContract(s.contract);
          const l = s.participants.filter((p) => p.side === "long").length;
          setNLong(l);
          setNShort(s.participants.length - l);
          setParticipants(s.participants);
          const pp = s.price_source_params || {};
          if (s.price_source_type === "slider") {
            setMode("slider");
            setMovePct(pp.move_pct ?? 0);
          } else {
            setMode("time");
            setSource(s.price_source_type);
            if (s.price_source_type === "generated") {
              setGenDays(pp.days ?? 30);
              setGenVol(pp.daily_vol_pct ?? 2);
              setGenSeed(pp.seed ?? newSeed());
            } else if (s.price_source_type === "stepped") {
              setSteps(pp.moves_pct ?? []);
            } else {
              setSeededStart(pp.start ?? "");
              setSeededEnd(pp.end ?? "");
            }
          }
          // A seeded-rate setup reloads with today's seeded rate; a
          // user-entered one restores its own numbers.
          pendingRateRef.current = s.margin_rate_used;
          setLoadNonce((n) => n + 1);
        }}
      />
    </div>
  );
}

function SimHeader({ onClose }) {
  return (
    <div className="comex-panel-header">
      Trading Simulator
      <div className="comex-range-selector">
        <button type="button" className="comex-range-btn" onClick={onClose}>← Paper Games</button>
      </div>
    </div>
  );
}

function Stepper({ label, value, onChange, canDec, canInc }) {
  return (
    <span className="form-inline-label">
      {label}
      <button type="button" className="comex-range-btn" disabled={!canDec} onClick={() => onChange(value - 1)}>−</button>
      <strong style={{ color: INK, minWidth: 14, textAlign: "center" }}>{value}</strong>
      <button type="button" className="comex-range-btn" disabled={!canInc} onClick={() => onChange(value + 1)}>+</button>
    </span>
  );
}

function TimeControls({
  source, setSource, genDays, setGenDays, genVol, setGenVol, regenerate,
  steps, setSteps, customStep, setCustomStep,
  completed, seededStart, setSeededStart, seededEnd, setSeededEnd, seededCount,
}) {
  const minDate = completed?.[0]?.date;
  const maxDate = completed?.[completed.length - 1]?.date;
  const addCustom = () => {
    const v = parseFloat(customStep);
    if (Number.isFinite(v) && v > -100) {
      setSteps((s) => [...s, v]);
      setCustomStep("");
    }
  };
  return (
    <div className="msim-time">
      <div className="comex-range-selector">
        {[["generated", "Random walk"], ["stepped", "Step it yourself"], ["seeded", "Real window"]].map(([key, label]) => (
          <button
            key={key} type="button"
            className={`comex-range-btn${source === key ? " comex-range-btn--active" : ""}`}
            onClick={() => setSource(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {source === "generated" && (
        <div className="msim-controls">
          <label className="form-inline-label">
            Days
            <input type="number" min="5" max="250" className="msim-num" value={genDays}
              onChange={(e) => setGenDays(Math.min(250, Math.max(5, parseInt(e.target.value, 10) || 5)))} />
          </label>
          <label className="form-inline-label">
            Daily volatility %
            <input type="number" min="0.5" max="8" step="0.5" className="msim-num" value={genVol}
              onChange={(e) => setGenVol(Math.min(8, Math.max(0.5, parseFloat(e.target.value) || 0.5)))} />
          </label>
          <button type="button" className="comex-range-btn" onClick={regenerate}>New path</button>
          <span className="comex-panel-note">Starts from the last real close; each day's move is random with this typical size.</span>
        </div>
      )}

      {source === "stepped" && (
        <div className="msim-controls">
          <span className="form-inline-label">Next day</span>
          {STEP_MOVES.map((m) => (
            <button key={m} type="button" className="comex-range-btn" onClick={() => setSteps((s) => [...s, m])}>
              {m > 0 ? "+" : ""}{m}%
            </button>
          ))}
          <input
            type="number" step="0.1" className="msim-num" placeholder="%" value={customStep}
            onChange={(e) => setCustomStep(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCustom()}
          />
          <button type="button" className="comex-range-btn" onClick={addCustom}>Add</button>
          <button type="button" className="comex-range-btn" disabled={!steps.length} onClick={() => setSteps((s) => s.slice(0, -1))}>Undo</button>
          <button type="button" className="comex-range-btn" disabled={!steps.length} onClick={() => setSteps([])}>Clear</button>
          <span className="comex-panel-note">
            {steps.length ? `${steps.length} day${steps.length === 1 ? "" : "s"}: ${steps.map((m) => `${m > 0 ? "+" : ""}${m}%`).join(", ")}` : "Starts at the last real close. Choose each day's move."}
          </span>
        </div>
      )}

      {source === "seeded" && (
        <div className="msim-controls">
          <label className="form-inline-label">
            From
            <input type="date" value={seededStart} min={minDate} max={seededEnd || maxDate} onChange={(e) => setSeededStart(e.target.value)} />
          </label>
          <label className="form-inline-label">
            To
            <input type="date" value={seededEnd} min={seededStart || minDate} max={maxDate} onChange={(e) => setSeededEnd(e.target.value)} />
          </label>
          <span className="comex-panel-note">
            A real historical window of silver daily closes ({seededCount} trading days). Available {minDate} to {maxDate}.
          </span>
        </div>
      )}
    </div>
  );
}

function DayScrubber({ day, lastDay, label, price, setDay, playing, togglePlay }) {
  return (
    <div className="msim-slider">
      <div className="msim-slider-readout">
        <button type="button" className="comex-range-btn" disabled={lastDay === 0} onClick={togglePlay}>
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" className="comex-range-btn" disabled={day === 0} onClick={() => setDay(day - 1)}>◀</button>
        <button type="button" className="comex-range-btn" disabled={day >= lastDay} onClick={() => setDay(day + 1)}>▶</button>
        <strong>Day {day} of {lastDay}</strong>
        <span style={{ color: MUTED }}>{label !== `Day ${day}` ? label : ""}</span>
        <strong>{fmtPrice(price)}</strong>
      </div>
      {lastDay > 0 && (
        <input type="range" min="0" max={lastDay} step="1" value={day} onChange={(e) => setDay(parseInt(e.target.value, 10))} />
      )}
    </div>
  );
}

function PricePathTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="msim-tooltip">
      <div style={{ color: MUTED }}>{row.label}</div>
      <div style={{ color: INK }}>{fmtPrice(row.price)}</div>
    </div>
  );
}

function PricePathChart({ path, dayIdx, onPickDay }) {
  const data = path.map((pt, i) => ({ ...pt, i }));
  const ticks = xTicks(data.map((d) => ({ date: d.i })), 8);
  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
        onClick={(s) => s?.activeTooltipIndex != null && onPickDay(Number(s.activeTooltipIndex))}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="i" type="number" domain={[0, Math.max(1, data.length - 1)]} ticks={ticks}
          tickFormatter={(i) => (data[i]?.label.startsWith("Day") ? i : data[i]?.label ?? i)}
          tick={{ fill: MUTED, fontSize: 10 }} stroke={GRID} />
        <YAxis domain={["auto", "auto"]} tick={{ fill: MUTED, fontSize: 10 }} stroke={GRID} width={52}
          tickFormatter={(v) => `$${v.toFixed(2)}`} />
        <Tooltip content={<PricePathTooltip />} />
        <ReferenceLine x={dayIdx} stroke={INK} strokeDasharray="4 3" />
        <Line type="linear" dataKey="price" stroke={INK} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function MarginPathTooltip({ active, label, tracks, participants, path }) {
  if (!active || label == null || !tracks) return null;
  const i = Number(label);
  return (
    <div className="msim-tooltip">
      <div style={{ color: MUTED }}>{path[i]?.label} · {fmtPrice(path[i]?.price)}</div>
      {tracks.map((t, idx) => {
        const a = t.days[i];
        return (
          <div key={idx} style={{ color: INK }}>
            <span style={{ color: t.p.side === "long" ? LONG_COLOR : SHORT_COLOR }}>■ </span>
            {labelFor(participants, idx)}: {fmtPct(a.marginPct, 0)}
            {a.wiped ? " · wiped out" : a.inCall ? " · ⚠ margin call" : ""}
          </div>
        );
      })}
    </div>
  );
}

function MarginPathChart({ tracks, participants, path, dayIdx, clickedSide, onPickDay }) {
  const data = path.map((pt, i) => {
    const row = { i };
    tracks.forEach((t, idx) => { row[`p${idx}`] = t.days[i].marginPct; });
    return row;
  });
  const ticks = xTicks(data.map((d) => ({ date: d.i })), 8);
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
        onClick={(s) => s?.activeTooltipIndex != null && onPickDay(Number(s.activeTooltipIndex))}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="i" type="number" domain={[0, Math.max(1, data.length - 1)]} ticks={ticks}
          tickFormatter={(i) => (path[i]?.label.startsWith("Day") ? i : path[i]?.label ?? i)}
          tick={{ fill: MUTED, fontSize: 10 }} stroke={GRID} />
        <YAxis domain={["auto", "auto"]} tick={{ fill: MUTED, fontSize: 10 }} stroke={GRID} width={52}
          tickFormatter={(v) => `${Math.round(v)}%`} />
        <Tooltip content={<MarginPathTooltip tracks={tracks} participants={participants} path={path} />} />
        <ReferenceLine y={100} stroke={MUTED} strokeDasharray="2 4" />
        <ReferenceLine y={0} stroke={CALL_COLOR} strokeDasharray="2 4" />
        <ReferenceLine x={dayIdx} stroke={INK} strokeDasharray="4 3" />
        {tracks.map((t, idx) => {
          const dim = clickedSide && clickedSide !== t.p.side;
          return (
            <Line key={idx} type="linear" dataKey={`p${idx}`}
              stroke={t.p.side === "long" ? LONG_COLOR : SHORT_COLOR}
              strokeWidth={clickedSide === t.p.side ? 2.5 : 1.5}
              strokeOpacity={dim ? 0.15 : 0.9}
              dot={false} isAnimationActive={false} />
          );
        })}
      </LineChart>
    </ResponsiveContainer>
  );
}

function SideLegend({ clickedSide, setClickedSide }) {
  const active = SIDE_LEGEND.find((e) => e.key === clickedSide);
  return (
    <>
      <div className="comex-legend-list comex-legend-list--horizontal">
        {SIDE_LEGEND.map(({ key, legendLabel, color }) => (
          <button
            key={key}
            className={`comex-legend-item legend-btn-row${clickedSide === key ? " legend-btn-row--baseline" : ""}`}
            style={{ "--legend-color": color }}
            onClick={() => setClickedSide((prev) => (prev === key ? null : key))}
          >
            <span className="comex-legend-swatch" style={{ background: color }} />
            <span><strong>{legendLabel}</strong></span>
          </button>
        ))}
        <span className="comex-legend-item">Dotted lines: 100% (what was posted) and 0% (wiped out)</span>
      </div>
      {active && <div className="comex-panel-note comex-panel-note--eli5">{active.eli5}</div>}
    </>
  );
}

function ZeroSumLine({ sideChange, startLabel }) {
  const longs = sideChange("long");
  const shorts = sideChange("short");
  return (
    <div className="msim-zerosum">
      Since {startLabel}: longs <strong style={{ color: LONG_COLOR }}>{fmtSignedUsd(longs)}</strong>, shorts{" "}
      <strong style={{ color: SHORT_COLOR }}>{fmtSignedUsd(shorts)}</strong>
      <span style={{ color: MUTED }}> — the same dollars, moved from one side to the other.</span>
    </div>
  );
}

function ParticipantBook({ tracks, participants, dayIdx, timeMode, path, clickedSide }) {
  const indexed = tracks.map((t, idx) => ({ t, idx }));
  const column = (side) => indexed.filter(({ t }) => t.p.side === side);
  return (
    <div className="msim-book">
      {["long", "short"].map((side) => (
        <div key={side} className={`msim-column msim-column--${side}`} style={{ opacity: clickedSide && clickedSide !== side ? 0.4 : 1 }}>
          <div className="comex-chart-subheader" style={{ color: side === "long" ? LONG_COLOR : SHORT_COLOR }}>
            {side === "long" ? "Longs — gain when price rises" : "Shorts — gain when price falls"}
          </div>
          {column(side).map(({ t, idx }) => (
            <ParticipantCard key={idx} t={t} label={labelFor(participants, idx)} dayIdx={dayIdx} timeMode={timeMode} path={path} />
          ))}
        </div>
      ))}
    </div>
  );
}

// Bar scale: 0–200% of posted margin, clamped for drawing only (the number
// shown is always the real figure, even past either end).
const BAR_MAX = 200;
const barPos = (pct) => `${Math.min(100, Math.max(0, (pct / BAR_MAX) * 100))}%`;

function ParticipantCard({ t, label, dayIdx, timeMode, path }) {
  const a = t.days[dayIdx];
  const color = t.p.side === "long" ? LONG_COLOR : SHORT_COLOR;
  const status = a.wiped
    ? { text: "✕ Wiped out — balance below zero", color: CALL_COLOR }
    : a.inCall
      ? { text: "⚠ Margin call — below maintenance", color: CALL_COLOR }
      : { text: "Above maintenance", color: MUTED };
  return (
    <div className={`msim-card${a.inCall || a.wiped ? " msim-card--call" : ""}`}>
      <div className="msim-card-top">
        <strong style={{ color: INK }}>{label}</strong>
        <span style={{ color: MUTED }}>
          {t.p.contracts} contract{t.p.contracts === 1 ? "" : "s"} · entry {fmtPrice(t.entry)}
        </span>
        <span className="msim-card-pct" style={{ color: INK }}>{fmtPct(a.marginPct, 0)}</span>
      </div>
      <div className={`msim-bar msim-bar--${t.p.side}`}>
        <div className="msim-bar-fill" style={{ width: barPos(a.marginPct), background: color }} />
        <div className="msim-bar-mark msim-bar-mark--posted" style={{ left: barPos(100) }} />
        {a.callLinePct != null && (
          <div className="msim-bar-mark msim-bar-mark--call" style={{ left: barPos(a.callLinePct) }} />
        )}
      </div>
      <div className="msim-card-bottom">
        <span style={{ color: MUTED }}>
          Posted {fmtUsd(a.posted)} · now {fmtUsd(a.balance)}
          {a.callLinePct != null && <> · call below {fmtPct(a.callLinePct, 0)}</>}
        </span>
        <span style={{ color: status.color }}>{status.text}</span>
      </div>
      {timeMode && (t.firstCall >= 0 || t.firstWipe >= 0) && (
        <div className="msim-card-history" style={{ color: MUTED }}>
          {t.firstCall >= 0 && <>First margin call: {path[t.firstCall]?.label}{t.firstCall > dayIdx ? " (later in the path)" : ""}</>}
          {t.firstWipe >= 0 && <> · Wiped out: {path[t.firstWipe]?.label}</>}
        </div>
      )}
    </div>
  );
}

function ScenarioPanel({ current, onLoad }) {
  const [list, setList] = useState([]);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState(null);

  const refresh = () =>
    apiFetch("/api/margin-sim/scenarios/db")
      .then((r) => r.json())
      .then((d) => setList(d.data || []))
      .catch(() => setList([]));
  useEffect(() => { refresh(); }, []);

  const save = () => {
    apiFetch("/api/margin-sim/scenarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...current, scenario_name: name }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
        setName("");
        setMsg("Saved.");
        refresh();
      })
      .catch((e) => setMsg(`Not saved: ${e.message}`));
  };
  const remove = (id) =>
    apiFetch(`/api/margin-sim/scenarios/${id}`, { method: "DELETE" }).then(refresh);
  const load = (id) =>
    apiFetch(`/api/margin-sim/scenarios/${id}/db`)
      .then((r) => r.json())
      .then((d) => { onLoad(d.data); setMsg(`Loaded "${d.data.scenario_name}".`); });

  return (
    <details className="collapsible-pane">
      <summary className="collapsible-pane-title"><span>Saved setups ({list.length})</span></summary>
      <div className="collapsible-pane-body">
        <div className="msim-controls">
          <input type="text" placeholder="Name this setup" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="button" className="comex-range-btn" disabled={!name.trim()} onClick={save}>Save current setup</button>
          {msg && <span className="comex-panel-note">{msg}</span>}
        </div>
        {list.length > 0 && (
          <table className="comex-table">
            <thead>
              <tr><th>Name</th><th>Contract</th><th>Accounts</th><th>Price source</th><th>Rate</th><th>Saved</th><th /></tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <td><button type="button" className="mm-link msim-linkbtn" onClick={() => load(s.id)}>{s.scenario_name}</button></td>
                  <td>{s.contract}</td>
                  <td>{s.participants.length}</td>
                  <td>{s.price_source_type}</td>
                  <td>
                    {fmtPct(s.margin_rate_used?.initial_pct, 1)} / {fmtPct(s.margin_rate_used?.maintenance_pct, 1)}
                    {s.margin_rate_used?.user_entered ? " (yours)" : ""}
                  </td>
                  <td>{s.updated_at?.slice(0, 10)}</td>
                  <td><button type="button" className="comex-range-btn" onClick={() => remove(s.id)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}
