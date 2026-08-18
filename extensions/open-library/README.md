# Open Library

Searches the public Open Library catalog for books by title, author, subject,
ISBN, or general keywords. It does not require an API key.

## Source documentation

- [Open Library Search API](https://openlibrary.org/dev/docs/api/search)
- [Open Library API index](https://openlibrary.org/developers/api)

## Tools

### `open_library_search_books`

Returns a bounded table of matching books with titles, authors, first-publication
years, edition counts, Open Library source references, and structured card data.
The optional `limit` is constrained to 1–20 and defaults to 8.

## Endpoint Inventory

| Endpoint | Status | Parameters and response shape | Tool |
| --- | --- | --- | --- |
| `GET https://openlibrary.org/search.json` | Implemented | `q`, `limit`, and an explicit `fields` allowlist; returns `numFound` and `docs[]` | `open_library_search_books` |
