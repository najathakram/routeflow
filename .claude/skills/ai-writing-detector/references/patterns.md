# Pattern Catalog: Signs of AI Writing

Source: Wikipedia:Signs_of_AI_writing (WikiProject AI Cleanup) plus secondary coverage.
Weighting key: STRONG = near-certain artifact of LLM output when present. MODERATE = meaningful when it recurs. WEAK = common in human writing too; only counts in accumulation.

## A. Language and tone

### A1. Inflated significance — MODERATE
Grandiose framing of mundane subjects. Phrases:
stands as a testament to, plays a vital role, plays a significant role, underscores its importance, leaves a lasting impact, watershed moment, pivotal moment, key turning point, marking a shift, symbol of resilience, indelible mark, setting the stage for, deeply rooted, focal point, enduring legacy, evolving landscape, cements its place, solidifies its position.
Also: situating an arbitrary detail inside a "broader trend" or "larger movement" without evidence.

### A2. Promotional / travel-brochure tone — MODERATE
rich cultural heritage, breathtaking, must-visit, stunning natural beauty, nestled in the heart of, vibrant, scenic, boasts, captivates residents and visitors alike, charming, seamless, intuitive.
Test: does it read like ad copy or a TV commercial transcript?

### A3. Superficial trailing "-ing" analysis — STRONG when recurring
A plain fact followed by a present-participle clause asserting vague significance:
", highlighting...", ", underscoring...", ", emphasizing...", ", reflecting...", ", symbolizing...", ", showcasing...", ", ensuring...", ", contributing to...", ", illustrating...", ", demonstrating...".
The clause adds no checkable information. One of the most reliable tells because it is structural, not lexical.

### A4. Negative parallelism / contrast-reframe — STRONG when recurring
"It's not just X, it's Y." / "It's not X. It's Y." / "no X, no Y, just Z" / "not only X but also Y".
Manufactures depth by denying a claim nobody made. Also appears reversed (common in Grok output).

### A5. Copula avoidance — MODERATE
"serves as a", "marks the", "represents a", "functions as" where "is/was/are" would do.

### A6. Vague attribution (phantom authorities) — MODERATE
some critics argue, observers have noted, experts believe, industry reports suggest, it is widely regarded — with no named source. Creates the illusion of sourcing.

### A7. Overused vocabulary — WEAK individually
delve, intricate, tapestry, pivotal, underscore, landscape, foster, testament, enhance, crucial, comprehensive, robust, leverage, multifaceted, realm, boasts, notably, individuals (where "people" fits).
Grok-specific: causal, empirical, correlate.
Caution: read literally — an overused word does not implicate its synonyms; context matters (e.g., "underscore" as literal underline).

### A8. Formulaic transitions and filler summaries — WEAK individually
moreover, furthermore, in addition, additionally cycled as paragraph glue; "in summary", "in conclusion", "overall" restating what was just said; "it is important to note", "it is worth remembering", "no discussion would be complete without".

### A9. Rule of three — WEAK individually
Triplets by default: "innovative, transformative, and groundbreaking". Suspicious when nearly every list has exactly three items.

### A10. False ranges — MODERATE
"ranges from X to Y" / "from strategy to execution" constructions that sound specific but convey nothing.

### A11. Opinion via passive voice — MODERATE
"has been described as", "is considered", "is celebrated as" with no source. Opinion enters with no visible actor.

### A12. Letter-template pleasantries out of place — STRONG
"I hope this message finds you well", "Thank you for your time and consideration", "I am willing to help in any way" inside content that is not a letter.

## B. Structure

### B1. Rigid formula sections — STRONG (in article-like text)
A "Challenges" section opening "Despite its [positives], [subject] faces challenges..." and closing on vague optimism or future-initiative speculation; paired "Future Prospects" / "Future Outlook" sections; Overview/Summary/Conclusion scaffolding.

### B2. Abstract-style headings — MODERATE
Headings that compress the argument: "Why the Reception Was Mixed", "Key Contributions and Lasting Impact". Reads like the first line of an abstract, not a location name in a document.

### B3. Defining a non-entity in the lead — MODERATE (Wikipedia-specific)
First sentence defines a list/descriptive title as if it were a real-world entity.

### B4. Uniform sentence rhythm — MODERATE
Sentences of near-identical length and cadence; every paragraph the same shape.

## C. Style and formatting

### C1. Em dash overuse — WEAK alone
More em dashes than comparable human text, placed where commas/parentheses/colons fit better. NOT reliable alone; strongest when co-occurring with A3/A4.

### C2. Curly quotes/apostrophes — WEAK alone
Curly marks, or inconsistent mixing of curly and straight in one text. Word/macOS/iOS/Chicago-style all produce curly marks legitimately.

### C3. Title Case Headings — MODERATE (in contexts expecting sentence case)

### C4. Mechanical boldface — MODERATE
Bolding every instance of a chosen term, "key takeaways" style. Note: newer models suppress this, so absence proves nothing.

### C5. Excessive lists/bullets, emojis in headers — MODERATE in prose contexts

### C6. Markdown residue — STRONG
Asterisks/underscores for emphasis in a system that uses other markup (or in plain contexts where raw **bold** markers survive).

## D. Artifacts and hard evidence

### D1. Placeholder link codes — STRONG (near-certain)
turn0search0, ref name="0search12", iturn0image0turn0image1..., citeturn0news0, citeturn1file0, citegenerated-reference-identifier. First observed Feb 2025; may appear in other languages.

### D2. Chatbot conversational residue — STRONG (near-certain)
"Certainly!", "I hope this helps", "let me know if you need anything else", "As an AI language model...", "up to my last training update", "as of my knowledge cutoff", salutations/sign-offs to editors, refusal text.

### D3. Unedited phrasal templates — STRONG
Bracketed fill-in-the-blank text: "[insert name]", "[This section would speculate on...]". Also leftover notes to the user, including "key changes to avoid detection" lists.

### D4. Fabricated sourcing — STRONG
Unresolvable DOIs, ISBNs with invalid checksums, dead links absent from archives, citations to non-existent works, in-text attribution lavished on trivial facts. Verify before asserting: a dead link alone is link rot, not proof.

### D5. Hallucinated wiki objects — STRONG (Wikipedia-specific)
Red-linked invented categories, transclusions of non-existent templates (infobox/lang variants).

## Scoring guidance

- 1-2 WEAK hits: normal human writing. Say "reads human".
- Several MODERATE hits or recurring A3/A4: "mixed signals" to "likely AI-assisted".
- Any D-class hit: "strongly reads as raw AI output" — these are artifacts, not style.
- Cumulative logic only. Cite the accuracy ceiling: expert LLM users detect at ~90%, so 1 in 10 confident calls is wrong; non-experts perform near chance.
- Human writing is drifting toward LLM style (measurable since 2024), so lexical signals decay over time; structural signals (A3, A4, B1, D-class) decay slowest.
