/**
 * Chinese (zh) message catalog. Missing keys fall back to English via `t()`.
 */
export const zh: Record<string, string> = {
  'runner.skip_excluded': '检查已跳过（通过 --skip-checks 排除）',
  'runner.skip_dependency': '已跳过：依赖检查未通过',
  'runner.check_error': '检查错误：{error}',
  'common.sampled_pages': '抽样页面',
  'common.pages': '页面',
  'common.link': '链接',
  'common.links': '链接',
  'common.sampled_links': '抽样链接',
  'common.fetch_errors_suffix': '；{count} 个抓取失败',
  'common.rate_limited_suffix': '；{count} 个被限流（HTTP 429）',
  'check.llms-txt-exists.fail_explicit':
    '在通过 --llms-txt-url 指定的地址未找到 llms.txt（{url}）{redirectNote}{suffix}',
  'check.llms-txt-exists.fail_candidates':
    '在任何候选位置都未找到 llms.txt（{candidates}）{redirectNote}{suffix}',
  'check.llms-txt-exists.redirect_note':
    '；候选地址跨主机重定向到 {origins}（智能体无法跟随跨主机重定向）',
  'check.llms-txt-exists.warn_cross_host':
    '已找到 llms.txt，但只能通过跨主机重定向访问（智能体可能不会跟随）{suffix}',
  'check.llms-txt-exists.pass_explicit': '在 {url} 找到 llms.txt（由 --llms-txt-url 指定）',
  'check.llms-txt-exists.pass_single': '在 {url} 找到 llms.txt',
  'check.llms-txt-exists.pass_multi_canonical':
    '在 {count} 个位置找到 llms.txt；使用 {url} 作为规范地址',
  'check.llms-txt-exists.pass_multi': '在 {count} 个位置找到 llms.txt',
  'check.llms-txt-valid.skip_none': '没有可校验的 llms.txt 文件',
  'check.llms-txt-valid.pass': 'llms.txt 遵循建议结构（H1、引用块、按标题分隔的链接章节）',
  'check.llms-txt-valid.warn': 'llms.txt 含有可解析链接，但未完全遵循建议结构：{issues}',
  'check.llms-txt-valid.fail': 'llms.txt 存在但没有可解析链接',
  'check.llms-txt-size.skip_none': '没有可测量的 llms.txt 文件',
  'check.llms-txt-size.pass': 'llms.txt 为 {size} 字符（低于 {pass} 阈值）',
  'check.llms-txt-size.warn': 'llms.txt 为 {size} 字符（介于 {pass} 与 {fail} 之间；建议拆分）',
  'check.llms-txt-size.fail': 'llms.txt 为 {size} 字符（超过 {fail} 阈值；将被大多数智能体截断）',
  'check.llms-txt-links-resolve.skip_none': '没有可检查链接的 llms.txt 文件',
  'check.llms-txt-links-resolve.skip_filtered': 'llms.txt 含有 {count} 个链接，但都不在 {path} 下',
  'check.llms-txt-links-resolve.skip_no_http': 'llms.txt 中未找到 HTTP(S) 链接',
  'check.llms-txt-links-resolve.pass_external':
    '全部 {count} 个链接均为外部链接且可解析（共 {total} 个链接）',
  'check.llms-txt-links-resolve.warn_external':
    '全部链接均为外部链接；{resolved}/{total} 可解析（{broken} 个失败；可能是机器人检测或限流）',
  'check.llms-txt-links-resolve.pass':
    '全部 {sameCount} 个同源 {linkLabel} 可解析（共 {total} 个链接）{suffix}{crossNote}',
  'check.llms-txt-links-resolve.warn':
    '{resolved}/{sameCount} 个同源 {linkLabel} 可解析（{rate}%）；{broken} 个失效{suffix}{crossNote}',
  'check.llms-txt-links-resolve.fail':
    '仅 {resolved}/{sameCount} 个同源 {linkLabel} 可解析（{rate}%）；{broken} 个失效{suffix}{crossNote}',
  'check.llms-txt-links-markdown.skip_none': '没有可检查链接的 llms.txt 文件',
  'check.llms-txt-links-markdown.skip_external':
    '全部 {total} 个链接均为外部链接；无法评估 Markdown 支持',
  'check.llms-txt-links-markdown.pass':
    '{markdown}/{total} 个同源 {linkLabel} 指向 Markdown 内容（{rate}%）{suffix}{crossNote}',
  'check.llms-txt-links-markdown.warn_variants':
    '同源链接指向 HTML，但有 {count} 个可用 .md 变体{suffix}{crossNote}',
  'check.llms-txt-links-markdown.fail':
    '同源链接指向 HTML，且未检测到 Markdown 替代{suffix}{crossNote}',
  'check.llms-txt-directive-html.error_none': '无法测试任何页面{suffix}',
  'check.llms-txt-directive-html.fail_none':
    '在全部 {count} 个{pageLabel}的 HTML 中均未找到 llms.txt 指引{suffix}',
  'check.llms-txt-directive-html.warn_buried':
    '在 {found}/{total} 个{pageLabel}的 HTML 中找到 llms.txt 指引，但位置过深（超过内容的 20%）{suffix}',
  'check.llms-txt-directive-html.warn_partial':
    '在 {found}/{total} 个{pageLabel}的 HTML 中找到 llms.txt 指引（缺少 {missing} 个）{suffix}',
  'check.llms-txt-directive-html.pass':
    '全部 {total} 个{pageLabel}的 HTML 中均找到 llms.txt 指引{nearTop}{suffix}',
  'check.llms-txt-directive-html.near_top': '，且靠近内容顶部',
  'check.llms-txt-directive-md.no_md_suffix': '；{count} 个没有 Markdown 版本',
  'check.llms-txt-directive-md.error_none': '无法获取全部 {count} 个页面的 Markdown{suffix}',
  'check.llms-txt-directive-md.fail_none':
    '在全部 {count} 个{pageLabel}的 Markdown 中均未找到 llms.txt 指引{suffix}',
  'check.llms-txt-directive-md.warn_buried':
    '在 {found}/{total} 个{pageLabel}的 Markdown 中找到 llms.txt 指引，但位置过深（超过内容的 20%）{suffix}',
  'check.llms-txt-directive-md.warn_partial':
    '在 {found}/{total} 个{pageLabel}的 Markdown 中找到 llms.txt 指引（缺少 {missing} 个）{suffix}',
  'check.llms-txt-directive-md.pass':
    '全部 {total} 个{pageLabel}的 Markdown 中均找到 llms.txt 指引{nearTop}{suffix}',
  'check.llms-txt-directive-md.near_top': '，且靠近内容顶部',
  'check.markdown-url-support.pass':
    '{supported}/{total} 个{pageLabel}支持 .md URL（{rate}%）{suffix}',
  'check.markdown-url-support.warn':
    '{supported}/{total} 个{pageLabel}支持 .md URL（{rate}%）；支持不一致{suffix}',
  'check.markdown-url-support.fail': '没有{pageLabel}支持 .md URL（已测 0/{total}）{suffix}',
  'check.content-negotiation.pass':
    '{correct}/{total} 个{pageLabel}支持内容协商（{rate}%）{suffix}',
  'check.content-negotiation.warn':
    '内容协商部分支持：{correct} 个类型正确，{wrong} 个类型错误，{htmlOnly} 个仅 HTML{suffix}',
  'check.content-negotiation.fail':
    '服务器忽略 Accept: text/markdown 头（0/{total} 个{pageLabel}返回 Markdown）{suffix}',
  'check.page-size-markdown.skip_no_md': '站点不提供 Markdown；跳过 Markdown 体积检查',
  'check.page-size-markdown.skip_none': '没有可测量的 Markdown 页面',
  'check.page-size-markdown.pass':
    '全部 {total} 个{pageLabel}低于 {pass} 字符（中位数 {median}，最大 {max}）',
  'check.page-size-markdown.warn':
    '{warn}/{total} 个{pageLabel}介于 {pass}–{fail} 字符（最大 {max}）',
  'check.page-size-markdown.fail':
    '{failCount}/{total} 个{pageLabel}超过 {fail} 字符（最大 {max}）',
  'check.page-size-html.error_none': '无法抓取任何页面进行测量{suffix}',
  'check.page-size-html.pass':
    '全部 {total} 个{pageLabel}低于 {pass} 字符（中位数 {medianHtml} HTML → {medianMd} Markdown（{avgRatio}% 样板））{suffix}',
  'check.page-size-html.warn':
    '{warn}/{total} 个{pageLabel}转换为 {pass}–{fail} 字符（最大 {maxHtml} HTML → {maxMd} Markdown（{avgRatio}% 样板））{suffix}',
  'check.page-size-html.fail':
    '{failCount}/{total} 个{pageLabel}转换为超过 {fail} 字符（最大 {maxHtml} HTML → {maxMd} Markdown（{avgRatio}% 样板））{suffix}',
  'check.content-start-position.error_none': '无法抓取任何页面进行分析{suffix}',
  'check.content-start-position.pass':
    '全部 {total} 个{pageLabel}的正文起始于前 10%（中位数 {median}%）{suffix}',
  'check.content-start-position.warn':
    '{warn}/{total} 个{pageLabel}正文起始于 10%–50%（最差 {worst}%）{suffix}',
  'check.content-start-position.fail':
    '{failCount}/{total} 个{pageLabel}正文起始超过 50%（最差 {worst}%）{suffix}',
  'check.rendering-strategy.sparse_note': '；另有 {sparse} 个有页面结构但几乎没有实质内容',
  'check.rendering-strategy.fetch_note': '；{count} 次获取失败',
  'check.rendering-strategy.error_none': '无法抓取任何页面进行分析{suffix}',
  'check.rendering-strategy.pass': '全部 {total} 个{pageLabel}包含服务端渲染内容{fetchNote}',
  'check.rendering-strategy.fail_spa':
    '{spa}/{total} 个{pageLabel}疑似客户端渲染 SPA 空壳{frameworkHint}；使用 HTTP 抓取的智能体将看不到内容{sparseNote}{fetchNote}',
  'check.rendering-strategy.warn_sparse':
    '{sparse}/{total} 个{pageLabel}有服务端渲染的页面结构但正文很少；智能体只能看到标题与导航，看不到实际文档{fetchNote}',
  'check.tabbed-content-serialization.error_none': '无法抓取任何页面进行分析{suffix}',
  'check.tabbed-content-serialization.pass_none': '在 {total} 个{pageLabel}中未检测到标签页内容',
  'check.tabbed-content-serialization.pass':
    '{pages}/{total} 个{pageLabel}共 {groups} 个标签组；序列化均低于 50K 字符',
  'check.tabbed-content-serialization.warn':
    '发现 {groups} 个标签组；最差页面序列化为 {size} 字符（50K–100K）',
  'check.tabbed-content-serialization.fail':
    '发现 {groups} 个标签组；最差页面序列化为 {size} 字符（超过 100K）',
  'check.section-header-quality.skip_dep': '已跳过：tabbed-content-serialization 未运行',
  'check.section-header-quality.skip_no_tabs': '未发现标签页内容；标题质量检查不适用',
  'check.section-header-quality.skip_few_panels': '标签组面板少于 2 个；标题质量检查不适用',
  'check.section-header-quality.skip_no_headers':
    '发现 {pages} 个含标签的页面，但面板内无可评估的章节标题',
  'check.section-header-quality.pass': '已检查 {pages} 个含标签标题的页面；标题包含变体上下文',
  'check.section-header-quality.issue': '{summary}（例如 “{header}” 在 {groups} 个标签组中重复）',
  'check.markdown-code-fence-validity.skip_no_md': '站点不提供 Markdown 内容；无可分析对象',
  'check.markdown-code-fence-validity.skip_none': '未找到 Markdown 内容{hint}',
  'check.markdown-code-fence-validity.pass': '全部 {fences} 个代码围栏在 {pages} 个页面中正确闭合',
  'check.markdown-code-fence-validity.fail': '在 {pages} 个页面中发现 {count} 个未闭合代码围栏',
  'check.http-status-codes.error_none': '无法测试任何 URL{suffix}',
  'check.http-status-codes.warn_indeterminate':
    '无法判断错误 URL 处理：全部 {count} 个{pageLabel}返回不确定响应{suffix}',
  'check.http-status-codes.fail_soft404':
    '{soft404s}/{determinate} 个{pageLabel}对不存在 URL 返回 200（软 404）{suffix}',
  'check.http-status-codes.pass':
    '全部 {determinate} 个{pageLabel}对错误 URL 返回正确状态码{suffix}',
  'check.redirect-behavior.part_js': '{count} 个 JavaScript 重定向',
  'check.redirect-behavior.part_cross_host': '{count} 个跨主机重定向',
  'check.redirect-behavior.and': ' 和 ',
  'check.redirect-behavior.error_none': '无法测试任何 URL{suffix}',
  'check.redirect-behavior.pass_none': '在 {total} 个{pageLabel}中未检测到重定向{suffix}',
  'check.redirect-behavior.pass_same_host':
    '{total} 个{pageLabel}中全部 {redirects} 个重定向均为同主机 HTTP 重定向{suffix}',
  'check.redirect-behavior.warn_cross_host':
    '{crossHost}/{total} 个{pageLabel}使用跨主机重定向{suffix}',
  'check.redirect-behavior.fail_mixed': '在 {total} 个{pageLabel}中检测到 {parts}{suffix}',
  'check.llms-txt-coverage.skip_no_pages': 'llms.txt 中未找到页面 URL',
  'check.llms-txt-coverage.skip_no_sitemap':
    '未找到 sitemap；缺少作为基准的 sitemap，无法评估 llms.txt 覆盖率',
  'check.llms-txt-coverage.skip_prefix':
    'Sitemap 有 {count} 个 URL，但都不在文档路径前缀下（{prefix}）',
  'check.llms-txt-coverage.nonpass':
    'llms.txt 覆盖 {covered}/{total} 个 sitemap 文档页（{coverage}%）；缺少 {missing}',
  'check.llms-txt-coverage.omitted': '省略了 {indexes} 个嵌套索引（排除 {pages} 个 sitemap 页面）',
  'check.llms-txt-coverage.unmatched':
    '{count} 个 llms.txt 链接不在 sitemap 中（可能是过期链接或不完整 sitemap）',
  'check.llms-txt-coverage.pass': 'llms.txt 覆盖 {total} 个 sitemap 文档页的 {coverage}%',
  'check.markdown-content-parity.skip_none': '没有可比较的 Markdown 版本页面',
  'check.markdown-content-parity.error_none': '无法抓取任何页面的 HTML 进行比较{suffix}',
  'check.markdown-content-parity.pass':
    '全部 {total} 个页面的 Markdown 与 HTML 内容等价（平均缺失 {avg}%）{suffix}',
  'check.markdown-content-parity.warn':
    '{warn}/{total} 个页面的 Markdown 与 HTML 存在轻微内容差异{suffix}',
  'check.markdown-content-parity.fail':
    '{failCount}/{total} 个页面的 Markdown 与 HTML 存在实质性内容差异（平均缺失 {avg}%）{suffix}',
  'check.cache-header-hygiene.error_none': '无法抓取任何端点检查缓存头{suffix}',
  'check.cache-header-hygiene.pass': '全部 {total} 个端点的缓存头合适{suffix}',
  'check.cache-header-hygiene.warn': '{warn}/{total} 个端点缓存寿命中等（1–24 小时）{suffix}',
  'check.cache-header-hygiene.fail': '{failCount}/{total} 个端点缓存过于激进或缺少缓存头{suffix}',
  'check.auth-gate-detection.error_none': '无法抓取任何页面检查认证{suffix}',
  'check.auth-gate-detection.pass': '全部 {count} 个{pageLabel}可公开访问{suffix}',
  'check.auth-gate-detection.warn':
    '{gated}/{total} 个{pageLabel}需要认证（{accessible} 个可访问）{suffix}',
  'check.auth-gate-detection.fail': '全部 {total} 个{pageLabel}需要认证{suffix}',
  'check.auth-alternative-access.skip_dep_missing': 'auth-gate-detection 未运行',
  'check.auth-alternative-access.pass_public': '所有文档页均可公开访问；无需替代访问路径',
  'check.auth-alternative-access.skip_dep_status': 'auth-gate-detection {status}；无法评估替代访问',
  'check.auth-alternative-access.skip_fetch_errors':
    'auth-gate-detection 因抓取错误失败，并非检测到认证响应；无法评估替代访问',
  'check.auth-alternative-access.manual_note':
    '部分访问路径无法自动检测：随 SDK 附带的文档、CLI 文档命令，以及 MCP 服务器',
  'check.auth-alternative-access.fail_none':
    '未检测到针对 {gated} 个认证受限页面的替代访问路径。{note}',
  'check.auth-alternative-access.warn_partial':
    '针对含 {gated} 个鉴权页的站点检测到部分替代访问（{paths}）。{note}',
  'check.auth-alternative-access.pass': '针对含 {gated} 个鉴权页的站点检测到替代访问（{paths}）',
  'resolution.llms-txt-exists.warn':
    '你的 llms.txt 只能通过跨主机重定向访问，部分智能体不会跟随。请从与文档相同的主机直接提供 llms.txt，或添加同主机重定向。',
  'resolution.llms-txt-exists.fail':
    '在站点根目录创建 llms.txt，包含 H1 标题、引用摘要，以及指向关键文档页的 Markdown 链接。这对提升智能体访问文档的效果通常最大。',
  'resolution.llms-txt-valid.warn':
    '你的 llms.txt 含有可解析链接，但未遵循标准结构。请将 H1 标题作为第一行，并添加引用摘要（以 > 开头的行），以改善智能体解析。',
  'resolution.llms-txt-valid.fail':
    'llms.txt 存在但不含可解析的 Markdown 链接。请在标题分隔的分区下，以 [名称](url): 描述 格式添加链接。',
  'resolution.llms-txt-size.warn':
    '你的 llms.txt 为 {size} 字符，在部分智能体平台上可能被截断。若继续增长，请拆分为嵌套 llms.txt，并使根索引低于 50,000 字符。',
  'resolution.llms-txt-size.fail':
    '你的 llms.txt 为 {size} 字符，会被所有主要智能体平台截断。请拆分为根索引并链接到章节级 llms.txt，每个低于 50,000 字符。',
  'resolution.llms-txt-links-resolve.warn':
    'llms.txt 中 {broken}/{total} 个链接返回错误。请审计并修复或移除损坏 URL，避免智能体走入死胡同。',
  'resolution.llms-txt-links-resolve.fail':
    'llms.txt 中 {broken}/{total} 个链接返回错误。带有损坏链接的过期 llms.txt 比没有更糟，因为它会高置信地引导智能体走入死胡同。',
  'resolution.llms-txt-links-markdown.warn':
    'llms.txt 中部分链接指向 HTML 而非 Markdown。尽可能改为 .md URL，让智能体直接获得干净的 Markdown。',
  'resolution.llms-txt-links-markdown.fail':
    'llms.txt 链接指向 HTML 页面。请改为 .md URL 变体，使智能体获得 Markdown 而非转换后的 HTML。',
  'resolution.llms-txt-directive-html.warn':
    '部分页面 HTML 中找到了 llms.txt 指引，但其他页面缺失，或指引位置过深。请确保每个文档页顶部附近都有指引。',
  'resolution.llms-txt-directive-html.fail':
    '在任何测试页面的 HTML 中都未检测到指向 llms.txt 的智能体可见指引。请在每页顶部附近添加视觉隐藏元素（例如带 CSS clip-rect 的 div）并链接到 llms.txt。若站点提供 Markdown 版本，也请在指引中说明，以便智能体请求。',
  'resolution.llms-txt-directive-md.warn':
    '部分页面 Markdown 中找到了 llms.txt 指引，但其他页面缺失，或指引位置过深。请确保每个 Markdown 页顶部附近都有指引。',
  'resolution.llms-txt-directive-md.fail':
    '在任何测试页面的 Markdown 中都未检测到 llms.txt 指引。请在每个 Markdown 页顶部附近添加引用块（例如 “> 完整文档索引见 [llms.txt](/llms.txt)”）。',
  'resolution.markdown-url-support.warn':
    '{warnCount}/{tested} 个页面对 .md URL 的支持不一致。请确保所有文档页在 URL 追加 .md 时都能返回 Markdown。',
  'resolution.markdown-url-support.fail':
    '页面在 URL 追加 .md 时不返回 Markdown。请配置文档平台为所有文档页提供 .md 变体。',
  'resolution.content-negotiation.warn':
    '服务器对 Accept: text/markdown 返回了 Markdown 内容，但 Content-Type 不正确。请将响应 Content-Type 设为 text/markdown。',
  'resolution.content-negotiation.fail':
    '服务器忽略 Accept: text/markdown 并返回 HTML。部分智能体（Claude Code、Cursor、OpenCode）会以此方式请求 Markdown。请配置服务器支持内容协商。',
  'resolution.rendering-strategy.warn':
    '{warnCount}/{tested} 个页面内容稀疏，可能依赖客户端 JavaScript 填充。请确认关键内容已出现在服务端渲染的 HTML 中。',
  'resolution.rendering-strategy.fail':
    '{failCount}/{tested} 个页面使用客户端渲染。智能体只会拿到没有文档内容的空壳。请为文档页启用服务端渲染或预渲染。',
  'resolution.page-size-markdown.warn':
    '{warnCount}/{tested} 个 Markdown 页面介于 50K–100K 字符。在部分平台上可能被截断或走摘要路径。建议拆分大页。',
  'resolution.page-size-markdown.fail':
    '{failCount}/{tested} 个 Markdown 页面超过 100K 字符，会被智能体截断。请拆分为更小页面，或重构序列化的选项卡内容。',
  'resolution.page-size-html.warn':
    '{warnCount}/{tested} 个页面转换为 50K–100K 字符的 Markdown。请减少可裁剪样板（导航、序列化选项卡）。可考虑提供更小的 Markdown 路径供智能体使用。',
  'resolution.page-size-html.fail':
    '{failCount}/{tested} 个页面转换为超过 100K 字符的 Markdown。请拆分大页、减少导航样板，或提供可绕过 HTML 转换开销的 Markdown 版本。',
  'resolution.content-start-position.warn':
    '{warnCount}/{tested} 个页面的文档正文开始于转换结果的 10–50%。请减少正文前的导航、面包屑和侧栏标记。',
  'resolution.content-start-position.fail':
    '{failCount}/{tested} 个页面的正文开始于转换结果 50% 之后。智能体可能看不到文档内容。请减少正文前的导航、面包屑和侧栏标记。',
  'resolution.tabbed-content-serialization.warn':
    '{warnCount} 个页面的选项卡内容序列化为 50K–100K 字符。建议将选项卡变体拆为独立页面，或提供让智能体请求特定变体的机制。',
  'resolution.tabbed-content-serialization.fail':
    '{failCount} 个页面的选项卡内容序列化超过 100K 字符。智能体只能看到前几个变体，后续被截断。请将变体拆为独立页面。',
  'resolution.section-header-quality.warn':
    '选项卡分区中 25–50% 的标题过于通用（例如各变体重复 “Step 1”）。请为标题添加变体上下文（例如 “Step 1 (Python)”），便于智能体区分。',
  'resolution.section-header-quality.fail':
    '超过 50% 的标题在各选项卡变体间过于通用。序列化后智能体无法判断章节属于哪个变体。',
  'resolution.markdown-code-fence-validity.fail':
    '{failCount} 个页面存在未闭合代码围栏。未闭合围栏之后的内容会被当作代码，导致智能体误读。请确保每个开头的 ``` 或 ~~~ 都有匹配的结束符。',
  'resolution.http-status-codes.fail':
    '站点对不存在的页面返回 200（软 404）。智能体会尝试从错误页提取信息，而不是识别页面缺失。请配置服务器对不存在的页面返回 404。',
  'resolution.redirect-behavior.warn':
    '{warnCount} 个页面使用跨主机 HTTP 重定向，部分智能体不会跟随。尽可能使用同主机重定向，或直接指向最终目标 URL。',
  'resolution.redirect-behavior.fail':
    '在 {failCount} 个页面检测到基于 JavaScript 的重定向。智能体不执行 JavaScript，不会跟随。请改用 HTTP 301/302。',
  'resolution.llms-txt-coverage.warn':
    'llms.txt 覆盖站点页面的 {coverage}%（{warnThreshold}-{passThreshold}% 为警告区间）。有 {missing} 个在线页面未出现在索引中。请补充缺失页面，或在有意排除时调整 --coverage-pass-threshold/--coverage-warn-threshold。',
  'resolution.llms-txt-coverage.fail':
    'llms.txt 覆盖站点页面的 {coverage}%（低于 {warnThreshold}% 阈值）。有 {missing} 个在线页面缺失。若非有意，请从 sitemap 或构建流水线重新生成；若有意，可降低阈值或设为 0 使检查仅供参考。',
  'resolution.markdown-content-parity.warn':
    '{warnCount} 个页面的 Markdown 与 HTML 存在轻微差异。若为有意的受众分层，请调整 --parity-pass-threshold 与 --parity-warn-threshold（均可设为 0 进入仅信息模式）。',
  'resolution.markdown-content-parity.fail':
    '{failCount} 个页面的 Markdown 与 HTML 存在实质性差异（平均缺失 {avgMissing}%）。若非有意，智能体可能拿到过时内容，请从源重新生成 Markdown 或修复构建；若有意，可为仅人类内容添加 data-markdown-ignore，或调整阈值。',
  'resolution.cache-header-hygiene.warn':
    '{warnCount} 个端点缓存生命周期适中（1–24 小时）。llms.txt 或 Markdown 更新可能需数小时才生效。建议缩短这些资源的缓存时间。',
  'resolution.cache-header-hygiene.fail':
    '{failCount} 个端点缓存过于激进（>24h）或缺少缓存头。请将 max-age 设为低于 3600，或配合 ETag/Last-Modified 使用 must-revalidate，使更新及时到达智能体。',
  'resolution.auth-gate-detection.warn':
    '部分文档需要鉴权，部分公开。智能体可访问公开页，但对鉴权内容会回退训练数据。建议开放参考文档与 API 指南。',
  'resolution.auth-gate-detection.fail':
    '全部或大多数文档页需要鉴权。智能体无法访问你的文档，只能依赖可能过时的训练数据或二手来源。请考虑提供替代访问路径（见 auth-alternative-access 检查）。',
  'resolution.auth-alternative-access.warn':
    '检测到鉴权内容的部分替代访问（例如公开 llms.txt 只覆盖部分鉴权页）。请扩大替代访问覆盖范围。',
  'resolution.auth-alternative-access.fail':
    '未检测到鉴权内容的替代访问路径。可考虑提供公开 llms.txt、开放参考文档、随 SDK 附带文档，或提供用于鉴权访问的 MCP 服务器。',
  'diagnostic.markdown-undiscoverable.message':
    '站点在 .md URL 提供 Markdown，但智能体无法发现。没有指向 llms.txt 的智能体可见指引，服务器也不支持内容协商。大多数智能体会默认走 HTML 路径，无法受益于你的 Markdown 支持。',
  'diagnostic.markdown-undiscoverable.resolution':
    '在每个文档页顶部附近添加指向 llms.txt 的指引，并实现对 Accept: text/markdown 的内容协商。指引是主要发现机制（覆盖所有智能体）；内容协商则为默认请求 Markdown 的智能体提供快速路径。',
  'diagnostic.markdown-partially-discoverable.message':
    '站点提供 Markdown 并支持内容协商，但 HTML 页面缺少指向 llms.txt 的智能体可见指引。发送 Accept: text/markdown 的智能体（Claude Code、Cursor、OpenCode）可自动获得 Markdown，但多数智能体默认抓取 HTML，没有信号去尝试 Markdown 路径。',
  'diagnostic.markdown-partially-discoverable.resolution':
    '在每个文档页顶部附近添加指向 llms.txt 的指引。若站点提供 Markdown，也请在指引中说明。指引面向所有智能体，而不仅是默认请求 Markdown 的那些。',
  'diagnostic.truncated-index.message':
    '你的 llms.txt 有 {size} 个字符。智能体大约只能看到前 100,000 字符（约占文件的 {visiblePct}%）。超出部分的链接、结构与新鲜度不影响智能体体验；不可见部分的质量检查在评分中会被折减。',
  'diagnostic.truncated-index.resolution':
    '拆分为根索引并链接到章节级 llms.txt，每个低于 50,000 字符。参见规范中的渐进披露建议。',
  'diagnostic.spa-shell-html-invalid.message':
    '{spaShells}/{total} 个采样页面是客户端渲染空壳：HTML 响应含有框架根元素但没有文档内容。使用 HTTP 抓取的智能体会拿到空页。HTML 路径的页面体积与内容结构分数会被折扣，因为部分测到的是空壳而非内容。{mdNote}',
  'diagnostic.spa-shell-html-invalid.md_note_ok':
    ' 对能够发现 Markdown 路径的智能体，你的 Markdown 路径仍然可用。',
  'diagnostic.spa-shell-html-invalid.md_note_bad': ' 智能体目前对受影响页面没有替代内容路径。',
  'diagnostic.spa-shell-html-invalid.resolution':
    '为受影响的页面类型启用服务端渲染或静态生成。若仅特定模板使用客户端加载，针对这些模板处理即可，无需整站重建。',
  'diagnostic.sparse-content-html.message':
    '{sparseContent}/{total} 个采样页面为服务端渲染，但正文异常简短。HTML 含有真实内容（标题与可见文本），只是少于完整文档页阈值。这常常合理（短参考页、集成一行示例、词条），但也可能表示渲染器未输出完整内容。这些页面的 HTML 路径体积评分会被折扣。{mdNote}',
  'diagnostic.sparse-content-html.md_note_ok':
    ' 对能够发现 Markdown 路径的智能体，你的 Markdown 路径仍然可用。',
  'diagnostic.sparse-content-html.md_note_bad':
    ' 受影响页面没有替代路径，因此任何缺失内容对智能体都不可见。',
  'diagnostic.sparse-content-html.resolution':
    '确认受影响页面在服务端渲染了完整内容。若页面有意简短，无需处理（本条为信息性）。若内容缺失，检查渲染器是否在服务端输出段落、列表与代码块，而非仅在客户端注水。',
  'diagnostic.no-viable-path.message':
    '智能体无法有效访问你的文档。{llmsReason}，没有可发现的 Markdown 路径，且 HTML 响应要么没有内容要么未测试。这是最低的智能体可访问性状态。',
  'diagnostic.no-viable-path.llms_missing': '没有可用于导航的 llms.txt',
  'diagnostic.no-viable-path.llms_broken':
    'llms.txt 存在，但仅有 {resolveRate}% 的链接可解析，实际上不可用',
  'diagnostic.no-viable-path.resolution':
    '最高影响的动作是在站点根创建带有效链接的 llms.txt。若站点使用客户端渲染，启用服务端渲染是第二优先级。',
  'diagnostic.auth-no-alternative.message':
    '文档需要鉴权，且未检测到替代访问路径。遇到你文档的智能体会回退训练数据，或寻找可能不准确的二手来源。',
  'diagnostic.auth-no-alternative.resolution':
    '可考虑提供公开 llms.txt 作为导航索引、开放 API 参考与集成指南，或随 SDK/包附带文档。参见规范中 “Making Private Docs Agent-Accessible” 按实现成本排序的选项。',
  'diagnostic.page-size-no-markdown-escape.message':
    '{failBucket} 个页面在 HTML 路径超过智能体截断限制，且没有可发现的 Markdown 路径以获得更小表示。智能体将在这些页面上静默拿到截断内容。',
  'diagnostic.page-size-no-markdown-escape.resolution':
    '要么减小 HTML 页面体积（拆分大页、减少内联 CSS/JS），要么提供 Markdown 版本，并通过内容协商或 llms.txt 指引确保智能体可发现。',
  'diagnostic.single-page-sample.message':
    '仅发现并测试了 {n} 个页面（可靠评分至少需要 {min} 页）。页面级类别得分（页面大小、内容结构、URL 稳定性等）可能无法代表全站，这些类别在评分中会标记为 N/A。',
  'diagnostic.single-page-sample.page_was': '个页面',
  'diagnostic.single-page-sample.pages_were': '个页面',
  'diagnostic.single-page-sample.resolution':
    '若站点有 llms.txt，请确保链接可用以便发现更多页面。若测试预览部署，使用 --canonical-origin 重写跨源 llms.txt 链接。也可通过 --urls 指定页面。',
  'diagnostic.cross-origin-llms-txt.message':
    'llms.txt 中全部 {total} 个链接指向 {dominant}，而非正在测试的源。这通常发生在预览/预发环境的 llms.txt 仍引用生产域名时。页面发现会回退到单页。',
  'diagnostic.cross-origin-llms-txt.resolution':
    '使用 --canonical-origin <生产源> 在测试时重写跨源链接。例如：--canonical-origin https://docs.example.com',
  'diagnostic.gzipped-sitemap-skipped.message':
    'URL 发现期间跳过了 gzip 压缩的 sitemap{urlNote}。若这是唯一的 sitemap 来源，可能减少了可测试页面数量。',
  'diagnostic.gzipped-sitemap-skipped.resolution':
    '在 gzip 版本旁提供未压缩的 sitemap.xml，或通过 --urls 指定页面进行定向测试。',
  'diagnostic.rate-limiting-severe.message':
    '{pct}% 的测试 URL 返回 HTTP 429（限流）。检查结果可能不可靠，因为限流请求不会无限重试。',
  'diagnostic.rate-limiting-severe.resolution':
    '增大 --request-delay 以放慢请求，或联系站点运营方将你的 IP/UA 加入测试白名单。',
};
