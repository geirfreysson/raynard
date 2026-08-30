# Raynard v0.11.1

A bugfix release: citations, links, and inline code wrapped in bold or italic
text now render properly instead of appearing as raw markup.

## Citations inside emphasis render as chips

Assistant answers cite their sources with `[^n]` markers, which the renderer
turns into clickable chips that open the observation behind the number. Any
marker the model wrapped in emphasis was rendered as literal text instead.

That is exactly the shape models reach for when attributing a block, so it hit
constantly. A research answer ending its sections with

    *Sources: [^7], [^8]*

showed the raw `[^7]` and `[^8]` rather than chips, while bare markers
elsewhere in the same answer worked normally — leaving an answer with some
citations clickable and others not, for no reason visible to the reader.

Replaying one real 31-reference answer through the fixed renderer: all 13
cited markers now resolve, where 9 of them previously stayed literal.

The cause was that inline markdown is matched with a single flat pattern, and
the `<strong>`/`<em>` branches filled their node with `textContent` — which
discarded every nested span. Links and inline code inside emphasis were lost
the same way, so `**See [the docs](https://example.com)**` rendered its
markdown source rather than a link.

Emphasis now renders its own contents, bounded by a nesting cap. Because the
pattern is a shared stateful regex, spans are collected before any node is
appended, so a nested walk cannot disturb the position of the walk that
started it.

## Internals

The inline renderer moved out of `src/main.ts` into `src/inline-markdown.ts`.
`main.ts` is the application entry point and runs side effects on import, so
nothing in it could be covered by a test; the extracted module is now tested
directly, including citations, links, and code nested inside emphasis.
