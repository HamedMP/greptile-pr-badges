import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig } from "vite";

function copyStaticFiles() {
  return {
    name: "copy-static-extension-files",
    closeBundle() {
      const root = resolve(__dirname);
      const dist = join(root, "dist");
      mkdirSync(dist, { recursive: true });
      copyFileSync(join(root, "manifest.dist.json"), join(dist, "manifest.json"));
      copyFileSync(join(root, "popup.html"), join(dist, "popup.html"));

      const publicDir = join(root, "public");
      for (const file of readdirSync(publicDir)) {
        copyFileSync(join(publicDir, file), join(dist, file));
      }
    },
  };
}

export default defineConfig({
  base: "./",
  build: {
    modulePreload: false,
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        background: "src/background.ts",
        content: "src/content.ts",
        options: "src/options.ts",
        optionsPage: "options.html"
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  },
  plugins: [copyStaticFiles()]
});
