/**
 * ════════════════════════════════════════════════════════════════════════════
 *  kiro-usage.json — snapshot contract between the plugin and this panel
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Written by @servoy/opencode-kiro-auth to `~/.config/opencode/kiro-usage.json`
 * (Windows: `%APPDATA%\opencode\kiro-usage.json`), atomically (tmp + rename), by
 * `writeUsageSnapshot` (plugin/usage-snapshot.ts). The panel only READS it: the
 * OpenChamber sandbox gives it no network and no token.
 *
 * Every field marked optional (`?`) may be missing. The panel then shows
 * "not reported", NEVER 0 (a missing value must not look like "0% quota";
 * cf. OpenChamber issue #2327).
 *
 * ── Two labels per field ─────────────────────────────────────────────────────
 *
 * TRUST — how far to believe the number:
 *   EXACT   counted, or reported by Kiro itself. Shown plain with an "exact" tag.
 *   EST.    apportioned or derived by the plugin. Shown with "~" and an "est." tag.
 *
 * PLUGIN — whether the plugin delivers it today (verified against the code of
 *   @servoy/opencode-kiro-auth 2.11.0):
 *   [TODAY]  already written to the snapshot.
 *   [SMALL]  data is already stored; needs a small query/mapping change only.
 *   [NEW]    needs new capture AND persistence (new column/table). The data is
 *            seen in memory today (named below) but is not stored.
 *
 * ── CONTRACT v3 (credits are metered per response; wins over v2 and anything below)
 *
 *   Kiro sends NO token counts (0 of 18,079 responses carried `tokenUsage`), so
 *   `tokens` are ESTIMATED BY THE PLUGIN, not by Kiro and not by OpenCode:
 *     outputTokens         ~4 characters per token of reply + reasoning + tool input.
 *     uncachedInputTokens  round(model window × Kiro's contextUsagePercentage / 100)
 *                          − outputTokens. The percentage is Kiro's; the window (1M for
 *                          `auto`) is the plugin's assumption.
 *     cacheRead/WriteTokens always 0. The panel hides them.
 *     reportedRequests     in practice every finished message; read it as "messages
 *                          counted", not as "Kiro reported tokens".
 *   The panel labels tokens "est. · plugin". Tool calls, turns, requests and
 *   `burn[].counterDelta` are exact.
 *
 *   Credits. Detected by field presence, never by plugin version:
 *     creditsSource   'metered': credits are booked per response, without the old
 *                     double counting. Absent: the older apportioned estimate.
 *     meteredSince    ms epoch of the switch. Sessions with firstUsed < meteredSince
 *                     carry the older, overcounted credits (the panel marks them
 *                     "pre-metering" and never calls them "priciest").
 *   burn[] per account:
 *     requests        every session active in the window, exact.
 *     credits         metered credits of sessions begun after meteredSince only, so a
 *                     lower bound until a full window has passed; NOT a pace until then.
 *     creditsSince    first activity among the sessions `credits` covers.
 *     counterDelta    EXACT: sum of the increases of Kiro's own `used` counter in the
 *                     window (a period reset subtracts nothing).
 *     counterSince    first reading in the window. Absent = not reported, never 0.
 *   Pace shown by the panel, best source first: counterDelta ÷ (now − counterSince) once
 *   that spans 3 days; else the month average used ÷ working days so far (exact); a
 *   burn[].credits pace only once the window is fully metered.
 *
 *   `resetAt` may be missing in a snapshot written by a freshly started instance. The
 *   panel keeps the last known value per account. `daysUntilReset` is not used: the
 *   panel computes days from `resetAt`.
 *
 * ── CONTRACT v2 (agreed with the plugin side; superseded where v3 says otherwise)
 *
 *   The plugin reads OpenCode's own per-message data through the client OpenCode
 *   gives it, and writes BOUNDED aggregates here. File stays ~55 KB regardless of use.
 *
 *   sessions[]   top 50 by recency. Each: sessionId, requests, estCredits, firstUsed,
 *                lastUsed, accounts[], tokens, tools[], toolCalls, turns.
 *                tokens/tools/turns are SUMMED OVER THE ROOT SESSION AND ALL ITS
 *                SUBAGENT CHILDREN (the plugin books subagent requests under the root;
 *                checked: 216 own + 722 child messages = 938 vs 945 requests), and only
 *                for messages whose model.providerID is 'kiro'.
 *   turns        { toolUse, answer, error }. finish 'tool-calls' | 'stop' | 'error';
 *                a message with no finish yet is still running and is not counted.
 *   tokens       top level, last `windowDays` days, ALL accounts together: an OpenCode
 *                message has no account id, so tokens cannot be split per account.
 *   tools        top level aggregate { windowDays, totalCalls, items[] }.
 *   burn[]       per account: credits (est.), requests (exact). No tokens/toolCalls.
 *   daily[]      per account per day, 14 days.
 *   sessionsTotal, schema: 2.
 *
 *   NOT in the file: contextPct (the host gives it live per session), withReasoning
 *   (reasoning tokens are 0 for Kiro), model/agent (the host gives agent live),
 *   per-field `source` (the panel knows the source of each field).
 *
 * ── SOURCES (revised) ───────────────────────────────────────────────────────
 *
 * Two sources feed the panel, and every number is labelled with its source:
 *
 *   Kiro      credits, quota, overage, reset, requests, burn, and the per-session
 *             credit ESTIMATE. Only the plugin knows these. Label: "est. · Kiro".
 *   OpenCode  tokens, tool calls, finish reasons, per session. OpenCode already
 *             stores them (session_message / the server's message API), so the
 *             plugin READS them from OpenCode and copies them into this file; it
 *             does not capture or count them itself. Tool calls and turns are
 *             exact. Tokens are plugin estimates (see v3): label "est. · plugin".
 *             A Code Mode `execute` call is one tool call to OpenCode; the calls
 *             inside the script are not recorded separately.
 *
 * The panel cannot read OpenCode directly: host.readFile returns text (max 2 MB)
 * from declared paths, and the host SDK only exposes live context%, current tool
 * and agent, no rollups. So the plugin is the bridge, via the `serverUrl` and
 * `client` OpenCode hands every plugin, which needs no database path and works
 * the same on Windows, Linux and macOS.
 *
 * What the data really looks like for Kiro (checked on a real install):
 *   - cacheRead / cacheWrite are 0 in 400 of 400 responses and in 0 of 7686
 *     OpenCode messages: Kiro reports no cache split. Write 0, the panel hides it.
 *   - reasoning tokens are 0 for Kiro. The panel does not show them.
 *   - `uncachedInputTokens` is the whole prompt per request (hundreds of
 *     thousands), so sums are "tokens processed", not "tokens billed".
 *   - (Superseded by v3: Kiro sends no tokenUsage; the plugin estimates tokens.)
 *   - Credits do not follow tokens (correlation 0.36 over 1012 responses). Never
 *     convert one into the other; the panel shows both and does not link them.
 *
 * ── What Kiro does and does not give us ──────────────────────────────────────
 *   Kiro's generateAssistantResponse stream carries, per response:
 *     • metadataEvent.tokenUsage  { uncachedInputTokens, outputTokens,
 *         cacheReadInputTokens, cacheWriteInputTokens } → EXACT tokens.
 *         `inputTokens` does not exist (always 0); total prompt tokens =
 *         uncached + cacheRead + cacheWrite.
 *     • toolUseEvent { toolUseId, name, … }            → EXACT tool-call counts.
 *     • contextUsagePercentage (metadataEvent / tokenUsage / contextUsageEvent)
 *         → EXACT context fill, but only when Kiro sends it.
 *     • meteringEvent { usage, unit }                  → credits for that
 *         response, when Kiro sends it. See `metered` below for the caveats.
 *   It does NOT give: cost per tool call, model or agent (the plugin does not
 *   record them), or a per-day history. Those are not in the contract.
 *
 * ── Field reference ──────────────────────────────────────────────────────────
 *
 * UsageFile
 *   version            1                          EXACT  [TODAY]
 *   schema             2                          [TODAY] constant SNAPSHOT_SCHEMA, set
 *                                                 once any insight field is written.
 *                                                 Absent on older snapshots. The panel
 *                                                 treats it, or any concrete insight
 *                                                 field, as "insights present"; it
 *                                                 never keys off a plugin version.
 *   writtenAt          ms epoch                   EXACT  [TODAY]
 *   pluginVersion      string                     EXACT  [TODAY]
 *   pluginInstances    PluginInstance[]           EXACT  [TODAY]
 *   latestVersion      string                     EXACT  [NEW] the panel already
 *                      reads it for the update warning, but the plugin does not
 *                      write it yet (no npm check exists in the plugin source).
 *   accounts           AccountUsage[]             [TODAY]
 *   sessions           SessionUsage[]             [TODAY] newest 20
 *   sessionsTotal      number                     EXACT  [TODAY] COUNT(DISTINCT
 *                      session_id) over session_usage, so the panel can say
 *                      "20 of 47". Counts only the 7-day TTL window.
 *   burn               BurnTotal[]                [TODAY] one per account
 *   daily              DailyUsage[]               [NEW] needs a new per-day
 *                      aggregate table (see DailyUsage).
 *   tools              ToolTotals                 [NEW] needs per-tool persistence
 *                      (see ToolCount).
 *
 * AccountUsage — all fields [TODAY], EXACT (from getUsageLimits): id, email,
 *   region, used, limit, pct, plan, planType, overage*, currentOverages, unit,
 *   resetAt, daysUntilReset, isHealthy, updatedAt. Kiro does not report the
 *   start of the billing period, so the panel derives "Day N of M" from resetAt
 *   minus one month and labels it "≈".
 *
 * SessionUsage
 *   sessionId          string                     EXACT  [TODAY]
 *   directory          string?                    EXACT  [TODAY]
 *   title              string?                    column exists but the plugin
 *                      never fills it (recordSessionRequest is called with
 *                      `{ directory }` only). The panel takes titles from the
 *                      OpenChamber host, so this is not needed.
 *   requests           number                     EXACT  [TODAY] +1 per served request
 *   estCredits         number                     EST.   [TODAY] account credit delta
 *                      apportioned by request share (apportionSessionCredits)
 *   firstUsed,lastUsed ms epoch                   EXACT  [TODAY]
 *   accounts           SessionAccountUsage[]      [TODAY] per-account split
 *   tokens             TokenCounts?               EXACT  [NEW] source: OpenCode (its
 *                      per-message tokens; originally Kiro's metadataEvent.tokenUsage, read today in
 *                      sdk-stream-transformer.ts (streaming) and
 *                      response-handler.ts handleSdkNonStreaming, but only put
 *                      in the OpenAI-style reply, never stored. Sum per session.
 *   metered            MeteredCredits?            EXACT-if-reported  [NEW] source:
 *                      meteringEvent.usage, read in sdk-stream-transformer.ts
 *                      (`credits`, logged only; not read in the non-streaming
 *                      handler). CAVEATS to verify with real traffic before
 *                      trusting: the plugin assigns (`=`), not sums, so several
 *                      metering events per response would undercount; and test
 *                      fixtures also send an empty `meteringEvent: {}`. Count a
 *                      request in `reportedRequests` only when usage was a number.
 *   toolCalls          number                     EXACT  [NEW] sum of tools[].count
 *   tools              ToolCount[]                EXACT  [NEW] source: toolUseEvent
 *                      (response-handler.ts and the toolCalls array in
 *                      sdk-stream-transformer.ts). Count one per distinct
 *                      toolUseId, keyed by the restored tool name (restoreToolName),
 *                      so it matches what OpenCode calls the tool.
 *   contextPct         number? 0–100              EXACT  [NEW] latest non-null
 *                      contextUsagePercentage. The streaming transformer reads it
 *                      (sdk-stream-transformer.ts, metadataEvent and
 *                      contextUsageEvent); the non-streaming handler does not.
 *                      Only present "if Kiro sent it"; never fabricate it.
 *
 *   turns              TurnMix?                   EXACT  [NEW] how each response ended:
 *                      with tool calls (the agent keeps working) or as a plain
 *                      answer, and whether it reasoned. Source:
 *                      sdk-stream-transformer.ts (`dedupedToolCalls.length`,
 *                      `reasoningContent`). IMPORTANT: recordSessionRequest runs in
 *                      request-handler.ts BEFORE the stream is read, so classify
 *                      and persist at stream end. toolUse + answer can therefore
 *                      trail `requests` while a stream is in flight or was aborted.
 *                      The non-streaming handler (response-handler.ts) never reads
 *                      reasoningContentEvent, so withReasoning is a floor there.

 * TurnMix       (all EXACT counts of responses)
 *   toolUse   finish 'tool-calls'
 *   answer    finish 'stop'
 *   error     finish 'error'
 *
 * TokenCounts   (all ESTIMATED by the plugin, see v3; summed over finished messages)
 *   uncachedInputTokens  number   fresh prompt tokens
 *   outputTokens         number
 *   cacheReadTokens      number   repeated context served from cache (cheap)
 *   cacheWriteTokens     number
 *   reportedRequests     number   requests whose metadataEvent.tokenUsage arrived.
 *                        If < requests the totals are a floor, and the panel says
 *                        "from N of M requests". Do NOT count requests where the
 *                        plugin fell back to its own context-% token estimate.
 *
 * MeteredCredits
 *   credits              number   sum of meteringEvent.usage
 *   reportedRequests     number   requests that carried a numeric usage
 *
 * ToolCount     (count is EXACT; there is NO credit-per-tool field: Kiro reports
 *   no cost per tool call, and apportioning by count would be false precision)
 *   name, count
 *
 * BurnTotal     per account, one 7-day window over ALL sessions
 *   accountId, windowDays, earliestUsed          [TODAY]
 *   credits              EST.   [TODAY]
 *   requests             EXACT  [TODAY] SUM(requests) per account over the window
 *   toolCalls            EXACT  [NEW]   needs the tool table
 *   tokens               TokenCounts? EXACT [NEW] needs the token columns
 *
 * DailyUsage    [NEW — requires a new plugin aggregate]. session_usage only has
 *   first/last_used within a 7-day TTL, so no per-day split exists. Needs a table
 *   keyed (account_id, day) with credits/requests/tool calls, updated on each
 *   request and each credit apportioning, with ≥14 days retention. One row per
 *   account per LOCAL day with any activity. Days before the first row render as
 *   "not reported"; a later day without a row is a real zero-activity day.
 *   accountId, day "YYYY-MM-DD"
 *   estCredits           EST.   (the day's share of the account credit delta)
 *   requests             EXACT
 *   toolCalls            EXACT, optional
 *
 * ToolTotals    [NEW] windowDays (7), totalCalls, items: ToolCount[] over ALL
 *   sessions in the window (not just the capped session list). Needs the same
 *   per-(session, account, tool) table as SessionUsage.tools, with the 7-day TTL.
 */

