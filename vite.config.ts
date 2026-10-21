import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import electron from "vite-plugin-electron";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const mainProcessEnv = Object.fromEntries([
    "KETCHUPE_OTLP_ENDPOINT",
    "KETCHUPE_OTLP_TOKEN",
    "KETCHUPE_TELEMETRY_CONTENT_MODE",
    "KETCHUPE_ENVIRONMENT",
    "KETCHUPE_TENANT_ID",
    "KETCHUPE_VARIANT",
    "LITELLM_BASE_URL",
    "LITELLM_API_KEY",
    "LITELLM_MODEL_ALIAS",
    "LITELLM_ROUTER_MODEL_ALIAS",
  ].map((key) => [`process.env.${key}`, JSON.stringify(env[key] ?? "")]));
  return {
    plugins: [
      react(),
      tsconfigPaths(),
      electron([
      {
        // Main process entry file
        entry: "electron/main.ts",
        vite: {
          define: mainProcessEnv,
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: ["electron", "electron-updater", "node:sqlite", "kordoc", "@huggingface/transformers", "exceljs", "sharp"],
            },
          },
        },
      },
      {
        // Tomato utility process: parse/OCR/embedding/search off the main event loop
        entry: "electron/workers/tomato.worker.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: ["electron", "node:sqlite", "kordoc", "@huggingface/transformers"],
              output: { format: "es" },
            },
          },
        },
      },
      {
        entry: "electron/workers/workbook.worker.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: { external: ["electron", "exceljs", "sharp"], output: { format: "es" } },
          },
        },
      },
      {
        entry: "electron/workers/business.worker.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: { external: ["electron", "exceljs", "sharp"], output: { format: "es" } },
          },
        },
      },
      {
        // Preload scripts - use plain JS to avoid ESM issues
        entry: "electron/preload.js",
        onstart(options) {
          // Notify the Renderer-Process to reload the page when the Preload-Scripts build is complete
          options.reload();
        },
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: ["electron"],
              output: {
                format: "cjs",
              },
            },
          },
        },
      },
      ]),
    ],
    build: {
      outDir: "dist",
      // 구형 WebKit(회사 모바일앱 인앱 웹뷰 등) 호환을 위해 빌드 타깃을 낮춤
      target: ["es2019", "safari13"],
    },
  };
});
