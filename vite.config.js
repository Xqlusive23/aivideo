import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

const LEDGER_ORIGIN = "http://localhost:3002";
const ADMIN_SRC = path.resolve("ledger-backend/public/admin.html");
const ADMIN_DEST = path.resolve("public/admin.html");

function copyAdminPage() {
  fs.copyFileSync(ADMIN_SRC, ADMIN_DEST);
}

function serveAdminAtSlashAdmin() {
  return {
    name: "serve-admin-at-slash-admin",
    buildStart() {
      copyAdminPage();
    },
    configureServer(server) {
      copyAdminPage();
      server.middlewares.use((req, _res, next) => {
        const pathname = String(req.url || "").split("?")[0];
        if (pathname === "/admin" || pathname === "/admin/") {
          req.url = "/admin.html";
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveAdminAtSlashAdmin()],
  base: "./",
  server: {
    proxy: {
      "/api": LEDGER_ORIGIN,
    },
  },
});
