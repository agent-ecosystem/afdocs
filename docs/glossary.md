# Glossary

Terms that recur across the checks, explained for readers who write documentation rather than build documentation platforms.

## Agent

A coding agent: an AI assistant that fetches web pages on a developer's behalf, reads them, and uses what it finds to answer questions or write code. Agents fetch pages like a browser does but do not run JavaScript, and they have a limited budget for how much text they can take in at once.

## Challenge page

A page a bot-protection system shows instead of the content, asking the visitor to prove they are human ("verifying your browser", "checking your connection"). Sometimes called an interstitial. When it is served with a 200 status, an agent reads it as if it were the documentation.

## Cross-origin

On a different website (a different scheme, host, or port) from the one being tested. AFDocs never fetches cross-origin links to grade a site, because another site's availability is not this site's result.

## Curated page list

A list of pages you choose for AFDocs to check, such as an installation guide, a tutorial, and an API reference. Supply their URLs through `pages` in a config file or the `--urls` CLI option. AFDocs uses your list instead of automatically choosing the page sample. Checks that read indexes or follow links can still request other pages. See [choosing representative pages](/documentation-at-scale#maintain-a-representative-page-set) for an example.

## Hydration payload

Data that a JavaScript framework embeds inside a page, usually in script tags, so the interactive version of the page can be rebuilt in the browser. It often contains a full copy of the page's content plus menus and metadata. Readers never see it; agents download all of it. See [page-size-transfer](/checks/page-size#page-size-transfer).

## HTML path and markdown path

The two ways an agent can get a page. On the HTML path it fetches the same page a browser would and converts it to text. On the markdown path it fetches a markdown version, either by appending `.md` to the URL, by asking for markdown ([content negotiation](/checks/markdown-availability#content-negotiation)), or by following links from `llms.txt`. The markdown path is cheaper and cleaner, but only helps agents that find it.

## Product prefix

The shared beginning of page addresses for one product. For example, `https://learn.microsoft.com/en-us/dotnet/` identifies the English-language .NET section, rather than the whole Microsoft Learn site. AFDocs uses this part of the starting URL to narrow the pages it finds during discovery. It does not remove pages from a curated list or restrict every request to that section. See [defining your team's scope](/documentation-at-scale#define-the-scope-your-team-owns).

## RAG

Retrieval-augmented generation. A pipeline that cuts fetched content into chunks, stores them, and later pulls back only the chunks that seem relevant to a question. A note or a link that lands in one chunk loses the context of the content it was about.

## Representation

The form a page is delivered in: HTML for people, markdown for agents. A link that ends in `.md` promises the markdown representation; a response that delivers HTML at that address has broken that promise even when the status is 200.

## Soft 404

A page that says "not found" (or shows nothing useful) but returns a 200 success status instead of a real 404. Agents trust a 200 and try to use whatever is on the page, so a soft 404 is worse for them than a plain error. See [http-status-codes](/checks/url-stability#http-status-codes).

## Tarpit

A server response that starts but never finishes: the connection is accepted and headers arrive, then the page body is held open without being sent. The agent waits until its own timeout with no error to act on. Bot-protection systems use tarpits to slow automated clients.

## Truncation

What happens when a page is longer than an agent can take in. The agent silently keeps the beginning and drops the rest, so anything after the cut-off point, including instructions at the bottom of a page, is never seen. The [page size checks](/checks/page-size) measure how likely this is.
