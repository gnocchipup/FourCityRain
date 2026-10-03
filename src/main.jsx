import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import RainRadarMatrix from "./RainRadarMatrix.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <RainRadarMatrix />
  </StrictMode>
);

/* Register the service worker so the app is installable and opens offline.
   Registration is scoped relative to the built page, which keeps it working
   both at a domain root and inside a project subpath (GitHub Pages). */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js", { scope: "./" })
      .then((registration) => {
        /* Apply a waiting update on the next natural page load. */
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              worker.postMessage("SKIP_WAITING");
            }
          });
        });
      })
      .catch((error) => {
        /* Non-fatal: the app works fine without offline support. */
        console.warn("Service worker registration failed:", error);
      });
  });
}