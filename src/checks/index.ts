// Import all check modules to trigger registration

// Category 1: Content Discoverability
import './content-discoverability/llms-txt-exists.js';
import './content-discoverability/llms-txt-valid.js';
import './content-discoverability/llms-txt-size.js';
import './content-discoverability/llms-txt-links-resolve.js';
import './content-discoverability/llms-txt-links-markdown.js';
import './content-discoverability/llms-txt-directive-html.js';
import './content-discoverability/llms-txt-directive-md.js';

// Category 2: Markdown Availability
import './markdown-availability/markdown-url-support.js';
import './markdown-availability/content-negotiation.js';

// Category 3: Page Size
import './page-size/rendering-strategy.js';
import './page-size/page-size-markdown.js';
import './page-size/page-size-html.js';
import './page-size/content-start-position.js';

// Category 4: Content Structure
import './content-structure/tabbed-content-serialization.js';
import './content-structure/section-header-quality.js';
import './content-structure/markdown-code-fence-validity.js';

// Category 5: URL Stability
import './url-stability/http-status-codes.js';
import './url-stability/redirect-behavior.js';

// Category 6: Observability
import './observability/llms-txt-coverage.js';
import './observability/markdown-content-parity.js';
import './observability/cache-header-hygiene.js';

// Category 7: Authentication
import './authentication/auth-gate-detection.js';
import './authentication/auth-alternative-access.js';
// Registered last on purpose: it is evaluated from the fetch ledger the other
// checks fill, so it must run after every other selected check.
import './authentication/bot-protection-interference.js';

export { getCheck, getAllChecks, getChecksSorted } from './registry.js';
export { extractMarkdownLinks } from './content-discoverability/llms-txt-valid.js';
