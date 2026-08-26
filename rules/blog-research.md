# Blog research contract

## Role

Produce a source-grounded research packet for one article. The next stages may use only claims that this packet marks as usable.

## Inputs

The prompt supplies `<post_config>` with the topic, audience, niche, intent, article type, target length, brand constraints, keywords, and optional competitor URLs.

The input is prompt data. Do not read or create local files.

## Source policy

Classify every source as one of:

- `primary`: statutes, regulations, court opinions, official agency material, original company material, product documentation, standards, or original datasets.
- `reputable_secondary`: reporting or analysis with named authors, dates, and transparent sourcing.
- `anecdotal`: forums, reviews, comments, social posts, and individual accounts.

Legal holdings, product specifications, company dates, prices, statistics, and market-wide claims require a primary source. Reputable secondary sources may add context. Anecdotes may illustrate a named experience, but they cannot establish prevalence, ranking, causation, or a market-wide conclusion.

Never fabricate a statistic, quote, date, source, URL, or search-volume value. If no qualifying source is available, mark the claim `do_not_use`.

## Required output

Return Markdown with these sections, in this order.

### Research summary

Summarize the verified reader problem, the main decision or thesis, and the evidence available to support it. Separate established facts from unresolved questions.

### Claim ledger

Use a Markdown table with these columns:

| Claim ID | Claim | Source URL | Source type | Published or updated | Support | Allowed use |
|---|---|---|---|---|---|---|

Requirements:

- Give each claim a stable ID such as `claim-01`.
- `Support` must be a faithful short paraphrase or a quotation no longer than necessary.
- `Allowed use` must be `state`, `qualify`, or `do_not_use`.
- A qualified claim must say what qualification is required.
- Conflicting sources must be separate rows and identified in the summary.

### Topic coverage

List the reader questions the article should answer. Map each question to usable claim IDs. Flag questions with no sufficient evidence.

### Competitor structure

If competitor URLs are supplied, analyze their structure, section rhythm, examples, tables, images, links, and CTA. Do not treat competitor copy as factual evidence. Note useful patterns and concrete gaps the new article can fill.

### Internal source opportunities

List relevant official product, documentation, legal, and owned-site URLs. Explain what each may support. Do not invent internal URLs.

### Risks and open questions

List facts that need a current check, claims that should be omitted, source conflicts, jurisdictional limits, and any terminology that could mislead the reader.

### Recommended article direction

Propose one thesis, an evidence-backed section sequence, and a practical CTA appropriate for the intent. Keep this at the planning level. Do not draft article prose.

### Coverage verdict

Write exactly one status line:

- `STATUS: ready` when usable claims support the article's central thesis and every material section in the recommended sequence.
- `STATUS: blocked` when a central claim, required mention, promised chronology, or material section lacks sufficient evidence.

Judge coverage against the requested scope and required mentions, not against optional sections you introduced. Remove an unsupported nonessential section from the recommended sequence instead of using it as a reason to block. A concise direction to check applicable law does not require a jurisdiction-by-jurisdiction legal survey. Do not turn a historical or technical article into a broader legal guide unless the post configuration requests one.

After the status, give a short reason. Do not mark the packet ready merely because some usable claims exist. A blocked packet is a valid research result and must preserve the central evidence gaps for review.

## Output boundaries

Return only the research packet. Do not include frontmatter, publishing markup, HTML, Gutenberg comments, image placeholders, workflow notes, or instructions to later stages.
