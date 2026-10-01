import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// `base` defaults to a relative path so the built app works whether it is
// served from a domain root or from a GitHub Pages project subpath
// (https://<user>.github.io/<repo>/). Override it with BASE_PATH when needed.
export default defineConfig({
  base: process.env.BASE_PATH ?? "./",
  plugins: [react(), tailwindcss()],
});