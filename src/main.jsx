import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import RainRadarMatrix from "./RainRadarMatrix.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <RainRadarMatrix />
  </StrictMode>
);