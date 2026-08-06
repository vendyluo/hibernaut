/**
 * Runtime shell —— 對應 `Jido.AgentServer`（jido/lib/jido/agent_server.ex）。
 *
 * Jido 把「純的 agent 資料結構」跟「執行 directive 的 OTP 行程」切開。
 * 這裡切在同一個位置：`AgentDef` 是純的，`DirectiveAgent` 是唯一碰平台的地方。
 *
 * shell 應該很薄。如果你發現業務判斷跑到這裡來了，那是設計走偏了 ——
 * 判斷屬於 `cmd`，效果屬於 Action，shell 只負責把 directive 翻譯成平台呼叫。
 *
 * ## 責任邊界（這份架構的核心規則）
 *
 *   跨越單次 handler 的東西 → Cloudflare（`setState` / `sql` / `schedule`）
 *   單次 handler 內部的東西 → Effect（`runAction` 的 timeout / retry / Layer）
 *
 * Effect 也有自己的 durable execution 路線（Effect Cluster、`@effect/workflow`）。
 * 不要用。這個專案裡持久性只有一個擁有者，就是 Cloudflare。
 */
import { Agent } from "agents";
import { Cause, Either, Exit, Layer, ManagedRuntime, Schema } from "effect";
import {
  ActionError,
  runAction,
  type Action,
  type ActionRegistry,
  type AnyAction
} from "../core/action.js";
import type { AgentDef, TaggedAction } from "../core/agent.js";
import type { Directive, Outcome, RunInstruction } from "../core/directive.js";

export abstract class DirectiveAgent<
  Env extends Cloudflare.Env,
  S,
  A extends TaggedAction,
  R = never
