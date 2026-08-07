/**
 * Fetch the corpus from Cloudflare's documentation source.
 *
 * The corpus is Cloudflare Registrar documentation, which is published under CC BY 4.0 (verified
 * against the LICENSE in cloudflare/cloudflare-docs). That license permits redistribution with
 * attribution, so every corpus document carries its source URL and the license is recorded in
 * corpus/NOTICE.md.
 *
 * Source .mdx files are fetched rather than scraped from the rendered site: the markdown is the
 * original, and it avoids navigation chrome that would pollute retrieval with boilerplate.
 *
 * Run:  npm run corpus:fetch
 */

import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = "cloudflare/cloudflare-docs";
const BASE = "src/content/docs/registrar";
const SITE = "https://developers.cloudflare.com/registrar";

/** Paths relative to BASE. Curated rather than crawled — index pages are navigation, not content. */
const SOURCES = [
  "about.mdx",
  "faq.mdx",
  "troubleshooting.mdx",
  "whoisrequests.mdx",
  "custom-domain-protection.mdx",
  "get-started/register-domain.mdx",
  "get-started/transfer-domain-to-cloudflare.mdx",
  "get-started/enable-dnssec.mdx",
  "account-options/domain-management.mdx",
  "account-options/domain-contact-updates.mdx",
  "account-options/renew-domains.mdx",
  "account-options/transfer-out-from-cloudflare.mdx",
  "account-options/inter-account-transfer.mdx",
  "account-options/whois-redaction.mdx",
  "account-options/domain-ownership-certificate.mdx",
  "account-options/icloud-domains.mdx",
  "top-level-domains/uk-domains.mdx",
  "top-level-domains/us-domains.mdx",
];

function fetchRaw(path: string): string {
  return execFileSync(
    "gh",
    ["api", `repos/${REPO}/contents/${BASE}/${path}`, "-H", "Accept: application/vnd.github.raw"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
}

interface Parsed {
  title: string;
  body: string;
}

/**
 * Strip MDX down to prose.
 *
 * Astro/Starlight components, import statements, and JSX carry no answerable content but do
 * carry tokens — leaving them in would let a chunk match a query on component names rather than
 * on meaning, which is exactly the retrieval failure the evaluation is meant to catch.
 */
function parseMdx(raw: string): Parsed {
  let title = "";
  let body = raw;

  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm?.[1]) {
    const t = fm[1].match(/^title:\s*(.+)$/m);
    if (t?.[1]) title = t[1].replace(/^["']|["']$/g, "").trim();
    body = raw.slice(fm[0].length);
  }

  body = body
    .replace(/^import\s+.*$/gm, "")
    .replace(/<\/?(Render|PackageManagers|Tabs|TabItem|Details|Aside|Card|CardGrid|LinkButton|Steps|GlossaryTooltip|Example|APIRequest|Badge|Stream|WranglerConfig|TypeScriptExample|DirectoryListing|FileTree|AnchorHeading|Width|Feature)\b[^>]*\/?>/g, "")
    .replace(/<\/?[A-Z][A-Za-z0-9]*\b[^>]*\/?>/g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^:::.*$/gm, "")
    // Markdown links: keep the text, drop the target.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, body };
}

function slugOf(path: string): string {
  return path.replace(/\.mdx$/, "").replace(/\//g, "-");
}

function sourceUrlOf(path: string): string {
  const p = path.replace(/\.mdx$/, "").replace(/\/index$/, "");
  return `${SITE}/${p}/`;
}

function main(): void {
  const outDir = join(process.cwd(), "corpus", "docs");
  if (existsSync(outDir)) rmSync(outDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  let totalChars = 0;
  const written: Array<{ id: string; title: string; chars: number }> = [];

  for (const path of SOURCES) {
    const { title, body } = parseMdx(fetchRaw(path));
    if (body.length < 200) {
      console.warn(`  skipped ${path} — only ${body.length} chars after cleaning`);
      continue;
    }
    const id = slugOf(path);
    const doc = [
      "---",
      `id: ${id}`,
      `title: ${JSON.stringify(title || id)}`,
      `source_url: ${sourceUrlOf(path)}`,
      `source_file: ${BASE}/${path}`,
      "license: CC-BY-4.0",
      "attribution: © Cloudflare, Inc. Cloudflare Docs, licensed under CC BY 4.0.",
      "---",
      "",
      body,
      "",
    ].join("\n");

    writeFileSync(join(outDir, `${id}.md`), doc);
    totalChars += body.length;
    written.push({ id, title: title || id, chars: body.length });
  }

  console.log(`\nWrote ${written.length} documents to corpus/docs/`);
  for (const w of written) console.log(`  ${String(w.chars).padStart(6)}  ${w.id}`);
  console.log(`\n  total prose: ${totalChars.toLocaleString()} chars (~${Math.round(totalChars / 4).toLocaleString()} tokens)`);
}

main();
