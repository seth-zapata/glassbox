/**
 * Export Claude Code session transcripts to a reviewable prompt history.
 *
 * The assignment requires submitting prompt history alongside the code. This renders the
 * raw session logs into Markdown, merging multiple sessions in timestamp order.
 *
 * On redaction: the requirement is an *unsanitized* history — dead ends, corrections, and
 * wrong turns are the point and are never removed. What this strips is limited to two things:
 * credential material, and the contents of a private planning document that is referenced by
 * this project but is not part of it. Every removal is counted and reported, and the summary
 * is written into the output so a reader knows exactly what was taken out and why.
 *
 * Run:  npm run transcript
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ── Types ────────────────────────────────────────────────────────────────────

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; name: string; input: unknown; id: string }
  | { type: "tool_result"; content: unknown; tool_use_id: string; is_error?: boolean };

interface Entry {
  type: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  userFeedback?: string;
  toolDenialKind?: string;
  message?: { role: string; content: string | ContentBlock[] };
}

interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

// ── Redaction ────────────────────────────────────────────────────────────────

/** Credential patterns. These are always active and are not configurable. */
const CREDENTIAL_RULES: RedactionRule[] = [
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: "«github-token»" },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, replacement: "Bearer «token»" },
  { name: "openai-style-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, replacement: "«api-key»" },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "«aws-key»" },
  { name: "cloudflare-account-id", pattern: /\b[0-9a-f]{32}\b/g, replacement: "«account-id»" },
  { name: "oauth-pkce", pattern: /\b(code_challenge|state|code)=[A-Za-z0-9._~-]{16,}/g, replacement: "$1=«redacted»" },
  { name: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "«private-key»" },
  { name: "email-address", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "«email»" },
];

/**
 * Phrase rules live in a gitignored file, because the list would otherwise restate the very
 * content it exists to remove. The rule *categories* and hit counts are reported publicly;
 * only the literal strings stay private.
 */
function loadPrivateRules(root: string): RedactionRule[] {
  const path = join(root, "scripts", "redactions.local.json");
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    phrases?: string[];
    filePaths?: string[];
  };
  const rules: RedactionRule[] = [];
  for (const phrase of raw.phrases ?? []) {
    rules.push({
      name: "private-planning-doc",
      pattern: new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      replacement: "«redacted: private planning document»",
    });
  }
  return rules;
}

/** File paths whose read-results are dropped wholesale rather than pattern-matched. */
function loadPrivatePaths(root: string): string[] {
  const path = join(root, "scripts", "redactions.local.json");
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as { filePaths?: string[] };
  return raw.filePaths ?? [];
}

class Redactor {
  private counts = new Map<string, number>();
  private rules: RedactionRule[];

  // Written as an explicit assignment rather than a parameter property: Node's --experimental-
  // strip-types erases types without emitting code, and parameter properties need codegen.
  constructor(rules: RedactionRule[]) {
    this.rules = rules;
  }

  apply(text: string): string {
    let out = text;
    for (const rule of this.rules) {
      out = out.replace(rule.pattern, (...args) => {
        this.counts.set(rule.name, (this.counts.get(rule.name) ?? 0) + 1);
        // Support $1 backreferences in replacements.
        return rule.replacement.replace(/\$(\d)/g, (_, d) => String(args[Number(d)] ?? ""));
      });
    }
    return out;
  }

  note(name: string): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }

  report(): Array<[string, number]> {
    return [...this.counts.entries()].sort((a, b) => b[1] - a[1]);
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function readSession(path: string): Entry[] {
  const out: Entry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Entry);
    } catch {
      // A session still being written can end mid-line. Skip it rather than fail the export.
    }
  }
  return out;
}

function blocks(entry: Entry): ContentBlock[] {
  const content = entry.message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

/**
 * A `user` entry is either something the human typed or a tool result being fed back.
 * Only the former is a prompt.
 */
function isHumanPrompt(entry: Entry): boolean {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain) return false;
  const bs = blocks(entry);
  if (bs.some((b) => b.type === "tool_result")) return false;
  return bs.some((b) => b.type === "text" && b.text.trim().length > 0);
}

