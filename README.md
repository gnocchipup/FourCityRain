# Rain Radar Matrix 🌧️

A 7-day **hourly rain forecast matrix** for four cities side by side, built with
React + Vite + Tailwind CSS. Forecast data comes from the free, key-less
[Open-Meteo](https://open-meteo.com/) API, city lookup from the Open-Meteo
geocoding API.

## Features

- Hourly precipitation **probability (%)** or **volume (mm)** heatmaps per city
- 7-day totals per city and per day column
- Swap any city via geocoding search
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

## Project structure

```
.github/workflows/deploy.yml  GitHub Pages deployment workflow
public/                       Static files copied verbatim (favicon, .nojekyll)
src/RainRadarMatrix.jsx       App component (data fetching, matrix UI)
src/main.jsx                  React entry point
src/index.css                 Tailwind import + base styles
index.html                    HTML shell
vite.config.js                Vite + React + Tailwind plugin config
```

## Notes

- No API keys, environment variables, or backend are required.
- `vite.config.js` uses a relative `base` so the same build works at a domain
  root and inside a project subpath. Override with `BASE_PATH=/repo/ npm run build`.
- Forecast requests are made directly from the browser to Open-Meteo.