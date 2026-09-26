# Authentication and Access

Whether agents can reach your documentation at all. Documentation that returns login pages, 401/403 responses, or SSO redirects is completely invisible to agents. These checks identify the problem and look for alternative access paths.

## auth-gate-detection

Whether documentation pages require authentication to access content.

|            |                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------- |
| **Weight** | Critical (10)                                                                                 |
| **Spec**   | [auth-gate-detection](https://agentdocsspec.com/spec/web/authentication/#auth-gate-detection) |

### Why it matters

Auth-gated documentation is the most absolute barrier for agents. When agents encounter a login page or 401 response, they fall back on potentially outdated training data or seek secondary sources that may not reflect your official documentation or best practices. Competitors with ungated docs provide a better agent experience for their users.

### Results

| Result | Condition                                                                      |
| ------ | ------------------------------------------------------------------------------ |
| Pass   | Documentation pages return content without authentication                      |
| Warn   | Some pages are accessible while others require authentication (partial gating) |
| Fail   | All or most documentation pages require authentication                         |

AFDocs detects several forms of auth gating:

- **HTTP status codes**: 401 (Unauthorized) and 403 (Forbidden) responses.
- **SSO redirects**: Redirects to known SSO providers including Okta, Auth0, Microsoft login, Google Accounts, and Salesforce, plus common SSO subdomain patterns (`sso.`, `idp.`, `auth.`, `login.`).
- **Soft auth gates**: Pages returning 200 but containing login form indicators: password input fields, forms with SAML/OAuth/OpenID action URLs, or page titles starting or ending with "sign in" or "log in". A title alone only counts when the page body has no substantive documentation content (headings, prose, code blocks), so public docs about authentication, such as an API reference for a sign-in endpoint, are not mistaken for a login wall.

### How to fix

**If this check warns**, some of your docs are gated while others are public. This is common for products with tiered documentation. Consider ungating reference docs and API guides, which are the pages agents need most.

**If this check fails**, all or most docs require authentication. Consider:

- Ungating public API references and integration guides
- Providing a public `llms.txt` with links to whatever content can be public
- Shipping documentation with your SDK
- Providing an MCP server for authenticated access

The [Agent-Friendly Documentation Spec](https://agentdocsspec.com/spec/web/) covers options for making private docs agent-accessible, ordered by implementation effort.

### Score impact

This is a Critical check with two score caps:

- At 50%+ pages gated, the score is [capped at D (59)](/agent-score-calculation#score-caps).
- At 75%+ pages gated, the score is [capped at F (39)](/agent-score-calculation#score-caps).

---

## auth-alternative-access

Whether auth-gated sites provide alternative access paths agents can use.

|                |                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| **Weight**     | Medium (4)                                                                                            |
| **Depends on** | `auth-gate-detection` (warn or fail)                                                                  |
| **Spec**       | [auth-alternative-access](https://agentdocsspec.com/spec/web/authentication/#auth-alternative-access) |

### Why it matters

Sites that must gate their primary documentation can still serve agents through secondary channels. This check gives credit for agent access even when the main docs require login. It only runs when `auth-gate-detection` returns warn or fail; if your docs are public, this check is skipped.

### Results

| Result | Condition                                                                                  |
| ------ | ------------------------------------------------------------------------------------------ |
| Pass   | At least one alternative access path detected                                              |
| Warn   | Partial alternative access (e.g., public `llms.txt` covers only a subset of gated content) |
| Fail   | No alternative access paths detected                                                       |

### What the check detects

AFDocs automatically detects three forms of alternative access:

- **Public `llms.txt`**: Even if underlying docs are gated, a public `llms.txt` gives agents a navigational index.
- **Public markdown**: Pages that serve markdown via `.md` URLs or content negotiation without requiring authentication.
- **Partially accessible pages**: Some documentation pages are publicly accessible while others are gated.

Some alternative access paths can't be detected automatically: bundled SDK documentation, CLI-based doc commands, and MCP servers. These are noted in the check output as requiring manual verification.

### Other alternative access options

If the check fails, these are additional approaches worth considering (even though AFDocs can't detect them):

- **Bundled documentation**: Ship docs in your package/SDK so agents can access them locally.
- **CLI-based doc access**: Provide a CLI command that works with the developer's existing authentication (e.g., `yourproduct docs search "topic"`).
- **MCP server**: Expose documentation through tool calls with server-side authentication.

If you provide any of these, document them on a public page (a setup guide, README, or your `llms.txt` itself) so agents have a chance of discovering the alternative path. An undiscoverable alternative isn't much better than no alternative.

Because AFDocs can't detect these manual paths, you won't get score credit for them even if they're in place. If that's your situation, consider [defining a custom config](/improve-your-score#step-3-work-through-fixes-iteratively) that excludes `auth-alternative-access` so your score reflects the checks you can actually act on.

### How to fix

**If this check fails**, no alternative access paths were detected for your auth-gated content. The lowest-effort option is usually providing a public `llms.txt` that lists whatever documentation can be made available without authentication. See the [Agent-Friendly Documentation Spec](https://agentdocsspec.com/spec/web/) for the full range of options.

**If this check warns**, you have partial alternative access. Expand coverage to include more of the gated documentation, or add additional access paths.
