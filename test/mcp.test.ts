/**
 * MCP protocol conformance — deterministic, no network, no bindings, no credentials.
 *
 * These run on every pull request including forks, which is the whole reason the protocol layer
 * was written as pure functions of (headers, body). The transport rules are the part most likely
 * to be subtly wrong and the part a live smoke test is worst at catching: a client that happens to
 * send well-formed requests will never exercise the rejection paths, and the rejection paths are
 * where the specification's MUSTs live.
 *
 * The assertions below are written against MCP revision 2026-07-28, which removed the initialize
 * handshake, sessions, the GET stream, and stream resumability. Several of them fail against the
 * protocol most documentation still describes — that is the point of having them.
 *
 * Run:  npm test
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MODERN_VERSION,
  LEGACY_VERSION,
  SUPPORTED_VERSIONS,
  META_VERSION_KEY,
  RpcError,
  decodeHeaderValue,
  detectEra,
  isNotification,
  metaVersion,
  originRejected,
  validateEnvelope,
  validateModernHeaders,
  type RpcRequest,
} from "../src/mcp/protocol.ts";
import { scopeSatisfies } from "../src/mcp/auth.ts";
import { TOOLS, describeTool, parseEvalSet, toolByName, toolsForScope } from "../src/mcp/tools.ts";
import { secretMatches } from "../src/shared/secret.ts";

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────

/** A well-formed modern `tools/call`, which individual tests then break in one specific way. */
function modernCall(overrides: Partial<RpcRequest> = {}): RpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "glassbox_budget",
      arguments: {},
      _meta: {
        [META_VERSION_KEY]: MODERN_VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
    ...overrides,
  };
}

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

function modernHeaders(overrides: Record<string, string> = {}): Headers {
  return headers({
    "mcp-protocol-version": MODERN_VERSION,
    "mcp-method": "tools/call",
    "mcp-name": "glassbox_budget",
    ...overrides,
  });
}

// ── header value encoding ─────────────────────────────────────────────────────────────────────

describe("decodeHeaderValue", () => {
  test("passes a plain ASCII value through untouched", () => {
    assert.equal(decodeHeaderValue("glassbox_budget"), "glassbox_budget");
  });

  test("decodes the Base64 sentinel", () => {
    const encoded = `=?base64?${Buffer.from("Hello, 世界", "utf8").toString("base64")}?=`;
    assert.equal(decodeHeaderValue(encoded), "Hello, 世界");
  });

  test("decodes a value that was encoded only because it looks like the sentinel", () => {
    const literal = "=?base64?literal?=";
    const encoded = `=?base64?${Buffer.from(literal, "utf8").toString("base64")}?=`;
    assert.equal(decodeHeaderValue(encoded), literal);
  });

  test("returns malformed Base64 unchanged rather than throwing", () => {
    // The comparison downstream then fails and produces a HeaderMismatch, which is the specified
    // outcome. Throwing here would surface as a 500 instead.
    assert.equal(decodeHeaderValue("=?base64?not!valid!base64?="), "=?base64?not!valid!base64?=");
  });
});

// ── era detection ─────────────────────────────────────────────────────────────────────────────

describe("detectEra", () => {
  test("treats a request carrying the protocol header as modern", () => {
    assert.equal(detectEra(modernHeaders(), modernCall()), "modern");
  });

  test("treats a request carrying only _meta as modern", () => {
    assert.equal(detectEra(headers({}), modernCall()), "modern");
  });

  test("treats a bare initialize as legacy", () => {
    const body: RpcRequest = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    assert.equal(detectEra(headers({}), body), "legacy");
  });

  test("treats a legacy tools/list — no headers, no _meta — as legacy", () => {
    const body: RpcRequest = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    assert.equal(detectEra(headers({}), body), "legacy");
  });
});

describe("metaVersion", () => {
  test("reads the protocol version out of params._meta", () => {
    assert.equal(metaVersion(modernCall()), MODERN_VERSION);
  });

  test("returns undefined when _meta is absent", () => {
    assert.equal(metaVersion({ jsonrpc: "2.0", id: 1, method: "tools/list" }), undefined);
  });
});

// ── modern header validation ──────────────────────────────────────────────────────────────────