/** One account, as the plugin's kiro-usage.json writes it. */
export interface AccountUsage {
  id: string
  email: string
  region: string
  used: number
  limit: number
  pct: number
  plan?: string
  planType?: string
  overageStatus?: string
  overageRate?: number
  overageCap?: number
  currentOverages?: number
  unit?: string
  resetAt?: number
  daysUntilReset?: number
  isHealthy: boolean
  updatedAt: number
}

/** One tool and how often it was called (EXACT). No credits: Kiro reports none per tool. */
export interface ToolCount {
  name: string
  count: number
}

/** ESTIMATED token totals, from the plugin via OpenCode's per-message tokens (Kiro-provider messages only). */
export interface TokenCounts {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reportedRequests: number
}

/** How each response ended. All EXACT counts of responses; an unfinished one is not counted. */
export interface TurnMix {
  toolUse: number
  answer: number
  error: number
}

/** Token totals over a window, all accounts together. */
export interface WindowTokens extends TokenCounts {
  windowDays: number
}

/** One account's contribution to a session, as the plugin writes it. */
export interface SessionAccountUsage {
  accountId: string
  requests: number
  estCredits: number
  firstUsed: number
  lastUsed: number
}

export interface SessionUsage {
  sessionId: string
  title?: string
  directory?: string
  requests: number
  estCredits: number
  firstUsed: number
  lastUsed: number
  accounts?: SessionAccountUsage[]
  toolCalls?: number
  tools?: ToolCount[]
  tokens?: TokenCounts
  turns?: TurnMix
}

