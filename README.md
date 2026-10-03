# Four City Rain Forecast 🌧️

A 7-day **hourly rain forecast matrix** for four cities side by side, built with
React + Vite + Tailwind CSS. Forecast data comes from the free, key-less
[Open-Meteo](https://open-meteo.com/) API, city lookup from the Open-Meteo
geocoding API.

## Features

- One **dual-axis chart** per city: a smooth **chance-of-rain curve** with a
  gradient fill (0–100%, left axis) plus **hourly mm volume columns** overlaid
  on the same plot (right axis)
- All cards share **one mm column scale** (set by the wettest city), so bar
  heights are directly comparable across cities
- 7-day totals per city and per day column
- **Opens on a single day.** Swipe a chart left/right (or press ← / →, or use the
  ‹ › buttons) to step through the other days — all four cards move together
- Click the day header to return to the full 7-day view; click a day in the
  7-day view to zoom straight into it, and click the city name to go back
- **Auto refreshes on open** and whenever the app is brought back to the
  foreground (reopened PWA, unlocked screen, tab restored from bfcache). Existing
  charts stay on screen while the refresh runs in the background
- Swap any city via geocoding search
- Your chosen cities are remembered in `localStorage`
  (use **Reset** in the header to restore the defaults)
- Light/dark theme (follows `prefers-color-scheme`)
- Loading, empty, and error states with retry
- Fully static build — deploys to GitHub Pages with zero server cost

## Local development

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # -> dist/
npm run preview  # serve the production build locally
```

> On Windows PowerShell, if script execution is disabled, use `npm.cmd` instead
> of `npm` (e.g. `npm.cmd install`).

## Deploying to GitHub Pages

Deployment is automated by `.github/workflows/deploy.yml`: every push to
`main` builds the app and publishes `dist/` to GitHub Pages.

One-time setup in the repository:

1. **Settings → Pages → Build and deployment → Source: _GitHub Actions_**
2. Push to `main` (or run the workflow manually via _Actions → Deploy to GitHub
   Pages → Run workflow_).

Your site will be live at `https://<user>.github.io/FourCityRain/`.
`public/.nojekyll` is included so GitHub Pages serves the assets as-is instead
of running them through Jekyll.

## PWA

The app is installable on Android and desktop. Android Chrome requires HTTPS
(or `localhost`), so the install prompt will not appear over plain HTTP on a
LAN address.

| File | Purpose |
| --- | --- |
| `public/manifest.json` | App name, `standalone` display, theme colour, icons |
| `public/sw.js` | App-shell caching + offline fallback |
| `public/icons/*.png` | 192/512 icons, plus maskable and Apple variants |
| `src/main.jsx` | Registers the worker on page load |

Caching strategy:

- **Navigations** — network-first, falling back to the cached shell so the app
  still opens offline.
- **Static assets** — stale-while-revalidate, so repeat loads are instant.
- **Open-Meteo requests** — never intercepted or cached. The worker returns
  early on any cross-origin request, so forecast data is always live.

When you change anything cached by the worker, bump `VERSION` in `public/sw.js`
so returning clients pick up the new build; old caches are deleted on activate.

Useful scripts:

```bash
npm run icons    # regenerate public/icons/*.png from the favicon geometry
npm run test:sw  # exercise the sw.js handlers in Node (10 assertions)
```

## Project structure

```
.github/workflows/deploy.yml  GitHub Pages deployment workflow
public/                       Static files copied verbatim (favicon, manifest,
                              sw.js, icons, .nojekyll)
src/RainRadarMatrix.jsx       App component (data fetching, matrix UI)
src/main.jsx                  React entry point + service worker registration
src/index.css                 Tailwind import + base styles
tools/make-icons.mjs          Regenerates the PWA raster icons
tools/test-sw.mjs             Service worker logic tests
index.html                    HTML shell
vite.config.js                Vite + React + Tailwind plugin config
```

## Notes

- No API keys, environment variables, or backend are required.
- `vite.config.js` uses a relative `base` so the same build works at a domain
  root and inside a project subpath. Override with `BASE_PATH=/repo/ npm run build`.
- Forecast requests are made directly from the browser to Open-Meteo.