import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages などサブパスに置くときは VITE_BASE=/teppuri/ npm run build のように指定する
export default defineConfig({
  base: process.env.VITE_BASE ?? "./",
  plugins: [react()],
  // 根拠ページは ../data/DATA_SOURCES.md などをそのまま読み込む（数字を画面側で書き写さないため）
  server: { fs: { allow: [".."] } },
});