export interface PluginInstance {
  pid: number
  version: string
  source?: string
  self: boolean
  lastSeen: number
}

export interface BurnTotal {
  accountId: string
  windowDays: number
  credits: number
  earliestUsed: number
  requests?: number
  /** ms epoch: first activity among the sessions `credits` covers (those begun after meteredSince). */
  creditsSince?: number
  /** EXACT: sum of the increases of Kiro's own used counter inside the window. Absent until it moved. */
  counterDelta?: number
  /** ms epoch: first counter reading inside the window; counterDelta covers counterSince → now. */
  counterSince?: number
}

export interface DailyUsage {
  accountId: string
  day: string
  estCredits: number
  requests: number
  toolCalls?: number
}

export interface ToolTotals {
  windowDays: number
  totalCalls: number
  items: ToolCount[]
}

export interface UsageFile {
  version: 1
  schema?: number
  writtenAt: number
  /** 'metered': credits are the sum of Kiro's per-response metering, not an apportioned estimate. */
  creditsSource?: 'metered'
  /** ms epoch; burn[] credits only count sessions that started at or after this. Fixed per database. */
  meteredSince?: number
  pluginVersion?: string
  latestVersion?: string
  pluginInstances?: PluginInstance[]
  accounts: AccountUsage[]
  sessions: SessionUsage[]
  sessionsTotal?: number
  burn?: BurnTotal[]
  daily?: DailyUsage[]
  tools?: ToolTotals
  tokens?: WindowTokens
}
