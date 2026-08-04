import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // 純核心。不碰平台，毫秒級。
        test: { name: "core", include: ["test/**/*.test.ts"] }
      },
      {
        // 跑在真的 workerd 裡，用來驗那些只有平台才會發生的事。
        plugins: [
          cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })
        ],
        test: { name: "workers", include: ["test-workers/**/*.test.ts"] }
      }
    ]
  }
});
