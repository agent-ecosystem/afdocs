# redirect-behavior check: real-site results

Tested 2026-03-11 against live docs sites to validate the redirect-behavior check implementation.

## Results by classification

### no-redirect (pass)

- **Stripe** (docs.stripe.com) - 5 sampled pages, all clean 200s
- **React** (react.dev) - 5 sampled pages, all clean 200s
- **Neon** (neon.tech/docs) - 5 sampled pages, all clean 200s
- **Firebase** (firebase.google.com/docs) - 3 sampled pages, all clean 200s
- **Microsoft Learn** (learn.microsoft.com) - 3 sampled pages, all clean 200s
- **Kotlin** (kotlinlang.org/docs) - 3 sampled pages, all clean 200s
- **AWS** (docs.aws.amazon.com) - 3 sampled pages, all clean 200s
- **Vue.js** (vuejs.org) - 3 sampled pages, all clean 200s
- **GitHub Docs** (docs.github.com) - 3 sampled pages, all clean 200s

### same-host (pass)

- **MDN** (developer.mozilla.org) - redirects to `/en-US/` (locale prefix)
- **Oracle** (docs.oracle.com/en/java) - trailing slash normalization
- **Swagger** (swagger.io/docs) - trailing slash normalization
- **Expo** (docs.expo.dev) - 2 of 3 sampled pages redirect to add trailing slash

### cross-host (warn)

- **Anthropic** (docs.anthropic.com) - redirects to `platform.claude.com/docs/`
- **Angular** (angular.io/docs) - redirects to `v17.angular.io/docs`
- **Terraform** (www.terraform.io/docs) - redirects to `developer.hashicorp.com/terraform/docs`

### js-redirect (fail)

- **Expo** (docs.expo.dev) - YouTube link in llms.txt contains JS redirect patterns in its HTML. This is a true positive (YouTube pages use `window.location`) but flags an external link from llms.txt rather than a docs page itself. May warrant discussion about whether to scope the check to same-origin pages only.

## Notes

- Cross-host redirects are a known agent failure mode. Claude Code, for example, doesn't follow cross-host redirects as a security measure.
- The Anthropic, Angular, and Terraform cases are all domain migrations where old URLs redirect to new hosts.
- The JS redirect detection flagging YouTube is correct behavior but highlights that llms.txt can contain links to external sites that aren't docs pages.
