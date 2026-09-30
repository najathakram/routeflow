---
name: ai-writing-detector
description: Audit any text for signs of AI-generated writing using the pattern catalog from Wikipedia's "Signs of AI writing" guide, and rewrite text to remove those tells. Use this skill whenever the user asks to check if text sounds AI-written, detect AI writing, humanize a draft, remove AI tells, make writing sound human, review a caption/email/post/article before publishing, or asks "does this sound like ChatGPT wrote it?" Also use it when the user asks Claude to write something that must not read as AI-generated. Trigger even if the user just pastes text and says "check this" or "fix this" in a context about writing quality or authenticity.
---

# AI Writing Detector and Fixer

Two modes. Pick based on what the user asked:

- **AUDIT mode**: user wants to know if a text shows AI tells. Output a findings report.
- **FIX mode**: user wants the tells removed, or wants new text written without them. Output rewritten text plus a short change log.

If ambiguous, audit first, then offer the fix.

Read `references/patterns.md` before doing either. It is the full pattern catalog. Do not work from memory of "what AI writing looks like" — use the catalog.

## AUDIT mode workflow

1. Read the text carefully once for overall register, then a second pass hunting patterns from the catalog.
2. For each hit, record: pattern name, the exact offending phrase or sentence, and severity (strong / moderate / weak signal per the catalog's weighting).
3. Score honestly. The core principle from Wikipedia's guide: **no single sign proves anything**. Strength comes from accumulation and from structural/behavioral signs, not from any one word.
4. Output format:
   - Verdict line: one of "reads human", "mixed signals", "likely AI-assisted", "strongly reads as raw AI output" — with a one-sentence justification.
   - Findings list: each hit quoted with pattern name.
   - What was checked and came back clean (2-3 items max, so the user knows the audit was real).
5. Never claim certainty. Even expert humans hit ~90% accuracy at best; say "consistent with" not "proves".

## FIX mode workflow

1. Run the audit silently first.
2. Rewrite. Rules of the rewrite:
   - Replace inflated significance with the concrete fact. "Stands as a testament to the region's heritage" becomes what the thing actually is or does.
   - Delete trailing "-ing" analysis clauses entirely unless the causal claim is real and sourced — in which case state it as its own plain sentence.
   - Break rule-of-three lists: keep two items, or four, or restructure.
   - Replace "serves as / marks the" with "is / was" where a copula works.
   - Cut "not just X, but Y" — state Y directly.
   - Cut filler transitions and summary phrases; connect ideas by content order instead.
   - Replace vague attribution ("experts note") with a named source or delete the claim.
   - Vary sentence length deliberately. AI rhythm is uniform; human rhythm is not.
   - Keep the user's voice: match their vocabulary level, contractions, and quirks from any human-written text visible in the conversation.
3. Do NOT over-strip. Wikipedia's own editors warn that removing every possible tell produces stiff, generic text that reads even more artificial. Target the 3-6 strongest tells, not all of them. An em dash or one "however" is fine.
4. Output: the rewritten text, then a compact change log (pattern → what changed), max ~8 lines.

## Hard rules

- Never fabricate a source, name, or statistic to replace vague attribution. If no real source exists, delete the claim.
- Preserve factual content exactly. Rewriting style must not alter meaning, numbers, or claims.
- If the user's text is fine, say so. Do not invent findings to seem useful.
- This skill evaluates writing style only. Never present the audit as proof of authorship, plagiarism, or misconduct, and warn the user if they intend to use it to accuse someone.

## Respect user writing preferences

If the user has stated writing preferences (e.g., no em dashes, ESL-accessible language, direct framing), those override the catalog's neutral stance on those elements in FIX mode.
