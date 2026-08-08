/**
 * Workers AI budget, read from Cloudflare's own analytics.
 *
 * The free plan allows 10,000 neurons and then hard-fails — not throttles, not degrades. That
 * makes the budget a property of the service worth showing rather than hiding: it answers both
 * "why did my question fail" and "how many more can I ask".
 *
 * ── What the numbers mean, because two of them disagree ──────────────────────────────────────
 *
 * The limit is enforced over a **rolling 24-hour window**, but the Cloudflare dashboard displays
 * a **calendar-day** counter that resets at 00:00 UTC. Those are different quantities, and they
 * diverge exactly when it matters. Measured on this account on 2026-08-08:
 *
 *     calendar-day usage (dashboard) :  2,492 / 10,000   "plenty left"
 *     trailing 24h      (enforced)   : 10,681 / 10,000   every request failing
 *
 * So the reassuring number is the wrong one. This module reports the trailing window, and
 * projects when service returns by ageing hourly buckets out of it — which is the question a
 * blocked user actually has, and is several hours earlier than the dashboard's implied reset.
 *
 * ── On accuracy ──────────────────────────────────────────────────────────────────────────────
 *
 * `totalNeurons` comes from Cloudflare's `aiInferenceAdaptiveGroups` dataset — the same source
 * the dashboard draws on. Nothing here is estimated from token counts, so nothing drifts. Two
 * honest caveats remain: analytics aggregate with a short lag, and enforcement counters appear to
 * lag too — a burst can overshoot the limit before the limiter catches up, which is how a 2,492
 * neuron recording completed against 1,811 of headroom. The gauge is therefore accurate for
 * planning and approximate at the very margin.
 */

const DATASET_LIMIT = 10_000;
const WINDOW_HOURS = 24;
/** Analytics lag by minutes, so polling faster than this buys nothing and costs latency. */
const CACHE_SECONDS = 60;

export interface ModelUsage {
  modelId: string;
  neurons: number;
}

export interface BudgetSnapshot {
  available: true;
  /** Neurons in the enforced trailing window. */
  windowNeurons: number;
  windowHours: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
  /** Calendar-day total — reported only to show how far it diverges from what is enforced. */
  calendarDayNeurons: number;
  /** ISO timestamp when the window is projected to fall back under the limit, if exhausted. */
  recoversAt: string | null;
  byModel: ModelUsage[];
  measuredAt: string;
}

export interface BudgetUnavailable {
  available: false;
  reason: string;
}

export type Budget = BudgetSnapshot | BudgetUnavailable;

interface HourBucket {
  hour: number;
  neurons: number;
}

interface GraphQLResponse {
  data?: {
    viewer?: {
      accounts?: Array<{
        aiInferenceAdaptiveGroups?: Array<{
          sum: { totalNeurons: number };
          dimensions: { datetimeHour: string; modelId?: string };
        }>;
      }>;
    };
  };
  errors?: unknown;
}

function query(accountTag: string, sinceIso: string, byModel: boolean): string {
  const dims = byModel ? "datetimeHour modelId" : "datetimeHour";
  return `{ viewer { accounts(filter: {accountTag: "${accountTag}"}) {
    aiInferenceAdaptiveGroups(limit: 1000, filter: {datetimeHour_geq: "${sinceIso}"}, orderBy: [datetimeHour_ASC]) {
      sum { totalNeurons }
      dimensions { ${dims} }
    } } } }`;
}

async function run(token: string, body: string): Promise<GraphQLResponse> {
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`analytics HTTP ${res.status}`);
  return (await res.json()) as GraphQLResponse;
}

/**
 * Project when the rolling window drops back under the limit.
 *
 * Walks forward an hour at a time, dropping buckets as they age past the window. Hour resolution
 * matches the dataset's own granularity — claiming minute precision would be inventing detail the
 * source does not carry.
 */