describe("validateModernHeaders", () => {
  test("accepts a well-formed request", () => {
    assert.equal(validateModernHeaders(modernHeaders(), modernCall()), null);
  });

  test("rejects a missing protocol version header", () => {
    const h = modernHeaders();
    h.delete("mcp-protocol-version");
    const failure = validateModernHeaders(h, modernCall());
    assert.equal(failure?.code, RpcError.HEADER_MISMATCH);
    assert.equal(failure?.status, 400);
  });

  test("rejects a protocol version that disagrees with the body", () => {
    const failure = validateModernHeaders(
      modernHeaders({ "mcp-protocol-version": LEGACY_VERSION }),
      modernCall(),
    );
    assert.equal(failure?.code, RpcError.HEADER_MISMATCH);
    assert.match(failure?.message ?? "", /does not match body value/);
  });

  test("reports an unsupported version separately from a mismatch", () => {
    // Both header and body say 1900-01-01, so they agree — the problem is that we do not speak it.
    // Reporting HeaderMismatch here would name the wrong problem and send the client looking in
    // the wrong place.
    const body = modernCall();
    (body.params!._meta as Record<string, unknown>)[META_VERSION_KEY] = "1900-01-01";
    const failure = validateModernHeaders(
      modernHeaders({ "mcp-protocol-version": "1900-01-01" }),
      body,
    );
    assert.equal(failure?.code, RpcError.UNSUPPORTED_VERSION);
    assert.deepEqual((failure?.data as { supported: string[] }).supported, SUPPORTED_VERSIONS);
  });

  test("rejects a body with no _meta protocol version", () => {
    const body = modernCall({ params: { name: "glassbox_budget", arguments: {} } });
    const failure = validateModernHeaders(modernHeaders(), body);
    assert.equal(failure?.code, RpcError.HEADER_MISMATCH);
    assert.match(failure?.message ?? "", /_meta/);
  });

  test("rejects a missing Mcp-Method header", () => {
    const h = modernHeaders();
    h.delete("mcp-method");
    assert.equal(validateModernHeaders(h, modernCall())?.code, RpcError.HEADER_MISMATCH);
  });

  test("rejects an Mcp-Method that disagrees with the body method", () => {
    const failure = validateModernHeaders(modernHeaders({ "mcp-method": "tools/list" }), modernCall());
    assert.equal(failure?.code, RpcError.HEADER_MISMATCH);
  });

  test("rejects a missing Mcp-Name on tools/call", () => {
    const h = modernHeaders();
    h.delete("mcp-name");
    assert.equal(validateModernHeaders(h, modernCall())?.code, RpcError.HEADER_MISMATCH);
  });

  test("rejects an Mcp-Name that disagrees with params.name", () => {
    const failure = validateModernHeaders(
      modernHeaders({ "mcp-name": "glassbox_retrieve" }),
      modernCall(),
    );
    assert.equal(failure?.code, RpcError.HEADER_MISMATCH);
  });

  test("accepts a Base64-encoded Mcp-Name that decodes to the body value", () => {
    const body = modernCall();
    (body.params as Record<string, unknown>).name = "tool wîth ünicode";
    const encoded = `=?base64?${Buffer.from("tool wîth ünicode", "utf8").toString("base64")}?=`;
    assert.equal(validateModernHeaders(modernHeaders({ "mcp-name": encoded }), body), null);
  });

  test("does not require Mcp-Name for a method that has no name to mirror", () => {
    const body: RpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: { [META_VERSION_KEY]: MODERN_VERSION } },
    };
    const h = headers({ "mcp-protocol-version": MODERN_VERSION, "mcp-method": "tools/list" });
    assert.equal(validateModernHeaders(h, body), null);
  });

  test("compares header names case-insensitively", () => {
    const h = headers({
      "MCP-Protocol-Version": MODERN_VERSION,
      "Mcp-Method": "tools/call",
      "Mcp-Name": "glassbox_budget",
    });
    assert.equal(validateModernHeaders(h, modernCall()), null);
  });
});

// ── envelope validation ───────────────────────────────────────────────────────────────────────

describe("validateEnvelope", () => {
  test("accepts a well-formed request", () => {
    assert.equal(validateEnvelope(modernCall()), null);
  });

  for (const [label, value] of [
    ["a JSON array", [{ jsonrpc: "2.0", id: 1, method: "tools/list" }]],
    ["a bare string", "tools/list"],
    ["null", null],
  ] as const) {
    test(`rejects ${label}`, () => {
      const failure = validateEnvelope(value);
      assert.equal(failure?.code, RpcError.INVALID_REQUEST);
    });
  }

  test("rejects a wrong jsonrpc version", () => {
    assert.equal(
      validateEnvelope({ jsonrpc: "1.0", id: 1, method: "tools/list" })?.code,
      RpcError.INVALID_REQUEST,
    );
  });

  test("rejects a missing method", () => {
    assert.equal(validateEnvelope({ jsonrpc: "2.0", id: 1 })?.code, RpcError.INVALID_REQUEST);
  });

  test("rejects a JSON-RPC response, which clients must not send on this transport", () => {
    const failure = validateEnvelope({ jsonrpc: "2.0", id: 1, method: "tools/list", result: {} });
    assert.equal(failure?.code, RpcError.INVALID_REQUEST);
  });
});

