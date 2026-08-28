# Raynard v0.10.0

Chart JSON that a model corrupts in transit now recovers through a general
repair pipeline instead of a short list of exact, previously-seen shapes.

## General-purpose chart JSON repair

`v0.9.0` fixed two exact malformations observed from Kimi K2.5: a chart fence
missing its `chart` language tag, and one stray trailing `}`/`]` glued onto an
otherwise well-formed spec. Further testing turned up a third shape — one or
two stray backticks glued directly onto the JSON with no newline before the
real fence close — which the narrow, bounded bracket-stripping from `v0.9.0`
didn't cover.

Rather than add a fourth special case, chart parsing now runs a small pipeline
of general-purpose repairs, each re-validated by the full chart schema before
use:

- straighten smart/curly quotes left over from pasted text
- strip a dangling trailing comma before a closing bracket or brace, tracking
  string state so a comma inside a title or label is never touched
- extract the first balanced top-level JSON object, ignoring any narration
  glued onto its head or tail and any amount of trailing garbage after it
  closes

That balanced-object extraction alone covers every trailing-garbage shape
seen so far — and any future one shaped the same way — instead of only the
specific bracket and backtick sequences already observed. A genuinely
truncated or broken spec still falls back to an ordinary code block rather
than being misread as a chart.
