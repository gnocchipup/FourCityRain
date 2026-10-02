import { useState, useEffect, useRef, useMemo, useCallback, useId } from "react";

const DEFAULT_CITIES = [
  { name: "Manila", region: "Metro Manila", country: "Philippines", lat: 14.5995, lon: 120.9842 },
  { name: "Beijing", region: "Beijing", country: "China", lat: 39.9042, lon: 116.4074 },
  { name: "Tokyo", region: "Tokyo", country: "Japan", lat: 35.6895, lon: 139.6917 },
  { name: "London", region: "England", country: "United Kingdom", lat: 51.5085, lon: -0.1257 },
];

const GEO = "https://geocoding-api.open-meteo.com/v1/search";
const WX = "https://api.open-meteo.com/v1/forecast";
const STORAGE_KEY = "rain-radar-matrix:v1";

/* ---------- persistence ---------- */

/** A city is only usable if it has a name and in-range coordinates. */
function isValidCity(c) {
  return (
    c &&
    typeof c.name === "string" &&
    Number.isFinite(c.lat) &&
    Number.isFinite(c.lon) &&
    c.lat >= -90 &&
    c.lat <= 90 &&
    c.lon >= -180 &&
    c.lon <= 180
  );
}

/**
 * Read saved state from localStorage. Private-browsing modes and blocked
 * storage can throw on access, and the stored JSON may be stale or hand-edited,
 * so every failure path falls back to the defaults.
 */
function loadState() {
  const fallback = { cities: DEFAULT_CITIES };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw);
    // A `mode` key saved by older versions is simply ignored now that the
    // chart always shows both metrics.
    const cities = Array.isArray(saved?.cities)
      ? saved.cities.filter(isValidCity).slice(0, 4)
      : [];
    return { cities: cities.length ? cities : DEFAULT_CITIES };
  } catch {
    return fallback;
  }
}

function saveState(cities) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ cities }));
  } catch {
    /* quota exceeded or storage disabled — non-fatal, state just won't persist */
  }
}

/* ---------- helpers ---------- */

function dayLabel(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
    .replace(",", "");
}

function parseForecast(hourly) {
  const byDay = new Map();
  hourly.time.forEach((t, i) => {
    const [date, time] = t.split("T");
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push({
      time,
      label: dayLabel(date),
      prob: hourly.precipitation_probability?.[i] ?? 0,
      mm: hourly.precipitation?.[i] ?? 0,
    });
  });
  return [...byDay.entries()].slice(0, 7).map(([date, hours]) => ({
    date,
    label: dayLabel(date),
    hours,
    total: hours.reduce((s, h) => s + h.mm, 0),
  }));
}

/** Bar colour buckets by mm volume — bars always use the right-hand mm axis. */
function barColor(h) {
  const v = h.mm;
  if (v <= 0) return "bg-slate-200 dark:bg-slate-800";
  return v < 0.5 ? "bg-sky-300" : v <= 2.5 ? "bg-blue-500" : "bg-indigo-600";
}

function barHeight(h, scaleTop) {
  const pct = (h.mm / scaleTop) * 100;
  return Math.max(Math.min(pct, 100), 4); // keep a faint baseline tick for zero values
}

/**
 * Pick a "nice" axis maximum + tick list (1 / 2 / 2.5 / 5 x 10^n steps) so the
 * y-axis labels land on readable numbers instead of arbitrary values. The top
 * is always exactly `divisions` steps, so the mm ticks land on the SAME five
 * gridlines as the fixed 0–100% probability axis (both charts are dual-axis).
 */
function niceScale(maxValue, divisions = 4) {
  const raw = Math.max(maxValue, divisions) / divisions;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const top = step * divisions;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toFixed(2)));
  return { top, ticks };
}

function formatTick(v, mode) {
  if (mode === "pct") return `${v}%`;
  return v % 1 === 0 ? `${v}mm` : `${v.toFixed(1)}mm`;
}