function textOf(entry: Entry): string {
  return blocks(entry)
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

function truncate(s: string, max: number): string {
  const clean = s.replace(/\r/g, "");
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n… [${clean.length - max} more characters]`;
}

function stringifyResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : JSON.stringify(c)))
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

// ── Rendering ────────────────────────────────────────────────────────────────

interface Options {
  includeThinking: boolean;
  maxToolResult: number;
}

/**
 * Map every tool_use id to the file path or command it targeted. A tool_result block carries
 * only the id, so matching a private file by scanning the result body would miss any read whose
 * output does not happen to echo its own path.
 */
function mapToolTargets(entries: Entry[]): Map<string, string> {
  const targets = new Map<string, string>();
  for (const entry of entries) {
    for (const block of blocks(entry)) {
      if (block.type !== "tool_use") continue;
      const input = block.input as Record<string, unknown> | undefined;
      const target = [input?.file_path, input?.command, input?.path, input?.url]
        .filter((v): v is string => typeof v === "string")
        .join(" ");
      if (target) targets.set(block.id, target);
    }
  }
  return targets;
}

function render(
  entries: Entry[],
  redactor: Redactor,
  privatePaths: string[],
  toolTargets: Map<string, string>,
  opts: Options,
): string {
  const lines: string[] = [];
  const R = (s: string) => redactor.apply(s);

  let promptNumber = 0;

  for (const entry of entries) {
    if (entry.isSidechain) continue;

    if (isHumanPrompt(entry)) {
      promptNumber++;
      const ts = entry.timestamp ? new Date(entry.timestamp).toISOString().replace("T", " ").slice(0, 19) : "";
      lines.push("");
      lines.push("---");
      lines.push("");
      lines.push(`## Prompt ${promptNumber}`);
      lines.push("");
      lines.push(`<sub>${ts} UTC</sub>`);
      lines.push("");
      lines.push(
        R(textOf(entry))
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n"),
      );
      lines.push("");
      continue;
    }

    // A rejected tool call carries the human's reason for stopping it — that is direction-setting
    // and belongs in the history.
    if (entry.type === "user" && entry.userFeedback) {
      lines.push("");
      lines.push(`> 🛑 **Interrupted by user:** ${R(entry.userFeedback)}`);
      lines.push("");
      continue;
    }

    // Tool results arrive as `user` entries, so both roles must be walked. Skipping non-assistant
    // entries here would silently drop every tool result in the log.
    if (entry.type !== "assistant" && entry.type !== "user") continue;

    for (const block of blocks(entry)) {
      if (block.type === "thinking") {
        // Reasoning text is not retained in the session log — these blocks carry only a
        // signature — so there is nothing to render.
        if (!opts.includeThinking || !block.thinking?.trim()) continue;
        lines.push("<details><summary><i>reasoning</i></summary>");
        lines.push("");
        lines.push(R(truncate(block.thinking, 4000)));
        lines.push("");
        lines.push("</details>");
        lines.push("");
      } else if (block.type === "text") {
        const t = block.text.trim();
        if (t) {
          lines.push(R(t));
          lines.push("");
        }
      } else if (block.type === "tool_use") {
        const input = block.input as Record<string, unknown> | undefined;
        const hint =
          (input?.file_path as string) ??
          (input?.command as string) ??
          (input?.url as string) ??
          (input?.pattern as string) ??
          "";
        const label = hint ? `${block.name} — ${truncate(String(hint), 160)}` : block.name;
        lines.push(`\`\`\`text`);
        lines.push(`⚙ ${R(label)}`);
        lines.push("```");
        lines.push("");
      } else if (block.type === "tool_result") {
        const raw = stringifyResult(block.content);
        // Match on what the call targeted (authoritative), then fall back to scanning the body
        // for a path reference, which catches shell pipelines that read the file indirectly.
        const target = toolTargets.get(block.tool_use_id) ?? "";
        const isPrivate = privatePaths.some(
          (p) => target.includes(p) || target.includes(basename(p)) || raw.includes(basename(p)),
        );
        if (isPrivate) {
          redactor.note("private-planning-doc (whole tool result)");
          lines.push("> _[tool result withheld — contents of a private planning document]_");
          lines.push("");
          continue;
        }
        lines.push("<details><summary>result</summary>");
        lines.push("");
        lines.push("```text");
        lines.push(R(truncate(raw, opts.maxToolResult)));
        lines.push("```");
        lines.push("");
        lines.push("</details>");
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const repoRoot = process.cwd();
  const outDir = getArg("--out") ?? join(repoRoot, "transcripts");

  // Session logs are keyed by the slugified working directory, so this project spans two
  // directories: the scoping session ran from the parent folder, every session since from the
  // project itself. Both are included — dropping the first would lose the design decisions.
  const defaultDirs = [
    join(homedir(), ".claude", "projects", "-home-sethz-projects"),
    join(homedir(), ".claude", "projects", "-home-sethz-projects-glassbox"),
  ];
  const dirs = (getArg("--dirs")?.split(",") ?? defaultDirs).filter((d) => existsSync(d));

  if (dirs.length === 0) {
    console.error("No transcript directories found.");
    process.exit(1);
  }

  const files: string[] = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".jsonl")) files.push(join(dir, name));
    }
  }

  const entries = files
    .flatMap(readSession)
    .filter((e) => e.timestamp)
    .sort((a, b) => (a.timestamp! < b.timestamp! ? -1 : a.timestamp! > b.timestamp! ? 1 : 0));

  const redactor = new Redactor([...CREDENTIAL_RULES, ...loadPrivateRules(repoRoot)]);
  const privatePaths = loadPrivatePaths(repoRoot);

  const body = render(entries, redactor, privatePaths, mapToolTargets(entries), {
    includeThinking: !args.includes("--no-thinking"),
    maxToolResult: Number(getArg("--max-result") ?? 2500),
  });

  const sessions = new Set(entries.map((e) => e.sessionId).filter(Boolean));
  const promptCount = entries.filter(isHumanPrompt).length;
  const first = entries[0]?.timestamp?.slice(0, 10) ?? "?";
  const last = entries.at(-1)?.timestamp?.slice(0, 10) ?? "?";
  const report = redactor.report();

  const header = [
    "# Prompt history",
    "",
    "Complete Claude Code session history for this project, rendered from the raw session logs.",
    "",
    `- **Sessions:** ${sessions.size} across ${files.length} log file(s)`,
    `- **Human prompts:** ${promptCount}`,
    `- **Date range:** ${first} → ${last}`,
    `- **Generated by:** \`scripts/export-transcript.ts\` (committed — the rendering is reproducible)`,
    "",
    "## What was removed",
    "",
    "Nothing about how the software was designed or built has been removed — including the",
    "wrong turns, the corrections, and the approaches that were tried and abandoned. Two",
    "categories are stripped automatically:",
    "",
    "1. **Credential material** — tokens, keys, account identifiers, OAuth parameters, email addresses.",
    "2. **A private planning document** — a personal document referenced during scoping that is not",
    "   part of this project. Its contents are removed; the fact of its removal is marked inline.",
    "",
    report.length > 0
      ? ["| Rule | Occurrences |", "|---|---|", ...report.map(([n, c]) => `| \`${n}\` | ${c} |`)].join("\n")
      : "_No redactions were triggered._",
    "",
    "---",
  ].join("\n");

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "PROMPT_HISTORY.md");
  writeFileSync(outPath, `${header}\n${body}\n`);

  console.log(`Wrote ${outPath}`);
  console.log(`  sessions: ${sessions.size}   prompts: ${promptCount}   entries: ${entries.length}`);
  if (report.length) {
    console.log("  redactions:");
    for (const [name, count] of report) console.log(`    ${name.padEnd(38)} ${count}`);
  } else {
    console.log("  redactions: none");
  }
}

main();