export function projectRecovery(
  buckets: HourBucket[],
  now: number,
  limit = DATASET_LIMIT,
  windowHours = WINDOW_HOURS,
): string | null {
  const windowMs = windowHours * 3_600_000;
  const HOUR = 3_600_000;
  // Step on hour boundaries rather than from the current instant. Stepping from `now` makes the
  // answer drift with the clock — asked at 15:45 it says 20:45, asked at 16:00 it says 21:00 —
  // which reads as instability rather than the hour-resolution estimate it actually is.
  const firstBoundary = Math.ceil(now / HOUR) * HOUR;
  for (let h = 0; h <= windowHours + 1; h++) {
    const at = firstBoundary + h * HOUR;
    const total = buckets.reduce((sum, b) => (at - b.hour < windowMs ? sum + b.neurons : sum), 0);
    if (total < limit) return new Date(at).toISOString();
  }
  return null;
}

export function summarise(
  rows: Array<{ hour: number; neurons: number; modelId?: string }>,
  now: number,
): Omit<BudgetSnapshot, "available" | "measuredAt"> {
  const windowMs = WINDOW_HOURS * 3_600_000;
  const inWindow = rows.filter((r) => now - r.hour < windowMs);
  const windowNeurons = Math.round(inWindow.reduce((s, r) => s + r.neurons, 0) * 10) / 10;

  const dayStart = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  const calendarDayNeurons =
    Math.round(rows.filter((r) => r.hour >= dayStart).reduce((s, r) => s + r.neurons, 0) * 10) / 10;

  const perModel = new Map<string, number>();
  for (const r of inWindow) {
    if (!r.modelId) continue;
    perModel.set(r.modelId, (perModel.get(r.modelId) ?? 0) + r.neurons);
  }

  const exhausted = windowNeurons >= DATASET_LIMIT;
  // Collapse to hour buckets for the projection.
  const buckets = new Map<number, number>();
  for (const r of rows) buckets.set(r.hour, (buckets.get(r.hour) ?? 0) + r.neurons);

  return {
    windowNeurons,
    windowHours: WINDOW_HOURS,
    limit: DATASET_LIMIT,
    remaining: Math.max(0, Math.round((DATASET_LIMIT - windowNeurons) * 10) / 10),
    exhausted,
    calendarDayNeurons,
    recoversAt: exhausted
      ? projectRecovery(
          [...buckets].map(([hour, neurons]) => ({ hour, neurons })),
          now,
        )
      : null,
    byModel: [...perModel]
      .map(([modelId, neurons]) => ({ modelId, neurons: Math.round(neurons * 10) / 10 }))
      .sort((a, b) => b.neurons - a.neurons),
  };
}

export async function readBudget(env: Env): Promise<Budget> {
  const token = env.CF_ANALYTICS_TOKEN;
  const account = env.CF_ACCOUNT_TAG;
  if (!token || !account) {
    return {
      available: false,
      reason:
        "Budget reporting needs CF_ANALYTICS_TOKEN and CF_ACCOUNT_TAG. Without them this Worker cannot read usage, and it deliberately does not estimate one.",
    };
  }

  // Cached at the edge: analytics aggregate with a lag, so a fresher poll would return the same
  // numbers while adding a round trip to every page load.
  const cacheKey = new Request("https://glassbox.internal/budget");
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return (await hit.json()) as Budget;

  const now = Date.now();
  const since = new Date(now - (WINDOW_HOURS + 2) * 3_600_000).toISOString().slice(0, 13) + ":00:00Z";

  try {
    const json = await run(token, JSON.stringify({ query: query(account, since, true) }));
    if (json.errors) throw new Error("analytics query returned errors");
    const groups = json.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups ?? [];
    const rows = groups.map((g) => ({
      hour: Date.parse(g.dimensions.datetimeHour),
      neurons: g.sum.totalNeurons,
      modelId: g.dimensions.modelId,
    }));

    const snapshot: BudgetSnapshot = {
      available: true,
      ...summarise(rows, now),
      measuredAt: new Date(now).toISOString(),
    };

    await cache.put(
      cacheKey,
      new Response(JSON.stringify(snapshot), {
        headers: { "content-type": "application/json", "cache-control": `max-age=${CACHE_SECONDS}` },
      }),
    );
    return snapshot;
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : "analytics unavailable",
    };
  }
}
