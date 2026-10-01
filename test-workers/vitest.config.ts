// The Cloudflare pool requires Vitest 4.1; Vite+ 1 bundles Vitest 5.
// Keep the workerd runner separate until Cloudflare supports Vitest 5.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "../wrangler.jsonc" } })],
  test: { name: "workers", include: ["*.test.ts"] },
});
