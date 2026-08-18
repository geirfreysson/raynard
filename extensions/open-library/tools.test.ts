import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { expectToolResult, mockFetch } from '@raynard/plugin-sdk/testing';
import { tools } from './tools.ts';

let activeMock: ReturnType<typeof mockFetch> | undefined;

afterEach(() => {
  activeMock?.restore();
  activeMock = undefined;
});

test('searches with bounded fields and returns card-shaped book data', async () => {
  activeMock = mockFetch((url) => {
    assert.match(url, /^https:\/\/openlibrary\.org\/search\.json\?/);
    assert.match(url, /q=earthsea/);
    assert.match(url, /limit=2/);
    assert.match(url, /fields=key%2Ctitle%2Cauthor_name/);
    return {
      body: {
        numFound: 2,
        docs: [
          {
            key: '/works/OL59816W',
            title: 'A Wizard of Earthsea',
            author_name: ['Ursula K. Le Guin'],
            first_publish_year: 1968,
            edition_count: 52,
            cover_i: 8231856
          },
          {
            key: '/works/OL14910015W',
            title: 'The Books of Earthsea',
            author_name: ['Ursula K. Le Guin'],
            first_publish_year: 2018,
            edition_count: 8
          }
        ]
      }
    };
  });

  const result = expectToolResult(
    await tools.open_library_search_books.execute({ query: 'earthsea', limit: 2 })
  );
  assert.equal(result.data.total, 2);
  assert.deepEqual(result.data.books[0], {
    id: '/works/OL59816W',
    title: 'A Wizard of Earthsea',
    author: 'Ursula K. Le Guin',
    firstPublished: '1968',
    editions: '52',
    coverUrl: 'https://covers.openlibrary.org/b/id/8231856-M.jpg'
  });
  assert.equal(result.references.length, 2);
});

test('keeps an empty successful response renderable and cited', async () => {
  activeMock = mockFetch(() => ({ body: { numFound: 0, docs: [] } }));
  const result = expectToolResult(
    await tools.open_library_search_books.execute({ query: 'no such book query' })
  );
  assert.match(result.text, /no books/i);
  assert.deepEqual(result.data.books, []);
  assert.equal(result.references.length, 1);
});

test('rejects a result limit above the public tool boundary', async () => {
  await assert.rejects(
    () => tools.open_library_search_books.execute({ query: 'earthsea', limit: 21 }),
    /at most 20/
  );
});
