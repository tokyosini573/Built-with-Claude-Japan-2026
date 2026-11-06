import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages などサブパスに置くときは VITE_BASE=/teppuri/ npm run build のように指定する
export default defineConfig({
  base: process.env.VITE_BASE ?? "./",
  plugins: [react()],
});
