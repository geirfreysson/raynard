# Raynard v0.9.0

Charts render correctly from a wider range of model output, and the marketing
site picks up a real demo video, a social share card, and download analytics.

## More resilient chart rendering

Two chart-parsing gaps, both observed live against Kimi K2.5, are fixed. A
fenced code block is now checked against the chart JSON schema regardless of
its language tag — a model that emits a valid chart spec without labelling
the fence ` ```chart ` still renders as a chart instead of falling back to a
plain code block. Separately, a model that appends one stray trailing `}` or
`]` after an otherwise well-formed spec — turning `...}]}` into `...}]}}` —
no longer sinks the whole block: the parser retries with the stray bracket
stripped before giving up. Both fixes still run every candidate through the
existing schema validation, so a malformed body can never be misread as a
chart.

## Docs site polish

The homepage hero now plays a clickable demo video with a poster image
instead of a static graphic, complete with a dedicated social share card for
link previews. Download link clicks are now tracked, and the hero copy was
tightened to lead with what Raynard actually does.
