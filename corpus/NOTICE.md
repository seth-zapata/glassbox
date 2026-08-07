# Corpus provenance and license

The corpus in `corpus/docs/` is **Cloudflare Registrar documentation**, redistributed here under
its published license.

## License

Cloudflare's documentation is licensed under
**[Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)**,
per the `LICENSE` file in [cloudflare/cloudflare-docs](https://github.com/cloudflare/cloudflare-docs).
That license permits redistribution and adaptation, including commercially, provided attribution
is given and changes are indicated.

> © Cloudflare, Inc. — Cloudflare Docs, licensed under CC BY 4.0.

## Attribution and changes

Every file in `corpus/docs/` carries front-matter recording its `source_url`, the exact
`source_file` it came from in the upstream repository, and the license.

**Changes made:** the documents are reproduced from the upstream `.mdx` sources with formatting
removed — import statements, Astro/Starlight components, JSX, and directive blocks are stripped,
and markdown link targets are dropped while the link text is kept. No prose was rewritten. The
transformation is performed by [`scripts/fetch-corpus.ts`](../scripts/fetch-corpus.ts) and is
reproducible with `npm run corpus:fetch`.

Component markup is removed rather than left in place because it contributes tokens without
contributing meaning — a chunk that matched a query on a component name rather than on its
content would be a retrieval failure this project exists to measure.

## Why this corpus

A narrow, fixed corpus is what makes the refusal metric meaningful. Registrar policy has precise,
checkable facts — transfer locks, grace periods, EPP status codes, auth codes — of exactly the
kind an ungrounded language model states confidently and wrongly. It also makes out-of-corpus
questions unambiguous: "how do I configure Workers KV" is plainly outside a registrar-policy
corpus, so the held-out set isn't arbitrary.

## Not included

ICANN policy documents were considered and are **not** included. `icann.org` returns HTTP 403 to
automated requests, and working around a site's bot protection to harvest its content is not
something this project does. Where ICANN rules matter — the 60-day post-transfer lock, change-of-
registrant locks — they appear as described in Cloudflare's own documentation, which is properly
licensed for reuse.