describe("isNotification", () => {
  test("treats a request with no id as a notification", () => {
    assert.equal(isNotification({ jsonrpc: "2.0", method: "notifications/initialized" }), true);
  });

  test("treats an explicit null id as a notification", () => {
    assert.equal(isNotification({ jsonrpc: "2.0", id: null, method: "ping" }), true);
  });

  test("treats id 0 as a request, not a notification", () => {
    // A falsy-but-present id is the classic way this check goes wrong.
    assert.equal(isNotification({ jsonrpc: "2.0", id: 0, method: "ping" }), false);
  });
});

describe("originRejected", () => {
  test("rejects any request carrying an Origin", () => {
    assert.equal(originRejected(headers({ origin: "https://evil.example" })), true);
  });

  test("accepts a request with no Origin", () => {
    assert.equal(originRejected(headers({})), false);
  });
});

// ── authorization ─────────────────────────────────────────────────────────────────────────────

describe("secretMatches", () => {
  test("accepts the exact secret", () => {
    assert.equal(secretMatches("s3cret-value", "s3cret-value"), true);
  });

  test("rejects a wrong secret of the same length", () => {
    assert.equal(secretMatches("s3cret-value", "s3cret-valuX"), false);
  });

  test("rejects a prefix of the secret", () => {
    assert.equal(secretMatches("s3cret-value", "s3cret"), false);
  });

  test("rejects everything when the secret is unset", () => {
    // An unconfigured deployment must fail closed, not authenticate the empty string.
    assert.equal(secretMatches(undefined, ""), false);
    assert.equal(secretMatches(undefined, "anything"), false);
  });
});

describe("scopeSatisfies", () => {
  test("full reaches both scopes", () => {
    assert.equal(scopeSatisfies("full", "read"), true);
    assert.equal(scopeSatisfies("full", "full"), true);
  });

  test("read reaches read only", () => {
    assert.equal(scopeSatisfies("read", "read"), true);
    assert.equal(scopeSatisfies("read", "full"), false);
  });
});

// ── the tool surface ──────────────────────────────────────────────────────────────────────────

describe("tool catalogue", () => {
  test("every tool name is unique", () => {
    const names = TOOLS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
  });

  test("every tool declares a closed object schema", () => {
    for (const tool of TOOLS) {
      assert.equal(tool.inputSchema.type, "object", `${tool.name} schema type`);
      assert.equal(
        tool.inputSchema.additionalProperties,
        false,
        `${tool.name} must reject unknown arguments`,
      );
    }
  });

  test("every declared argument carries a description", () => {
    // The description is what the model reads to decide how to call the tool; an undescribed
    // parameter is a parameter it will guess at.
    for (const tool of TOOLS) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [key, schema] of Object.entries(properties)) {
        assert.ok(schema.description, `${tool.name}.${key} needs a description`);
      }
    }
  });

  test("only the tool that spends neurons is privileged", () => {
    const privileged = TOOLS.filter((t) => t.scope === "full").map((t) => t.name);
    assert.deepEqual(privileged, ["glassbox_ask"]);
  });

  test("the read scope is not shown the tool it cannot call", () => {
    const visible = toolsForScope("read").map((t) => t.name);
    assert.ok(!visible.includes("glassbox_ask"));
    assert.equal(visible.length, TOOLS.length - 1);
  });

  test("the full scope is shown everything", () => {
    assert.equal(toolsForScope("full").length, TOOLS.length);
  });

  test("the wire shape omits the handler and the scope", () => {
    const wire = describeTool(TOOLS[0]!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(wire).sort(), ["description", "inputSchema", "name", "title"]);
  });

  test("the privileged tool's description warns about the cost", () => {
    // The model decides whether to spend based on this text alone.
    const ask = toolByName("glassbox_ask");
    assert.match(ask?.description ?? "", /SPENDS/);
    assert.match(ask?.description ?? "", /glassbox_budget/);
  });
});

describe("parseEvalSet", () => {
  test("parses one case per non-empty line", () => {
    const source = [
      '{"id":"ic-01","bucket":"in_corpus_factual","question":"q1"}',
      "",
      '  {"id":"oc-01","bucket":"out_of_corpus","question":"q2"}  ',
      "",
    ].join("\n");
    const cases = parseEvalSet(source);
    assert.equal(cases.length, 2);
    assert.equal(cases[0]?.id, "ic-01");
    assert.equal(cases[1]?.bucket, "out_of_corpus");
  });
});
