/**
 * The MCP endpoint.
 *
 * One route, POST only, stateless. That shape is not a simplification — since revision
 * 2026-07-28 it is what the transport specifies, which is why an MCP server fits a Worker so
 * cleanly: no session store to keep, no stream to hold open, no handshake to remember.
 *
 * Order of operations matters and is deliberate. Transport-level rejections (origin, method,
 * malformed body, header mismatch) happen before authentication, because they are true regardless
 * of who is asking. Authentication happens before dispatch. Spend controls — scope, rate limit,
 * budget — happen before the tool runs, because a control that fires after the neurons are gone
 * has not controlled anything.
 */

import {
  MODERN_VERSION,
  LEGACY_VERSION,
  SUPPORTED_VERSIONS,
  RpcError,
  declaredVersion,
  detectEra,
  isNotification,
  originRejected,
  validateEnvelope,
  validateModernHeaders,
  type Era,
  type ProtocolFailure,
  type RpcRequest,
} from "./protocol.ts";
import { authenticate, scopeSatisfies, type Principal } from "./auth.ts";
import { TOOLS, ToolError, describeTool, toolByName, toolsForScope } from "./tools.ts";
import { recordCall, successfulCallsSince, type Outcome } from "./observe.ts";
import { readBudget } from "../agent/budget.ts";

const SERVER_INFO = { name: "glassbox", version: "1.0.0" };

const INSTRUCTIONS =
  "Glassbox answers questions over a fixed corpus of Cloudflare Registrar documentation and " +
  "refuses rather than guessing when the corpus does not cover the question. Every answer ships " +
  "with the passages it was grounded on, their similarity scores, and a second model's verdict on " +
  "whether the answer is actually supported. Prefer glassbox_retrieve when you need the evidence " +
  "and glassbox_ask when you need a written answer; ask spends a shared daily allocation that " +
  "glassbox_budget reports.";

/** Successful `glassbox_ask` calls permitted per rolling hour, across all callers. */
const ASK_CALLS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

interface Dispatch {
  status: number;
  body: unknown;
  outcome: Outcome;
  errorCode: number | null;
  tool: string | null;
  neurons: number;
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const startedAt = Date.now();

