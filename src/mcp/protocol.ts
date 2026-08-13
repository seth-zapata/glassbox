/**
 * MCP wire protocol — pure logic, no bindings.
 *
 * Everything here is a function of (headers, body) with no I/O, which is the point: the protocol
 * is the part most likely to be subtly wrong, and it is also the part that can be tested for free
 * on every pull request. The transport rules below are implemented against the specification
 * rather than recalled, because the specification moved: revision 2026-07-28 removed the
 * `initialize` handshake, protocol-level sessions, the standalone GET stream, server-initiated
 * requests, and `Last-Event-ID` resumability. Guidance written before that revision — including
 * most of what a model has memorised — describes a protocol this file does not implement.
 *
 * Two eras therefore exist, and this server speaks both:
 *
 *   modern (2026-07-28+)  every request carries its own protocol version and client capabilities
 *                         in `_meta`, mirrored into HTTP headers. No handshake, no session, no
 *                         state. A single POST in, a single JSON object out.
 *   legacy (<= 2025-11-25) the client opens with `initialize` and expects a session.
 *
 * Supporting only the modern era would be spec-perfect and useless: the compatibility matrix is
 * explicit that a legacy client against a modern-only server *fails*, and legacy clients have no
 * fall-forward mechanism. Every MCP client shipping today opens with `initialize`. Supporting only
 * the legacy era would be obsolete on arrival. So: dual-era, selected by how the client opens.
 */

/** Modern revision this server implements. Per-request metadata, stateless. */
export const MODERN_VERSION = "2026-07-28";

/** Newest handshake-based revision this server answers for older clients. */
export const LEGACY_VERSION = "2025-11-25";

/** Advertised to clients in `server/discover` and in UnsupportedProtocolVersionError. */
export const SUPPORTED_VERSIONS = [MODERN_VERSION, LEGACY_VERSION];

/** `_meta` key carrying the protocol version in the request body. */
export const META_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

/**
 * JSON-RPC error codes.
 *
 * -32700..-32600 are JSON-RPC's own. -32020 and -32022 are allocated by the MCP specification
 * from its reserved sub-range. -32001 is implementation-defined and used here for authorization
 * failures, which the specification leaves to the server: it requires authentication but does not
 * dictate how a refusal is spelled.
 */
export const RpcError = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** MCP: headers do not match the body, or a required header is missing/malformed. */
  HEADER_MISMATCH: -32020,
  /** MCP: the requested protocol version is not implemented. */
  UNSUPPORTED_VERSION: -32022,
  /** Implementation-defined: missing, unknown, or insufficiently scoped credential. */
  UNAUTHORIZED: -32001,
} as const;

export type Era = "modern" | "legacy";

