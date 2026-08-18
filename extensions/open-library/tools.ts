import {
  createApiReference,
  defineTools,
  requireNonEmpty,
  requirePositiveInt
} from '@raynard/plugin-sdk';
import { searchBooks } from './client.ts';

type BookRow = {
  id: string;
  title: string;
  author: string;
  firstPublished: string;
  editions: string;
  coverUrl: string;
};

export const tools = defineTools({
  open_library_search_books: {
    description:
      'Search Open Library when the user wants books matching a title, author, subject, ISBN, or general keyword query. Returns at most 20 compact bibliographic matches.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Open Library search query, such as a title, author, subject, or ISBN.'
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Maximum books to return. Defaults to 8.'
        }
      },
      additionalProperties: false
    },
    card: {
      name: { singular: 'book', plural: 'books' },
      title: 'Open Library results for “{{query}}”',
      layout: [
        {
          component: 'Table',
          rows: 'books',
          columns: [
            { header: 'Title', field: 'title' },
            { header: 'Author', field: 'author' },
            { header: 'First published', field: 'firstPublished' },
            { header: 'Editions', field: 'editions' }
          ]
        }
      ]
    },
    async execute(args) {
      const query = requireNonEmpty(args.query, 'query');
      const limit = args.limit === undefined ? 8 : requirePositiveInt(args.limit, 'limit');
      if (limit > 20) throw new Error('limit must be at most 20.');

      const { payload, sourceUrl } = await searchBooks(query, limit);
      const documents = Array.isArray(payload.docs) ? payload.docs.slice(0, limit) : [];
      const books: BookRow[] = documents.map((document, index) => {
        const id = String(document.key || `search-result-${index + 1}`);
        return {
          id,
          title: String(document.title || 'Untitled'),
          author:
            Array.isArray(document.author_name) && document.author_name.length
              ? document.author_name.slice(0, 3).join(', ')
              : 'Unknown',
          firstPublished: document.first_publish_year ? String(document.first_publish_year) : 'Unknown',
          editions: Number.isFinite(document.edition_count) ? String(document.edition_count) : 'Unknown',
          coverUrl: document.cover_i
            ? `https://covers.openlibrary.org/b/id/${document.cover_i}-M.jpg`
            : ''
        };
      });

      const total = Number.isFinite(payload.numFound) ? Number(payload.numFound) : books.length;
      const text = books.length
        ? `Found ${total} Open Library matches for “${query}”; showing ${books.length}.`
        : `Open Library returned no books for “${query}”.`;
      const referenceDocuments = documents.length ? documents : [payload];
      const references = referenceDocuments.map((document, index) =>
        createApiReference({
          id: `${query}-${index + 1}`,
          label: books[index]?.title || `Open Library search for ${query}`,
          sourceUrl,
          quote: books[index]
            ? `${books[index].title} by ${books[index].author}`
            : `No books matched “${query}”.`,
          payloadPath: documents.length ? `docs[${index}]` : '',
          payload: document
        })
      );

      return {
        text,
        references,
        data: { query, total, books }
      };
    }
  }
});