  // Transport-level rejections. None of these reach the JSON-RPC layer or the observability
  // table, because at this point there is no method to attribute them to.
  if (originRejected(request.headers)) {
    return new Response("cross-origin requests are not accepted", { status: 403 });
  }
  if (request.method !== "POST") {
    // GET and DELETE were the session and standalone-stream mechanics of earlier revisions.
    // This revision has neither, and 405 is the specified answer for a client that still tries.
    return new Response("the MCP endpoint accepts POST only", {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(null, 400, RpcError.PARSE, "request body is not valid JSON");
  }

  const envelopeFailure = validateEnvelope(raw);
  if (envelopeFailure) return failureResponse(null, envelopeFailure);

  const body = raw as RpcRequest;
  const id = body.id ?? null;
  const era = detectEra(request.headers, body);
  const version = declaredVersion(request.headers, body);

  if (era === "modern") {
    const headerFailure = validateModernHeaders(request.headers, body);
    if (headerFailure) {
      await record(env, body.method, null, era, null, "protocol_error", headerFailure.code, startedAt, 0, version);
      return failureResponse(id, headerFailure);
    }
  }

  // A notification carries no id and gets no body. This revision defines no client-to-server
  // notifications, but legacy clients still send `notifications/initialized` after the handshake,
  // and dropping it on the floor with 202 is exactly right.
  if (isNotification(body)) {
    await record(env, body.method, null, era, null, "ok", null, startedAt, 0, version);
    return new Response(null, { status: 202 });
  }

  const dispatch = await route(request, env, body, era);
  await record(
    env,
    body.method,
    dispatch.tool,
    era,
    dispatch.scope ?? null,
    dispatch.outcome,
    dispatch.errorCode,
    startedAt,
    dispatch.neurons,
    version,
  );

  return jsonResponse(dispatch.status, dispatch.body);
}

async function route(
  request: Request,
  env: Env,
  body: RpcRequest,
  era: Era,
): Promise<Dispatch & { scope?: string }> {
  const id = body.id ?? null;
  const ok = (result: unknown, neurons = 0, tool: string | null = null): Dispatch => ({
    status: 200,
    body: { jsonrpc: "2.0", id, result },
    outcome: "ok",
    errorCode: null,
    tool,
    neurons,
  });

  // Unauthenticated by design: these reveal only which protocol this server speaks. A client that
  // cannot negotiate a version without a credential cannot tell "wrong token" from "wrong
  // protocol", and would report the wrong problem to its user.
  switch (body.method) {
    case "server/discover":
      return ok({
        resultType: "complete",
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
        _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
      });

    case "initialize": {
      // Legacy handshake. Answered so clients that predate the modern revision can connect at
      // all — the compatibility matrix is explicit that they have no way to fall forward.
      const requested = (body.params?.protocolVersion as string | undefined) ?? LEGACY_VERSION;
      const agreed = SUPPORTED_VERSIONS.includes(requested) ? requested : LEGACY_VERSION;
      return ok({
        protocolVersion: agreed,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }

    case "ping":
      return ok({});
  }

  const principal = authenticate(request, env);
  if (!principal) {
    return {
      status: 401,
      body: {
        jsonrpc: "2.0",
        id,
        error: {
          code: RpcError.UNAUTHORIZED,
          message:
            "a bearer token is required; send Authorization: Bearer <token>. Call server/discover " +
            "or initialize without one to negotiate protocol version.",
        },
      },
      outcome: "unauthorized",
      errorCode: RpcError.UNAUTHORIZED,
      tool: null,
      neurons: 0,
    };
  }

  switch (body.method) {
    case "tools/list":
      return {
        ...ok({
          resultType: "complete",
          tools: toolsForScope(principal.scope).map(describeTool),
        }),
        scope: principal.scope,
      };

    case "tools/call":
      return { ...(await callTool(env, body, principal)), scope: principal.scope };
  }

  return {
    status: 404,
    body: {
      jsonrpc: "2.0",
      id,
      error: { code: RpcError.METHOD_NOT_FOUND, message: `unknown method '${body.method}'` },
    },
    outcome: "protocol_error",
    errorCode: RpcError.METHOD_NOT_FOUND,
    tool: null,
    neurons: 0,
    scope: principal.scope,
  };
}

async function callTool(env: Env, body: RpcRequest, principal: Principal): Promise<Dispatch> {
  const id = body.id ?? null;
  const name = body.params?.name;

  if (typeof name !== "string") {
    return rpcFailure(id, 400, RpcError.INVALID_PARAMS, "params.name is required", "protocol_error");
  }

  const tool = toolByName(name);
  if (!tool) {
    return rpcFailure(
      id,
      404,
      RpcError.METHOD_NOT_FOUND,
      `unknown tool '${name}'. Available: ${toolsForScope(principal.scope)
        .map((t) => t.name)
        .join(", ")}`,
      "protocol_error",
    );
  }

  if (!scopeSatisfies(principal.scope, tool.scope)) {
    // The read scope never sees this tool in tools/list, so reaching here means the caller went
    // looking. The message says why the boundary exists, because the reason is not obvious: the
    // corpus is public, and what is being protected is a shared spending allowance.
    return {
      ...rpcFailure(
        id,
        403,
        RpcError.UNAUTHORIZED,
        `'${name}' requires the full scope. It spends against a Workers AI allocation shared with ` +
          "the live demo, which is what the scope protects — the corpus itself is public.",
        "forbidden",
      ),
      tool: name,
    };
  }

  // Spend controls, in increasing order of cost to check.
  if (tool.scope === "full") {
    const since = Date.now() - HOUR_MS;
    const recent = await successfulCallsSince(env.DB, tool.name, since);
    if (recent >= ASK_CALLS_PER_HOUR) {
      return {
        ...rpcFailure(
          id,
          429,
          RpcError.UNAUTHORIZED,
          `rate limit reached: ${ASK_CALLS_PER_HOUR} successful ${tool.name} calls per rolling ` +
            "hour. The free tools are unmetered — glassbox_retrieve returns the same evidence " +
            "without generating.",
          "rate_limited",
        ),
        tool: name,
      };
    }

    const budget = await readBudget(env);
    if ("exhausted" in budget && budget.exhausted) {
      return {
        ...rpcFailure(
          id,
          503,
          RpcError.UNAUTHORIZED,
          "the Workers AI allocation for the enforced rolling 24-hour window is spent, so this " +
            "call would fail upstream. Call glassbox_budget for the projected recovery time.",
          "budget_exhausted",
        ),
        tool: name,
      };
    }
  }

  const args = (body.params?.arguments as Record<string, unknown> | undefined) ?? {};

  try {
    const outcome = await tool.handler(args, env);
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(outcome.data, null, 2) }],
          structuredContent: outcome.data,
          isError: false,
        },
      },
      outcome: "ok",
      errorCode: null,
      tool: name,
      neurons: outcome.neurons,
    };
  } catch (error) {
    // A tool that failed is reported inside a successful JSON-RPC result with isError set, not as
    // a protocol error: the protocol worked, the tool did not, and the model needs to see the
    // difference so it can adjust its arguments rather than give up on the server.
    const message = error instanceof ToolError ? error.message : "the tool failed unexpectedly";
    if (!(error instanceof ToolError)) console.error(`mcp tool ${name} failed`, error);
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: message }], isError: true },
      },
      outcome: "tool_error",
      errorCode: null,
      tool: name,
      neurons: 0,
    };
  }
}

// ── response helpers ──────────────────────────────────────────────────────────────────────────

function rpcFailure(
  id: string | number | null,
  status: number,
  code: number,
  message: string,
  outcome: Outcome,
): Dispatch {
  return {
    status,
    body: { jsonrpc: "2.0", id, error: { code, message } },
    outcome,
    errorCode: code,
    tool: null,
    neurons: 0,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(
  id: string | number | null,
  status: number,
  code: number,
  message: string,
): Response {
  return jsonResponse(status, { jsonrpc: "2.0", id, error: { code, message } });
}

function failureResponse(id: string | number | null, failure: ProtocolFailure): Response {
  return jsonResponse(failure.status, {
    jsonrpc: "2.0",
    id,
    error: { code: failure.code, message: failure.message, ...(failure.data ? { data: failure.data } : {}) },
  });
}

async function record(
  env: Env,
  method: string,
  tool: string | null,
  era: Era,
  scope: string | null,
  outcome: Outcome,
  errorCode: number | null,
  startedAt: number,
  neurons: number,
  protocolVersion: string | null,
): Promise<void> {
  try {
    await recordCall(
      env.DB,
      {
        method,
        tool,
        era,
        scope,
        outcome,
        errorCode,
        protocolVersion,
        durationMs: Date.now() - startedAt,
        neurons,
      },
      startedAt,
    );
  } catch (error) {
    // Observability must not be able to fail a call it is only watching.
    console.error("mcp observability write failed", error);
  }
}

/** Exported for the conformance tests, which assert the advertised surface stays in step. */
export const MCP_METADATA = { SERVER_INFO, MODERN_VERSION, LEGACY_VERSION, TOOL_COUNT: TOOLS.length };