> extends Agent<Env, S> {
  protected abstract readonly def: AgentDef<S, A>;
  protected abstract readonly actions: ActionRegistry<R>;

  /**
   * Action 需要的服務。**每次 DO 醒來都會重新呼叫**，所以這裡面不准有任何
   * 「假設自己一直活著」的狀態：不要放 in-memory cache、不要放連線池、
   * 不要放計數器。當成每次都是冷啟動來寫。
   */
  protected abstract layer(): Layer.Layer<R>;

  #runtime: ManagedRuntime.ManagedRuntime<R, never> | undefined;

  /** 非 null 表示持久狀態不符 schema，agent 已隔離、拒絕服務。 */
  #quarantine: string | null = null;

  /**
   * ManagedRuntime 建一次並重用，避免每個請求重建 Layer。
   *
   * 但它是**快取，不是真相**：hibernation 之後 `#runtime` 是 undefined，
   * 這裡會靜靜地重建。任何存在這裡面的東西都必須是可以重建的。
   */
  protected get runtime(): ManagedRuntime.ManagedRuntime<R, never> {
    this.#runtime ??= ManagedRuntime.make(this.layer());
    return this.#runtime;
  }

  get quarantined(): string | null {
    return this.#quarantine;
  }

  #initialized = false;
  #initialization: Promise<void> | undefined;

  /**
   * 每次 Durable Object 醒來都會跑 —— 這就是 OTP 的 `init/1`。
   *
   * 判準跟寫 GenServer 時一模一樣：**如果我現在被 kill，這個函式能不能把我
   * 完整重建回來？** 在 DO 上這件事每 70–140 秒就發生一次，只是沒人通知你。
   */
  override async onStart(): Promise<void> {
    await this.initializeOnce();
  }

  /**
   * 醒來要做的三件事，順序不能換：
   *   1. 驗證持久狀態（信任邊界）—— 不合 schema 就隔離，不服務
   *   2. 子類的額外重建
   *   3. 自我修復（補回可能沒寫成功的排程）
   *
   * **為什麼不只掛在 `onStart()` 上。** partyserver 的 `onStart()` 是由
   * `#ensureInitialized()` 觸發的，而那只發生在 SDK 的真實入口
   * （`fetch` / `alarm` / `webSocketMessage`）。任何繞過那些入口直接呼叫方法的
   * 路徑 —— RPC、facet、測試工具 —— 都不會跑到它。
   *
   * 不變式不能依賴「呼叫方走了哪條路進來」。所以驗證與修復放在這裡，
   * 由 `onStart()` 與所有公開入口共同保證，共享 Promise 讓並行呼叫等待同一輪。
   */
  private async initializeOnce(): Promise<void> {
    if (this.#initialized) return;

    if (this.#initialization !== undefined) {
      await this.#initialization;
      return;
    }

    // 先把 single-flight Promise 放好，再開始執行；同步重入也只能看見同一輪初始化。
    const initialization = Promise.resolve().then(() => this.initialize());
    this.#initialization = initialization;

    try {
      await initialization;
      this.#initialized = true;
    } finally {
      this.#initialization = undefined;
    }
  }

  private async initialize(): Promise<void> {
    const decoded = Schema.decodeUnknownEither(this.def.state)(this.state);
    if (Either.isLeft(decoded)) {
      // 刻意**不**重置狀態：原始資料原封不動留在 SQLite 供人工判讀。
      // 壞掉的狀態要怎麼處理是資料契約決策，不該由 runtime 默默決定。
      this.#quarantine = decoded.left.message;
      this.onFail(
        "persisted state failed schema validation; agent quarantined",
        decoded.left.message
      );
      return;
    }

    this.#quarantine = null;
    await this.onWake();
    await this.reconcileValidatedState();
  }

  /** 子類要做額外的醒來重建就覆寫這個；不可從這裡呼叫公開 dispatch/reconcileNow。 */
  protected async onWake(): Promise<void> {}

  /**
   * 自我修復。`Date.now()` 只在這種邊界出現 —— `cmd` 與 `reconcile` 都拿不到時鐘。
   */
  async reconcileNow(): Promise<void> {
    await this.initializeOnce();
    if (this.#quarantine !== null) return;
    await this.reconcileValidatedState();
  }

  private async reconcileValidatedState(): Promise<void> {
    const repair = this.def.reconcile?.(this.state, Date.now());
    if (repair !== null && repair !== undefined) await this.dispatchInitialized(repair);
  }

  // -------------------------------------------------------------------------
  // 唯一入口
  // -------------------------------------------------------------------------

  /**
   * 每一個外界輸入都走這裡：HTTP、WebSocket 訊息、排程回呼、instruction 結果。
   *
   * 順序是有意義的，不要改：
   *
   *   1. 先算出完整新狀態並寫下去（`setState` 同步寫進 DO 儲存）
   *   2. 再送出外部效果
   *
   * 反過來（先做效果再存狀態）會在中間被驅逐時遺失狀態，而且你無從得知效果
   * 到底做了沒有。
   *
   * **但這兩步不在同一個交易裡。** 狀態走 `setState`、排程走 `this.schedule()`，
   * 是兩次可獨立失敗的寫入；DO 只給同步的 `transactionSync()`，跨不過 `await`，
   * 所以這個窗口在平台層面關不起來。修補的方式是 `reconcile`：把「我應該有一個
   * 守衛、期限是 T」寫進狀態本身，醒來時只看狀態就能把缺的排程補回來。
   */
  async dispatch(action: A): Promise<void> {
    await this.initializeOnce();

    if (this.#quarantine !== null) {
      this.onEmit("quarantined", { reason: this.#quarantine });
      return;
    }

    await this.dispatchInitialized(action);
  }

  private async dispatchInitialized(action: A): Promise<void> {
    const { state, directives } = this.def.cmd(this.state, action);
    this.setState(state);
    await this.applyDirectives(directives);
  }

  /**
   * directive 的執行順序：
   *
   *   先排程（把守衛變持久） → 再對外送訊息 → 最後才做有風險的呼叫 → Stop 收尾
   *
   * 關鍵是 `RunInstruction` 排在 `ScheduleAction` 後面。逾時守衛必須在那通
   * 可能永遠不回來的呼叫**開始之前**就已經寫進 SQLite。
   */
  private async applyDirectives(
    directives: ReadonlyArray<Directive<A>>
  ): Promise<void> {
    const order = (d: Directive<A>): number =>
      d._tag === "ScheduleAction"
        ? 0
        : d._tag === "Emit" || d._tag === "Fail"
          ? 1
          : d._tag === "RunInstruction"
            ? 2
            : 3;

    for (const directive of [...directives].sort((a, b) => order(a) - order(b))) {
      if (!(await this.applyDirective(directive))) return;
    }
  }

  /** 回傳 `false` 表示這批 directive 已由 fallback 終結，不得再執行後續效果。 */
  private async applyDirective(directive: Directive<A>): Promise<boolean> {
    switch (directive._tag) {
      case "ScheduleAction":
        return await this.armGuard(directive.delaySeconds, directive.action);

      case "Emit":
        this.onEmit(directive.event, directive.payload);
        return true;

      case "RunInstruction":
        await this.executeInstruction(directive);
        return true;

      case "Fail":
        this.onFail(directive.reason, directive.detail);
        return true;

      case "Stop":
        await this.onStopRequested();
        return true;
    }
  }

  /**
   * `idempotent: true` 讓「補排同一個守衛」不會長出重複列 —— 這是 `reconcile`
   * 可以無腦重排的前提。
   *
   * 排不進去就地補救：**直接把那個 action 跑掉**。代價是這一輪提早失敗，
   * 但總比讓 agent 永遠卡在等待狀態好。死鎖是最糟的失敗模式，因為它不會叫。
   */
  private async armGuard(delaySeconds: number, action: A): Promise<boolean> {
    try {
      await this.schedule(delaySeconds, "resumeAction", action, {
        idempotent: true
      });
      return true;
    } catch (error) {
      this.onFail("failed to arm scheduled action", error);
      await this.dispatchInitialized(action);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 排程回呼（必須是 public：`schedule()` 的 callback 型別是 `keyof this`）
  // -------------------------------------------------------------------------

  /**
   * @internal 由 `ScheduleAction` 觸發。
   *
   * payload 是從 `cf_agents_schedules` 讀回來的 —— 跟持久狀態同一個信任邊界，
   * 所以同樣要過 schema（`def.scheduledAction`）。改版部署後醒來的舊排程列
   * 若形狀不合，在這裡丟棄並回報，不會以未定義形狀進入 `cmd`。
   */
  async resumeAction(action: A): Promise<void> {
    const schema = this.def.scheduledAction;
    if (schema !== undefined) {
      const decoded = Schema.decodeUnknownEither(schema)(action);
      if (Either.isLeft(decoded)) {
        this.onFail(
          "scheduled action failed schema validation; dropped",
          decoded.left.message
        );
        return;
      }
    }
    await this.dispatch(action);
  }

  // -------------------------------------------------------------------------
  // 唯讀查詢路 —— 不進 cmd、不碰狀態，但仍受初始化與隔離保護
  // -------------------------------------------------------------------------

  /**
   * 直接執行一個 Action 並回傳結果，不經過狀態機。
   *
   * 給「要資料、不要對話」的入口用：HTTP 卡片、健康檢查、預覽。這是**唯一**
   * 被認可的繞過 `dispatch` 執行 Action 的方式 —— 它仍然等初始化完成、仍然
   * 尊重隔離。直接摸 `this.runtime` 會繞過這兩層，不要那樣做。
   *
   * 不可從 `onWake()` 或初始化路徑呼叫（會等待自己所在的 Promise 而死鎖），
   * 理由同 `dispatch`。
   */
  protected async runQuery<I, O>(
    action: Action<I, O, R>,
    params: unknown
  ): Promise<Exit.Exit<O, ActionError>> {
    await this.initializeOnce();
    if (this.#quarantine !== null) {
      return Exit.fail(
        new ActionError({
          action: action.name,
          message: `agent quarantined: ${this.#quarantine}`
        })
      );
    }
    return await this.runtime.runPromiseExit(runAction(action, params));
  }

  // -------------------------------------------------------------------------
  // 文字輸入邊界 —— 時鐘與容量上限只在這裡出現，`cmd` 拿不到
  // -------------------------------------------------------------------------

  /**
   * 文字輸入的 UTF-8 byte 上限。`null` = 不設限。
   *
   * 在任何東西被持久化**之前**就擋掉超大輸入 —— DO 的狀態會一直存在，
   * 沒有上限就等於把儲存與 LLM 成本的控制權交給 client。
   */
  protected maxInputBytes(): number | null {
    return null;
  }

  /**
   * 文字輸入 → action。回 `null` 表示忽略這則輸入。
   *
   * 對話型 agent 覆寫這個而不是 `onMessage`：byte 上限、rejected 回報、
   * 時鐘注入（`now`）都由 shell 統一處理。
   */
  protected textAction(_text: string, _now: number): A | null {
    return null;
  }

  override async onMessage(
    _connection: unknown,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (typeof message !== "string") return;

    const limit = this.maxInputBytes();
    if (limit !== null) {
      const bytes = new TextEncoder().encode(message).byteLength;
      if (bytes > limit) {
        this.onEmit("rejected", {
          reason: "message too large",
          bytes,
          limit
        });
        return;
      }
    }

    const action = this.textAction(message, Date.now());
    if (action !== null) await this.dispatch(action);
  }

  // -------------------------------------------------------------------------
  // Instruction 執行 —— Effect 唯一被實際跑起來的地方
  // -------------------------------------------------------------------------

  /**
   * 這裡刻意是**同步等待**而不是丟進 `this.schedule()` 排隊。
   *
   * 走排隊可以拿到「呼叫途中被驅逐也能續跑」，代價是多一次 alarm round-trip 的
   * 延遲 —— 對話型 agent 感受得到。這裡選擇同步，因為可恢復性已經由狀態機保證：
   * 狀態裡有 `AwaitingModel(requestId, deadlineAt)`，DO 死在半路時，醒來的
   * `reconcile` 會依 `deadlineAt` 把 agent 拉回一致。
   *
   * **可恢復性來自狀態機的設計，不是來自把每一步都排進佇列。**
   */
  private async executeInstruction(instruction: RunInstruction): Promise<void> {
    const action: AnyAction<R> | undefined = this.actions[instruction.action];

    const outcome: Outcome =
      action === undefined
        ? { _tag: "Err", message: `unknown action: ${instruction.action}` }
        : toOutcome(
            await this.runtime.runPromiseExit(
              runAction(action, instruction.params)
            )
          );

    // 必須是 `dispatchInitialized`，不能是公開的 `dispatch`。
    //
    // `reconcile` 產生的 action 可能帶 `RunInstruction`，那條路徑是
    // `initialize()` → `reconcileValidatedState()` → ... → 這裡。此時
    // `#initialized` 還是 false、`#initialization` 還是進行中的那個 Promise，
    // 走公開入口就會 `await` 自己所在的 Promise —— 直接死鎖。
    // 同理適用於 `armGuard` 的 fallback。
    await this.dispatchInitialized({
      ...(instruction.meta ?? {}),
      _tag: instruction.resultAction,
      outcome
    } as unknown as A);
  }

  // -------------------------------------------------------------------------
  // 可覆寫的輸出接點
  // -------------------------------------------------------------------------

  protected onEmit(event: string, payload: unknown): void {
    this.broadcast(JSON.stringify({ type: event, payload }));
  }

  protected onFail(reason: string, detail: unknown): void {
    console.error(`[${this.def.name}] ${reason}`, detail);
  }

  protected async onStopRequested(): Promise<void> {}
}

const toOutcome = <O, E>(exit: Exit.Exit<O, E>): Outcome =>
  Exit.isSuccess(exit)
    ? { _tag: "Ok", value: exit.value }
    : { _tag: "Err", message: Cause.pretty(exit.cause) };
