---
id: get-started-enable-dnssec
title: "Enable DNSSEC"
source_url: https://developers.cloudflare.com/registrar/get-started/enable-dnssec/
source_file: src/content/docs/registrar/get-started/enable-dnssec.mdx
license: CC-BY-4.0
attribution: © Cloudflare, Inc. Cloudflare Docs, licensed under CC BY 4.0.
---

The domain name system (DNS) translates domain names into numeric Internet addresses. However, DNS is a fundamentally insecure protocol. It does not guarantee where DNS records come from and accepts any requests given to it.

DNSSEC creates a secure layer to the domain name system by adding cryptographic signatures to DNS records. By doing so, your request can check the signature to verify that the record you need comes from the authoritative nameserver and was not altered along the way.

## Enable or disable DNSSEC

If your domain is not on Cloudflare Registrar, you can enable DNSSEC in **DNS** on the Cloudflare dashboard.

## Confirming DNSSEC
