import { useTicks } from "./api";
import { TickChart } from "./charts";
import { fmtUsd, fmtSigned, fmtSignedPct, DASH } from "./stats";

// Current-session high/low and where price sits (Trading). A session runs
// from the 22:00 UTC Globex reopen (same boundary the spot persist-skip
// uses). On a weekend/closure the latest tick's session is shown and said so.
const HOUR = 3600 * 1000;
const sessionKey = (t) => Math.floor((t - 22 * HOUR) / (24 * HOUR));

export function sessionOf(rows) {
  if (!rows || rows.length === 0) return null;
  const key = sessionKey(rows[rows.length - 1].t);
  const s = rows.filter((r) => sessionKey(r.t) === key);
  let hi = -Infinity, lo = Infinity;
  for (const r of s) { if (r.price > hi) hi = r.price; if (r.price < lo) lo = r.price; }
  return { rows: s, open: s[0].price, cur: s[s.length - 1].price, hi, lo, start: key * 24 * HOUR + 22 * HOUR, lastT: s[s.length - 1].t };
}

export default function SessionRange({ metal, color }) {
  // 4 days covers a weekend closure back to the last real session.
  const { rows } = useTicks(metal, 4 * 24 * HOUR);
  if (rows == null) return <div className="m-empty">Loading session…</div>;
  const s = sessionOf(rows);
  if (!s) return <div className="m-empty">No recent price ticks.</div>;
  const range = s.hi - s.lo;
  const pos = range > 0 ? ((s.cur - s.lo) / range) * 100 : null;
  const chg = s.cur - s.open;
  const stale = Date.now() - s.lastT > 30 * 60 * 1000;
  const when = (t) => new Date(t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const tone = chg > 0 ? "m-pos" : chg < 0 ? "m-neg" : "";
  return (
    <div className="m-session">
      <div className="m-session-head">
        <div className="m-big">{fmtUsd(s.cur)}</div>
        <div className={"m-session-chg " + tone}>{chg > 0 ? "▲" : chg < 0 ? "▼" : ""} {fmtSigned(chg)} ({fmtSignedPct((chg / s.open) * 100)}) since open</div>
      </div>
      <div className="m-range" role="img" aria-label={pos == null ? "No range yet this session" : `Price is ${pos.toFixed(0)} percent of the way from the session low to the session high`}>
        <div className="m-range-track">
          {pos != null && <div className="m-range-marker" style={{ left: `${pos}%`, borderColor: color }} />}
        </div>
        <div className="m-range-ends">
          <span><span className="m-hint">Low</span><br /><b>{fmtUsd(s.lo)}</b></span>
          <span className="m-range-mid">{pos == null ? "No range yet" : `${pos.toFixed(0)}% of the way up the range`}</span>
          <span style={{ textAlign: "right" }}><span className="m-hint">High</span><br /><b>{fmtUsd(s.hi)}</b></span>
        </div>
      </div>
      <div className="m-hint">
        Range {range > 0 ? fmtUsd(range) : DASH} · open {fmtUsd(s.open)} · session since {when(s.start)} · last tick {when(s.lastT)}
        {stale ? " (market closed or feed paused; showing the last session)" : ""}
      </div>
      <TickChart rows={s.rows} color={color} hi={s.hi} lo={s.lo} fmt={(v) => "$" + v.toFixed(2)} height={140} />
    </div>
  );
}
