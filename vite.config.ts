import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/nvidia": {
        target: "https://integrate.api.nvidia.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/nvidia/, ""),
      },
      "/api/tavily": {
        target: "https://api.tavily.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/tavily/, ""),
      },
      "/api/vault": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/api/exec": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/api/obsidian": {
        target: "http://127.0.0.1:27123",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/obsidian/, ""),
      },
    },
  },
});
