import { defineConfig } from "vite";

export default defineConfig(() => ({
  clearScreen: false,
  server: { port: 1436, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
}));