export interface RpcRequest {
  jsonrpc: "2.0";
  /** Absent on notifications. A notification gets 202 and no body. */
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface ProtocolFailure {
  /** HTTP status to send alongside the JSON-RPC error body. */
  status: number;
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Decode the Base64 sentinel used for header values that are not plain ASCII.
 *
 * The specification requires servers to decode `=?base64?...?=` before comparing a header to the
 * body, and requires clients to encode even a plain-ASCII value that happens to look like the
 * sentinel. Skipping this would make the server reject perfectly conformant clients whose tool
 * arguments contain a non-ASCII character — a bug that would only ever appear in production and
 * only for some inputs.
 */
export function decodeHeaderValue(raw: string): string {
  if (!raw.startsWith("=?base64?") || !raw.endsWith("?=")) return raw;
  const encoded = raw.slice("=?base64?".length, -"?=".length);
  try {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    // Malformed Base64 is a header-validation failure, not a crash. Returning the raw value
    // makes the comparison below fail, which produces the HeaderMismatch the spec asks for.
    return raw;
  }
}

/** Body `_meta` protocol version, if the client sent one. */
export function metaVersion(body: RpcRequest): string | undefined {
  const meta = body.params?._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const version = (meta as Record<string, unknown>)[META_VERSION_KEY];
  return typeof version === "string" ? version : undefined;
}

/**
 * Is this protocol version a modern (per-request metadata) one?
 *
 * Protocol versions are ISO 8601 dates, which sort lexicographically, so a string comparison is a
 * chronological one. That matters for revisions released after this code was written: a client
 * declaring 2027-01-01 is treated as modern and answered with an UnsupportedProtocolVersionError
 * naming what we do speak, rather than being silently misread as legacy and failing obscurely.
 */
export function isModernVersion(version: string): boolean {
  return version >= MODERN_VERSION;
}

/**
 * Which era the client is speaking.
 *
 * **`MCP-Protocol-Version` is not a modern marker.** It was introduced in revision 2025-06-18 —
 * a legacy revision — so every legacy client from that revision onward sends it on requests after
 * the handshake. An earlier version of this function treated the header's mere presence as modern,
 * which produced a bug no conformance test could catch: MCP Inspector's `initialize` succeeded on
 * the legacy path, and then its very next request was rejected with a HeaderMismatch demanding
 * `_meta` that a legacy client has no reason to send. Both halves conformed; the interaction did
 * not.
 *
 * The only unambiguous modern markers are `_meta` carrying a protocol version, or a header
 * declaring a version at or after the modern revision.
 */
export function detectEra(headers: Headers, body: RpcRequest): Era {
  if (metaVersion(body) !== undefined) return "modern";
  const header = headers.get("mcp-protocol-version");
  if (header !== null && isModernVersion(header)) return "modern";
  return "legacy";
}

/**
 * The protocol version the client declared, from either carrier.
 *
 * Recorded against every call so "which era do real clients actually speak" is answered by data
 * rather than by reading changelogs — the question that produced the bug above.
 */
export function declaredVersion(headers: Headers, body: RpcRequest): string | null {
  return metaVersion(body) ?? headers.get("mcp-protocol-version") ?? null;
}

/** Methods whose `Mcp-Name` header mirrors a body field, and which field that is. */
const NAMED_METHODS: Record<string, "name" | "uri"> = {
  "tools/call": "name",
  "resources/read": "uri",
  "prompts/get": "name",
};

/**
 * Validate the mirrored headers a modern request must carry.
 *
 * The mirroring exists so intermediaries can route and rate-limit without parsing bodies; the
 * validation exists so a load balancer acting on the header and a server acting on the body can
 * never disagree. That is a real vulnerability class, not ceremony, which is why the spec makes
 * rejection mandatory rather than advisory.
 *
 * Returns null when the request is well-formed.
 */
export function validateModernHeaders(headers: Headers, body: RpcRequest): ProtocolFailure | null {
  const mismatch = (message: string): ProtocolFailure => ({
    status: 400,
    code: RpcError.HEADER_MISMATCH,
    message,
  });

  const headerVersion = headers.get("mcp-protocol-version");
  if (headerVersion === null) {
    return mismatch("MCP-Protocol-Version header is required");
  }

  const bodyVersion = metaVersion(body);
  if (bodyVersion === undefined) {
    return mismatch(`request body is missing params._meta["${META_VERSION_KEY}"]`);
  }
  if (headerVersion !== bodyVersion) {
    return mismatch(
      `MCP-Protocol-Version header '${headerVersion}' does not match body value '${bodyVersion}'`,
    );
  }

  // Version support is checked after the headers agree: reporting "unsupported version" for a
  // request whose two version fields disagree would name the wrong problem.
  if (!SUPPORTED_VERSIONS.includes(headerVersion)) {
    return {
      status: 400,
      code: RpcError.UNSUPPORTED_VERSION,
      message: "Unsupported protocol version",
      data: { supported: SUPPORTED_VERSIONS, requested: headerVersion },
    };
  }

  const headerMethod = headers.get("mcp-method");
  if (headerMethod === null) return mismatch("Mcp-Method header is required");
  if (headerMethod !== body.method) {
    return mismatch(
      `Mcp-Method header '${headerMethod}' does not match body method '${body.method}'`,
    );
  }

  const nameField = NAMED_METHODS[body.method];
  if (nameField) {
    const rawHeaderName = headers.get("mcp-name");
    if (rawHeaderName === null) {
      return mismatch(`Mcp-Name header is required for ${body.method}`);
    }
    const headerName = decodeHeaderValue(rawHeaderName);
    const bodyName = body.params?.[nameField];
    if (typeof bodyName !== "string") {
      return mismatch(`${body.method} requires params.${nameField}`);
    }
    if (headerName !== bodyName) {
      return mismatch(
        `Mcp-Name header '${headerName}' does not match body value '${bodyName}'`,
      );
    }
  }

  // No tool in this server annotates a parameter with `x-mcp-header`, so no `Mcp-Param-*` header
  // is expected and none is validated. Adding an annotation later makes that validation mandatory.
  return null;
}

/**
 * Reject a body that is not a single JSON-RPC request or notification.
 *
 * Clients must not send JSON-RPC *responses* on this transport, and this revision defines no
 * batching, so anything that is not one well-formed request object is invalid.
 */
export function validateEnvelope(body: unknown): ProtocolFailure | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      status: 400,
      code: RpcError.INVALID_REQUEST,
      message: "body must be a single JSON-RPC request object",
    };
  }
  const candidate = body as Record<string, unknown>;
  if (candidate.jsonrpc !== "2.0") {
    return {
      status: 400,
      code: RpcError.INVALID_REQUEST,
      message: 'jsonrpc must be "2.0"',
    };
  }
  if (typeof candidate.method !== "string" || candidate.method.length === 0) {
    return {
      status: 400,
      code: RpcError.INVALID_REQUEST,
      message: "method is required",
    };
  }
  if ("result" in candidate || "error" in candidate) {
    return {
      status: 400,
      code: RpcError.INVALID_REQUEST,
      message: "clients must not send JSON-RPC responses on this transport",
    };
  }
  return null;
}

/** A request with no `id` is a notification: acknowledged with 202 and no body. */
export function isNotification(body: RpcRequest): boolean {
  return body.id === undefined || body.id === null;
}

/**
 * Reject cross-origin browser traffic.
 *
 * The specification makes Origin validation a MUST because an MCP endpoint that answers requests
 * from arbitrary web pages is reachable by DNS rebinding. This server is a bearer-token API with
 * no browser client, so the safe rule is simple: a request that carries an Origin at all is
 * coming from a page, and there is no page that should be calling it.
 */
export function originRejected(headers: Headers): boolean {
  return headers.get("origin") !== null;
}
