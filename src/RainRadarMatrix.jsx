import { useState, useEffect, useRef, useMemo, useCallback } from "react";

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
  const fallback = { cities: DEFAULT_CITIES, mode: "pct" };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw);
    const cities = Array.isArray(saved?.cities)
      ? saved.cities.filter(isValidCity).slice(0, 4)
      : [];
    return {
      cities: cities.length ? cities : DEFAULT_CITIES,
      mode: saved?.mode === "mm" ? "mm" : "pct",
    };
  } catch {
    return fallback;
  }
}

function saveState(cities, mode) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ cities, mode }));
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

function barColor(h, mode) {
  const v = mode === "pct" ? h.prob : h.mm;
  if (v <= 0) return "bg-slate-200 dark:bg-slate-800";
  if (mode === "pct") return v <= 30 ? "bg-sky-300" : v <= 70 ? "bg-blue-500" : "bg-indigo-600";
  return v < 0.5 ? "bg-sky-300" : v <= 2.5 ? "bg-blue-500" : "bg-indigo-600";
}

function barHeight(h, mode, scaleTop) {
  const pct = mode === "pct" ? h.prob : (h.mm / scaleTop) * 100;
  return Math.max(Math.min(pct, 100), 4); // keep a faint baseline tick for zero values
}

/**
 * Pick a "nice" axis maximum + tick list (1 / 2 / 2.5 / 5 x 10^n steps) so the
 * y-axis labels land on readable numbers instead of arbitrary values.
 */
function niceScale(maxValue, divisions = 4) {
  const raw = Math.max(maxValue, divisions) / divisions;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(maxValue / step) * step || step;
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

function CityCard({ city, onCityChange, mode, refreshKey, sharedMaxMm, onMaxMm }) {
  const [data, setData] = useState({ status: "loading", days: [] });
  const [retry, setRetry] = useState(0);
  const [tip, setTip] = useState(null);

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

  // Y-axis range + tick labels. % chance is a fixed 0–100 scale; mm uses the
  // wettest hour across ALL cities so the cards stay directly comparable.
  const scale = useMemo(
    () => (mode === "pct" ? { top: 100, ticks: [0, 25, 50, 75, 100] } : niceScale(sharedMaxMm)),
    [mode, sharedMaxMm]
  );

  const showTip = (e, h) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 90), window.innerWidth - 90);
    setTip({ x, y: r.top, h });
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold leading-tight text-slate-900 dark:text-slate-50">{city.name}</h2>
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

      {data.status === "loading" && (
        <div className="flex gap-2" aria-busy="true" aria-label="Loading forecast">
          <div className="w-12 shrink-0" />
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="min-w-0 flex-1">
              <div className="mb-1 h-6 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
              <div className="h-44 animate-pulse rounded bg-slate-100 dark:bg-slate-800/60" />
            </div>
          ))}
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
            {/* Day header row */}
            <div className="flex gap-2">
              <div className="w-12 shrink-0" />
              {data.days.map((day) => (
                <div key={day.date} className="min-w-0 flex-1 text-center leading-tight">
                  <div className="truncate text-xs font-medium text-slate-700 dark:text-slate-200">{day.label}</div>
                  <div className="text-xs tabular-nums text-slate-400">{day.total.toFixed(1)} mm</div>
                </div>
              ))}
            </div>

            {/* Chart row: y-axis + hourly bars */}
            <div className="mt-1 flex gap-2">
              {/* Y axis — labels absolutely positioned so they line up exactly
                  with the gridlines (highest value at the top). */}
              <div className="relative h-44 w-12 shrink-0">
                {scale.ticks.map((t) => (
                  <span
                    key={t}
                    className="absolute right-0 -translate-y-1/2 text-[10px] font-medium tabular-nums text-slate-400 dark:text-slate-500"
                    style={{ bottom: `${(t / scale.top) * 100}%` }}
                  >
                    {formatTick(t, mode)}
                  </span>
                ))}
              </div>

              <div className="relative flex min-w-0 flex-1 gap-2">
                <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                  {scale.ticks.map((t) => (
                    <div
                      key={t}
                      className="absolute inset-x-0 border-t border-dashed border-slate-200 dark:border-slate-800"
                      style={{ bottom: `${(t / scale.top) * 100}%` }}
                    />
                  ))}
                </div>

                {data.days.map((day) => (
                  <div
                    key={day.date}
                    className="relative flex h-44 min-w-0 flex-1 items-end gap-px rounded bg-slate-50 px-px dark:bg-slate-950/50"
                  >
                    {day.hours.map((h) => (
                      <div
                        key={h.time}
                        onMouseEnter={(e) => showTip(e, h)}
                        className="flex h-full flex-1 items-end"
                      >
                        <div
                          className={`w-full rounded-sm ${barColor(h, mode)}`}
                          style={{ height: `${barHeight(h, mode, scale.top)}%` }}
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            {/* 6-hour markers: 06, 12, 18 (midnight is omitted as it reads as "0") */}
            <div className="mt-1 flex gap-2">
              <div className="w-12 shrink-0" />
              {data.days.map((day) => (
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
            </div>
          </div>
        </div>
      )}

      {/* All cards share one scale, so say so once per card rather than implying it's local */}
      {data.status === "ready" && mode === "mm" && (
        <p className="mt-1 text-right text-xs text-slate-400">
          Shared scale: 0–{scale.top} mm per hour
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

/* ---------- app ---------- */

export default function RainRadarMatrix() {
  // Lazy initialiser so localStorage is read once on mount, not on every render.
  const [state, setState] = useState(loadState);
  const cities = state.cities;
  const mode = state.mode;
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

  const setMode = (next) => setState((s) => ({ ...s, mode: next }));

  const swap = (i, c) =>
    setState((s) => ({ ...s, cities: s.cities.map((p, idx) => (idx === i ? c : p)) }));

  const reset = () => {
    setState({ cities: DEFAULT_CITIES, mode: "pct" });
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  // Persist after every change. Writing in an effect (rather than inside the
  // setters) keeps one code path for every state transition.
  useEffect(() => {
    saveState(state.cities, state.mode);
  }, [state]);

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800 dark:bg-slate-950 dark:text-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold leading-tight tracking-tight">Rain Radar Matrix</h1>
            <p className="text-xs text-slate-500">7-day hourly rain forecast · Open-Meteo</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div role="group" aria-label="Metric" className="inline-flex rounded-lg border border-slate-300 bg-slate-100 p-0.5 text-xs font-medium dark:border-slate-700 dark:bg-slate-800">
              {[
                ["pct", "% Chance"],
                ["mm", "Precipitation (mm)"],
              ].map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => setMode(val)}
                  aria-pressed={mode === val}
                  className={`rounded-md px-3 py-1 transition-colors ${
                    mode === val
                      ? "bg-white text-indigo-600 shadow-sm dark:bg-slate-950 dark:text-indigo-400"
                      : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
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
            {mode === "pct" ? "Chance of rain" : "Hourly volume"}
          </span>
          {[
            ["bg-slate-200 dark:bg-slate-800", mode === "pct" ? "0%" : "0 mm"],
            ["bg-sky-300", mode === "pct" ? "1–30%" : "< 0.5 mm"],
            ["bg-blue-500", mode === "pct" ? "31–70%" : "0.5–2.5 mm"],
            ["bg-indigo-600", mode === "pct" ? "71–100%" : "> 2.5 mm"],
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
              mode={mode}
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
