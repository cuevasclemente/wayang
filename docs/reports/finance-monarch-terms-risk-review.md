# Monarch live private-API terms and account-risk review

Date reviewed: 2026-07-28
Scope: authoritative public terms/account guidance only; no login, source acquisition, credentials, provider request, or Finance data

## Decision

**NO-GO for live unofficial/private-API access without explicit written permission from Monarch or a supported public financial-data API.**

This is a practical contractual/account-risk assessment, not legal advice. Read-only scope, strong sandboxing, and careful credential handling reduce technical harm but do not remove Monarch's express restriction on programmatic access.

## Authoritative evidence

### Monarch Terms of Use

- URL: <https://www.monarchmoney.com/terms>
- Effective date shown by Monarch: **December 2, 2025**
- Retrieved: 2026-07-28

The terms allow only internal, personal, non-commercial use, but separately and expressly prohibit users from:

- crawling, scraping, or spidering any page, data, or portion relating to the services or content, manually or automatically;
- copying or storing a significant portion of content;
- accessing the services or their content programmatically by macro or other automated means.

The terms state that violation is grounds for termination of access. Monarch also reserves discretion to suspend or terminate an account and warns that termination may destroy associated content.

A backend MCP calling Monarch's undocumented GraphQL service is programmatic automated access. Restricting it to the maintainer's own account and read-only queries does not create an exception in the published language.

### Supported data download

- URL: <https://help.monarchmoney.com/hc/en-us/articles/15526600975764-Downloading-Transaction-or-Account-History>
- Page date shown in search index: 2025-10-18
- Retrieved/search-verified: 2026-07-28

Monarch documents supported desktop downloads for:

- one account's transactions;
- one account's balance history;
- all-account transactions from **Settings → Data**;
- all-account balances from the Accounts summary.

It states that full account balance and transaction history can be downloaded at any time, including after a subscription or trial ends. This is the supported route for local Finance-agent analysis.

### Public API status

No official public API for a customer's financial data, developer portal, or API-key program was found in Monarch's official documentation. Search results titled “Our Public API” under Monarch's status site describe the public **service-status page API**, not access to a customer's accounts or transactions.

Community clients consistently describe the financial GraphQL interface as unofficial, reverse-engineered, unsupported, and subject to change. Those secondary sources corroborate implementation risk but are not the authority for this decision.

## Risk assessment

| Risk | Assessment |
|---|---|
| Terms/account enforcement | **High** — the current terms expressly prohibit programmatic/automated access and scraping of data. |
| Account suspension or termination | **Material** — expressly reserved as a remedy; important content should not be assumed recoverable. |
| API/schema/auth drift | **High** — undocumented private GraphQL operations can change without notice. |
| Credential/session risk | **Material but technically reducible** — the proposed broker helps, but cannot make unofficial access supported. |
| Data integrity for life decisions | **Material** — Monarch disclaims accuracy/currentness; outputs require source/date checks. |
| Technical mutation risk | **Low under the proposed design** — mutation authority is absent, but this does not cure terms risk. |

## Recommended path

1. Do not acquire or stage the Monarch MCP source for live use yet.
2. Ask Monarch for explicit written permission for a personal, local, read-only integration that uses a narrowly bounded set of account/transaction/budget queries and stores credentials only in a local broker.
3. Ask whether Monarch offers or plans a supported customer-data API, OAuth integration, or another supported automation mechanism.
4. If Monarch declines or does not provide permission, use its supported CSV exports for the Finance agent.
5. If Monarch grants permission or publishes a suitable API, refresh this evidence, bind the written permission/API terms into the durable terms-risk record, and resume offline source review. Separate stage, activation, and first-read approvals remain required.

## Proposed support request

> I am a Monarch customer and want to use a private, local-only personal finance assistant to analyze my own Monarch data. The integration would be read-only, would not refresh institutions or modify Monarch data, would use a narrowly bounded set of queries, and would keep session credentials in a local credential broker rather than sharing them with an AI model. Monarch's current Terms of Use prohibit programmatic access and scraping, so I will not proceed without permission. Does Monarch offer a supported customer-data API or OAuth mechanism, or can you provide written permission for this specific local read-only use? If permission is possible, are there rate limits, approved endpoints, or other conditions I should follow?

## Decision update: supported browser exports

On 2026-07-28, the maintainer declined the unofficial private GraphQL path and selected Monarch's documented transaction/balance CSV exports instead. The maintainer explicitly accepts possible account enforcement and authorizes the Finance agent, after human login/MFA, to inspect and operate Monarch's normal authenticated UI programmatically and click the documented export controls. Hidden/private APIs, Monarch mutations/settings/refreshes, and scheduled/background automation remain forbidden.

This narrower normal-UI workflow still carries terms uncertainty; it is not represented as approved by Monarch. The downloaded supported CSV—not authenticated page scraping—is the financial-data source.

## Gate state

- Current public terms review: complete.
- Unofficial/private GraphQL: **NO-GO**.
- Supported browser-export design: authorized for synthetic implementation and later separately controlled deployment under `docs/plans/finance-browser-export-integration.md`.
- Source acquisition and staging of the private-API MCP: not authorized.
- Real Monarch login/export and Finance data: not yet authorized; first complete synthetic gate and deploy the protected export path.
