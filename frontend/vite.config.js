import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Local `npm run dev`: forward /api to a backend on the host, mirroring
    // what nginx (Compose) and the Ingress (Kubernetes) do.
    proxy: { "/api": process.env.VITE_DEV_API_PROXY || "http://localhost:4000" },
  },
});
