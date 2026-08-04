// 正式專案應由 `wrangler types` 產生。這裡只放最小宣告讓骨架能獨立型別檢查。
declare namespace Cloudflare {
  interface Env {
    ChatAgent: DurableObjectNamespace;
  }
}

interface Env extends Cloudflare.Env {}
