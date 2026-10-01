import { defineConfig } from "vite-plus";

export default defineConfig({
  test: { name: "core", include: ["test/**/*.test.ts"] },
});