function hourLabel(time) {
  return String(Number(String(time).slice(0, 2)));
}

/** The probability curve always uses this fixed left-hand scale (0–100%). */
const PCT_SCALE = { top: 100, ticks: [0, 25, 50, 75, 100] };

/**
 * Catmull-Rom spline through the points, emitted as cubic beziers, so the
 * hourly probability curve flows instead of zig-zagging between samples.
 * Coordinates are in the plot's 0–1000 × 0–100 viewBox space.
 */
function smoothPath(pts) {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`;
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`;
  }
  return d;
}

/* ---------- city search ---------- */

function CitySearch({ onPick }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ status: "idle", results: [] });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setState({ status: "idle", results: [] });
      return;
    }
    const ctrl = new AbortController();
    setState((s) => ({ ...s, status: "loading" }));
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${GEO}?name=${encodeURIComponent(term)}&count=5&language=en&format=json`, {
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error("Geocoding failed");
        const json = await res.json();
        setState({ status: "done", results: json.results || [] });
      } catch (e) {
        if (e.name !== "AbortError") setState({ status: "error", results: [] });
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, attempt]);

  const pick = (r) => {
    onPick({ name: r.name, region: r.admin1 || "", country: r.country || "", lat: r.latitude, lon: r.longitude });
    setQ("");
    setOpen(false);
  };

  return (
    <div className="relative w-full sm:w-44">
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Swap city…"
        aria-label="Search for a city"
        className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
      />
      {open && q.trim().length >= 2 && (
        <div className="absolute right-0 z-30 mt-1 w-64 overflow-hidden rounded-md border border-slate-200 bg-white text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {state.status === "loading" && <div className="px-3 py-2 text-slate-500">Searching…</div>}
          {state.status === "error" && (
            <div className="flex items-center justify-between px-3 py-2 text-rose-600 dark:text-rose-400">
              <span>Search failed.</span>
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  setAttempt((n) => n + 1);
                }}
                className="font-medium underline"
              >
                Retry
              </button>
            </div>
          )}
          {state.status === "done" && state.results.length === 0 && (
            <div className="px-3 py-2 text-slate-500">No cities match “{q.trim()}”. Check the spelling or try a nearby city.</div>
          )}
          {state.status === "done" &&
            state.results.map((r) => (
              <button
                key={r.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(r);
                }}
                className="block w-full px-3 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <span className="font-medium text-slate-800 dark:text-slate-100">{r.name}</span>
                <span className="text-slate-500">
                  {" "}
                  {[r.admin1, r.country].filter(Boolean).join(", ")}
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/* ---------- city card ---------- */

/** Stable identity for a city, used to track its contribution to the shared scale. */
function cityKey(city) {
  return `${city.lat.toFixed(4)},${city.lon.toFixed(4)}`;
}

function CityCard({ city, onCityChange, refreshKey, sharedMaxMm, onMaxMm }) {
  const [data, setData] = useState({ status: "loading", days: [] });
  const [retry, setRetry] = useState(0);
  const [tip, setTip] = useState(null);
  // Date string of the single day being zoomed into, or null for the full 7-day view.
  const [focusedDay, setFocusedDay] = useState(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setData((d) => ({ ...d, status: "loading" }));
    (async () => {
      try {
        const url = `${WX}?latitude=${city.lat}&longitude=${city.lon}&hourly=precipitation_probability,precipitation&timezone=auto`;
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`Weather API returned ${res.status}`);
        const json = await res.json();
        if (!json.hourly?.time?.length) throw new Error("No hourly data returned");
        setData({ status: "ready", days: parseForecast(json.hourly) });
      } catch (e) {
        if (e.name !== "AbortError") setData({ status: "error", days: [], message: e.message });
      }
    })();
    return () => ctrl.abort();
  }, [city, refreshKey, retry]);

  // Clear the zoom when the city (and therefore its forecast dates) changes, or
  // when a refresh no longer returns the day that was selected.
  useEffect(() => {
    setFocusedDay((d) => (d && data.days.some((day) => day.date === d) ? d : null));
  }, [data.days]);

  // The three rows below (day headers, bars, hour marks) all render from this:
  // every day in the 7-day view, or just the clicked day when zoomed in.
  const visibleDays = useMemo(
    () => (focusedDay ? data.days.filter((d) => d.date === focusedDay) : data.days),
    [data.days, focusedDay]
  );

  const { total, maxMm } = useMemo(() => {
    const all = data.days.flatMap((d) => d.hours);
    return {
      total: all.reduce((s, h) => s + h.mm, 0),
      maxMm: Math.max(2, ...all.map((h) => h.mm)),
    };
  }, [data.days]);

  // Report this card's wettest hour upward so every card can share one mm scale.
  // No dependency on sharedMaxMm/onMaxMm to avoid a report -> re-render -> report loop.
  useEffect(() => {
    onMaxMm(maxMm);
  }, [maxMm]); // eslint-disable-line react-hooks/exhaustive-deps

  // Right-hand mm axis: the wettest hour across ALL cities so cards stay
  // directly comparable. The left-hand axis is the fixed PCT_SCALE above; both
  // produce five ticks so they share one set of gridlines.
  const mmScale = useMemo(() => niceScale(sharedMaxMm), [sharedMaxMm]);

  // Probability curve, in the plot's 0–1000 × 0–100 viewBox. x is each hour's
  // centre within its day column, so every point sits directly over its bar.
  const { linePath, areaPath } = useMemo(() => {
    const pts = [];
    visibleDays.forEach((day, d) => {
      const hours = day.hours.length || 1;
      day.hours.forEach((h, j) => {
        pts.push({
          x: ((d + (j + 0.5) / hours) / visibleDays.length) * 1000,
          y: 100 - Math.max(0, Math.min(100, h.prob ?? 0)),
        });
      });
    });
    const line = smoothPath(pts);
    const area = pts.length ? `${line} L${pts[pts.length - 1].x},100 L${pts[0].x},100 Z` : "";
    return { linePath: line, areaPath: area };
  }, [visibleDays]);

  // One gradient id per card (React 18 useId, stripped of url()-unfriendly chars).
  const areaFillId = `probFill${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  const showTip = (e, h) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 90), window.innerWidth - 90);
    setTip({ x, y: r.top, h });
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold leading-tight text-slate-900 dark:text-slate-50">
            <button
              type="button"
              onClick={() => setFocusedDay(null)}
              disabled={!focusedDay}
              title={focusedDay ? "Back to the full 7-day view" : undefined}
              className={`max-w-full truncate rounded text-left focus:outline-none focus:ring-2 focus:ring-indigo-400 ${
                focusedDay
                  ? "cursor-pointer underline decoration-dotted decoration-slate-400 underline-offset-4 hover:text-indigo-600 dark:hover:text-indigo-400"
                  : "cursor-default"
              }`}
            >
              {city.name}
            </button>
          </h2>
          <p className="truncate text-xs text-slate-500">{[city.region, city.country].filter(Boolean).join(", ")}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-lg font-semibold tabular-nums leading-tight text-indigo-600 dark:text-indigo-400">
              {data.status === "ready" ? total.toFixed(1) : "–"}
              <span className="ml-0.5 text-xs font-normal text-slate-500">mm</span>
            </div>
            <div className="text-xs text-slate-500">7-day total</div>
          </div>
          <CitySearch onPick={onCityChange} />
        </div>
      </header>

      {data.status === "ready" && focusedDay && (
        <p className="-mt-1 mb-2 text-xs text-slate-500">
          Zoomed to one day · click <span className="font-medium text-slate-600 dark:text-slate-300">{city.name}</span> above to see all 7 days
        </p>
      )}

      {data.status === "loading" && (
        <div className="flex" aria-busy="true" aria-label="Loading forecast">
          <div className="mr-2 w-12 shrink-0" />
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="min-w-0 flex-1">
              <div className="mb-1 h-6 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
              <div className="h-44 animate-pulse rounded bg-slate-100 dark:bg-slate-800/60" />
            </div>
          ))}
          <div className="ml-2 w-12 shrink-0" />
        </div>
      )}

      {data.status === "error" && (
        <div className="flex h-36 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-rose-300 text-center text-xs text-rose-600 dark:border-rose-900 dark:text-rose-400">
          <p>Couldn’t load the forecast for {city.name}. {data.message}</p>
          <button
            onClick={() => setRetry((n) => n + 1)}
            className="rounded-md bg-rose-600 px-3 py-1 font-medium text-white hover:bg-rose-700"
          >
            Retry
          </button>
        </div>
      )}

      {data.status === "ready" && (
        <div onMouseLeave={() => setTip(null)}>
          <div className="w-full">
            {/* Day header row — columns are contiguous so they line up with the plot */}
            <div className="flex">
              <div className="mr-2 w-12 shrink-0" />
              {visibleDays.map((day, i) => (
                <button
                  key={day.date}
                  type="button"
                  onClick={() => setFocusedDay((cur) => (cur === day.date ? null : day.date))}
                  aria-pressed={focusedDay === day.date}
                  title={focusedDay === day.date ? "Show all 7 days" : `Zoom in on ${day.label}`}
                  className={`min-w-0 flex-1 cursor-pointer rounded-md px-1 py-0.5 text-center leading-tight transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400 ${
                    i > 0 ? "border-l border-dashed border-slate-200 dark:border-slate-800" : ""
                  } ${
                    focusedDay === day.date
                      ? "bg-indigo-50 ring-1 ring-indigo-200 dark:bg-indigo-500/10 dark:ring-indigo-500/40"
                      : "hover:bg-slate-100 dark:hover:bg-slate-800"
                  }`}
                >
                  <div className="truncate text-xs font-medium text-slate-700 dark:text-slate-200">{day.label}</div>
                  <div className="text-xs tabular-nums text-slate-400">{day.total.toFixed(1)} mm</div>
                </button>
              ))}
              <div className="ml-2 w-12 shrink-0" />
            </div>

            {/* Chart row: left % axis, shared plot, right mm axis */}
            <div className="mt-1 flex">
              {/* Left axis — labels absolutely positioned so they line up exactly
                  with the gridlines (highest value at the top). */}
              <div className="relative mr-2 h-44 w-12 shrink-0">
                {PCT_SCALE.ticks.map((t) => (
                  <span
                    key={t}
                    className="absolute right-0 -translate-y-1/2 text-[10px] font-medium tabular-nums text-slate-400 dark:text-slate-500"
                    style={{ bottom: `${(t / PCT_SCALE.top) * 100}%` }}
                  >
                    {formatTick(t, "pct")}
                  </span>
                ))}
              </div>

              <div className="relative h-44 min-w-0 flex-1 rounded bg-slate-50 dark:bg-slate-950/50">
                {/* Gridlines double as day dividers; both axes land on them. */}
                <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                  {PCT_SCALE.ticks.map((t) => (
                    <div
                      key={t}
                      className="absolute inset-x-0 border-t border-dashed border-slate-200 dark:border-slate-800"
                      style={{ bottom: `${(t / PCT_SCALE.top) * 100}%` }}
                    />
                  ))}
                  {visibleDays.map((day, i) =>
                    i === 0 ? null : (
                      <div
                        key={day.date}
                        className="absolute inset-y-0 border-l border-dashed border-slate-200 dark:border-slate-800"
                        style={{ left: `${(i / visibleDays.length) * 100}%` }}
                      />
                    )
                  )}
                </div>

                {/* Smooth chance-of-rain curve with its gradient fill underneath */}
                <svg
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  viewBox="0 0 1000 100"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <defs>
                    <linearGradient id={areaFillId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6366f1" stopOpacity="0.45" />
                      <stop offset="100%" stopColor="#6366f1" stopOpacity="0.05" />
                    </linearGradient>
                  </defs>
                  <path d={areaPath} fill={`url(#${areaFillId})`} />
                  <path
                    d={linePath}
                    fill="none"
                    stroke="#4f46e5"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>

                {/* mm volume columns, overlaid on the curve (slightly translucent
                    so the line stays readable underneath them) */}
                <div className="absolute inset-0 flex items-end">
                  {visibleDays.map((day) => (
                    <div key={day.date} className="flex h-full min-w-0 flex-1 items-end gap-px">
                      {day.hours.map((h) => (
                        <div
                          key={h.time}
                          onMouseEnter={(e) => showTip(e, h)}
                          className="flex h-full flex-1 items-end"
                        >
                          <div
                            className={`w-full rounded-sm opacity-70 ${barColor(h)}`}
                            style={{ height: `${barHeight(h, mmScale.top)}%` }}
                          />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              {/* Right axis: mm volume, sharing the same five gridlines */}
              <div className="relative ml-2 h-44 w-12 shrink-0">
                {mmScale.ticks.map((t) => (
                  <span
                    key={t}
                    className="absolute left-0 -translate-y-1/2 text-[10px] font-medium tabular-nums text-slate-400 dark:text-slate-500"
                    style={{ bottom: `${(t / mmScale.top) * 100}%` }}
                  >
                    {formatTick(t, "mm")}
                  </span>
                ))}
              </div>
            </div>

            {/* 6-hour markers: 06, 12, 18 (midnight is omitted as it reads as "0") */}
            <div className="mt-1 flex">
              <div className="mr-2 w-12 shrink-0" />
              {visibleDays.map((day) => (
                <div key={day.date} className="flex h-4 min-w-0 flex-1 gap-px">
                  {day.hours.map((h) => {
                    const hh = Number(h.time.slice(0, 2));
                    const mark = hh !== 0 && hh % 6 === 0;
                    return (
                      <div key={h.time} className="relative flex-1">
                        {mark && (
                          <>
                            <span className="absolute left-0 top-0 h-1.5 border-l border-slate-300 dark:border-slate-600" />
                            <span className="absolute left-0 top-1.5 text-[9px] tabular-nums text-slate-400 dark:text-slate-500">
                              {hourLabel(h.time)}
                            </span>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
              <div className="ml-2 w-12 shrink-0" />
            </div>
          </div>
        </div>
      )}

      {/* All cards share one mm scale, so say so once per card rather than implying it's local */}
      {data.status === "ready" && (
        <p className="mt-1 text-right text-xs text-slate-400">
          Left axis 0–100% chance · bars share 0–{mmScale.top} mm per hour across all cities
        </p>
      )}

      {tip && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-md bg-slate-900 px-2.5 py-1.5 text-xs text-white shadow-lg ring-1 ring-slate-700"
          style={{ left: tip.x, top: tip.y - 6 }}
        >
          <div className="font-medium">{tip.h.label} at {tip.h.time}</div>
          <div className="text-slate-300">Precip Chance: {tip.h.prob}%</div>
          <div className="text-slate-300">Precip Volume: {tip.h.mm.toFixed(1)} mm</div>
        </div>
      )}
    </section>
  );
}

/* ---------- cloud logo ---------- */

/**
 * Decorative cloud with falling raindrops. The drops animate with staggered
 * delays so they don't all fall in lockstep. Purely presentational, so it is
 * hidden from assistive tech and motion is disabled for reduced-motion users.
 */
function CloudRainIcon({ className = "h-9 w-9" }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="cloudBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f8fafc" />
          <stop offset="100%" stopColor="#cbd5e1" />
        </linearGradient>
      </defs>

      {/* cloud */}
      <g fill="url(#cloudBody)" stroke="#94a3b8" strokeWidth="1.5">
        <circle cx="24" cy="26" r="10" />
        <circle cx="38" cy="24" r="12" />
        <circle cx="48" cy="30" r="8" />
        <rect x="18" y="28" width="30" height="10" rx="5" />
      </g>

      {/* raindrops */}
      <g stroke="#4f46e5" strokeWidth="3.5" strokeLinecap="round">
        <line className="drop-1" x1="24" y1="44" x2="21" y2="53" />
        <line className="drop-2" x1="33" y1="44" x2="30" y2="53" />
        <line className="drop-3" x1="42" y1="44" x2="39" y2="53" />
      </g>
    </svg>
  );
}

/* ---------- app ---------- */

export default function RainRadarMatrix() {
  // Lazy initialiser so localStorage is read once on mount, not on every render.
  const [state, setState] = useState(loadState);
  const cities = state.cities;
  const [refreshKey, setRefreshKey] = useState(0);

  // Wettest hourly mm per card, keyed by city so that swapping a city drops its
  // old entry out of the shared scale instead of leaving a stale high value.
  const [peakMm, setPeakMm] = useState({});

  const reportMax = useCallback((key, mm) => {
    setPeakMm((prev) => (prev[key] === mm ? prev : { ...prev, [key]: mm }));
  }, []);

  const sharedMaxMm = Math.max(2, ...Object.values(peakMm));

  // Drop entries for cities that are no longer on screen, so a swapped-out
  // city can't keep inflating the shared scale.
  useEffect(() => {
    const live = new Set(cities.map(cityKey));
    setPeakMm((prev) => {
      const next = {};
      let changed = false;
      for (const [k, v] of Object.entries(prev)) {
        if (live.has(k)) next[k] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [cities]);

  const swap = (i, c) =>
    setState((s) => ({ ...s, cities: s.cities.map((p, idx) => (idx === i ? c : p)) }));

  const reset = () => {
    setState({ cities: DEFAULT_CITIES });
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  // Persist after every change. Writing in an effect (rather than inside the
  // setters) keeps one code path for every state transition.
  useEffect(() => {
    saveState(state.cities);
  }, [state]);

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800 dark:bg-slate-950 dark:text-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <CloudRainIcon className="h-9 w-9 shrink-0" />
            <div>
              <h1 className="text-lg font-semibold leading-tight tracking-tight">
                Four City Rain Forecast
              </h1>
              <p className="text-xs text-slate-500">7-day hourly rain forecast · Open-Meteo</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => setRefreshKey((n) => n + 1)}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            >
              Refresh all
            </button>
            <button
              onClick={reset}
              title="Restore the default four cities and clear saved choices"
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-400 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Reset
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1800px] p-4">
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
          <span className="font-medium text-slate-600 dark:text-slate-300">
            One dual-axis chart per city
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded-full bg-indigo-600" />
            Chance of rain 0–100% (left)
          </span>
          <span className="text-slate-400">Bars — hourly volume, mm (right):</span>
          {[
            ["bg-slate-200 dark:bg-slate-800", "0 mm"],
            ["bg-sky-300", "< 0.5 mm"],
            ["bg-blue-500", "0.5–2.5 mm"],
            ["bg-indigo-600", "> 2.5 mm"],
          ].map(([c, l]) => (
            <span key={l} className="inline-flex items-center gap-1.5">
              <span className={`inline-block h-2.5 w-2.5 rounded-sm ${c}`} />
              {l}
            </span>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {cities.map((city, i) => (
            <CityCard
              key={i}
              city={city}
              refreshKey={refreshKey}
              sharedMaxMm={sharedMaxMm}
              onMaxMm={(mm) => reportMax(cityKey(city), mm)}
              onCityChange={(c) => swap(i, c)}
            />
          ))}
        </div>
      </main>
    </div>
  );
}
