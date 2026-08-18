import { apiGet, buildQuery } from '@raynard/plugin-sdk';

export type OpenLibraryDocument = {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  edition_count?: number;
  cover_i?: number;
};

export type OpenLibrarySearchResponse = {
  numFound?: number;
  docs?: OpenLibraryDocument[];
};

const SEARCH_URL = 'https://openlibrary.org/search.json';
const SEARCH_FIELDS = 'key,title,author_name,first_publish_year,edition_count,cover_i';

export async function searchBooks(query: string, limit: number) {
  const parameters = { q: query, limit, fields: SEARCH_FIELDS };
  const sourceUrl = `${SEARCH_URL}${buildQuery(parameters)}`;
  const payload = await apiGet<OpenLibrarySearchResponse>(SEARCH_URL, {
    query: parameters,
    label: 'Open Library search'
  });
  return { payload, sourceUrl };
}
