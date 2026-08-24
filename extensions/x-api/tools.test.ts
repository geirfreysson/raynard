import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureCredentials } from '@raynard/plugin-sdk';
import { mockFetch, expectToolResult } from '@raynard/plugin-sdk/testing';
import { tools } from './tools.ts';

const tweet = { id: '1930000000000000000', text: 'Hello from X API', author_id: '2244994945', created_at: '2026-08-24T00:00:00.000Z', conversation_id: '1930000000000000000', lang: 'en', public_metrics: { like_count: 7, reply_count: 2, retweet_count: 3, quote_count: 1, impression_count: 100 } };
const user = { id: '2244994945', name: 'X Developers', username: 'XDevelopers', verified: true, description: 'The voice of the X Dev team', location: '127.0.0.1', created_at: '2013-12-14T04:35:55.000Z', profile_image_url: 'https://example.com/avatar.jpg', public_metrics: { followers_count: 10, following_count: 2, tweet_count: 50, listed_count: 1 } };

function bindPath(data, path) {
  const value = path.split('.').reduce((acc, key) => acc?.[key], data);
  assert.notEqual(value, undefined, `missing card-bound data field ${path}`);
}

function assertCardData(tool, data) {
  const visit = (block) => {
    if (block.component === 'MetricRow') block.items.forEach((i) => bindPath(data, i.field));
    if (block.component === 'KeyValue') block.pairs.forEach((p) => bindPath(data, p.field));
    if (block.component === 'Table') bindPath(data, block.rows);
    if (block.component === 'Image' || block.component === 'Badge' || block.component === 'Json') block.field && bindPath(data, block.field);
    if (block.layout) block.layout.forEach(visit);
    if (block.columns) block.columns.forEach((c) => c.layout?.forEach(visit));
  };
  tool.card.layout.forEach(visit);
}

test('x_search_recent_posts renders non-empty post IDs and card data', async () => {
  configureCredentials({ X_API_BEARER_TOKEN: 'TEST_TOKEN' });
  const fetchMock = mockFetch(() => ({ body: { data: [tweet], includes: { users: [user] }, meta: { result_count: 1, next_token: 'NEXT' } } }));
  try {
    const result = await tools.x_search_recent_posts.execute({ query: 'from:XDevelopers', max_results: 10 });
    expectToolResult(result);
    assert.equal(fetchMock.calls[0], 'https://api.x.com/2/tweets/search/recent?query=from%3AXDevelopers&max_results=10&tweet.fields=id%2Ctext%2Cauthor_id%2Ccreated_at%2Cpublic_metrics%2Cconversation_id%2Clang%2Csource%2Creferenced_tweets&expansions=author_id%2Creferenced_tweets.id%2Creferenced_tweets.id.author_id&user.fields=id%2Cname%2Cusername%2Cverified%2Cpublic_metrics%2Cdescription%2Clocation%2Curl%2Ccreated_at%2Cprofile_image_url');
    assert.match(result.text, /1930000000000000000/);
    assert.match(result.text, /Hello from X API/);
    assert.equal(result.data.posts[0].id, '1930000000000000000');
    assertCardData(tools.x_search_recent_posts, result.data);
  } finally { fetchMock.restore(); }
});

test('x_get_conversation_posts sends conversation_id query and renders post IDs', async () => {
  configureCredentials({ X_API_BEARER_TOKEN: 'TEST_TOKEN' });
  const fetchMock = mockFetch(() => ({ body: { data: [tweet], includes: { users: [user] }, meta: { result_count: 1 } } }));
  try {
    const result = await tools.x_get_conversation_posts.execute({ conversation_id: '1930000000000000000', max_results: 10 });
    expectToolResult(result);
    assert.match(fetchMock.calls[0], /query=conversation_id%3A1930000000000000000/);
    assert.match(result.text, /1930000000000000000/);
    assert.equal(result.data.conversation_id, '1930000000000000000');
    assertCardData(tools.x_get_conversation_posts, result.data);
  } finally { fetchMock.restore(); }
});

test('x_get_post renders an individual post with metrics and citation', async () => {
  configureCredentials({ X_API_BEARER_TOKEN: 'TEST_TOKEN' });
  const fetchMock = mockFetch(() => ({ body: { data: tweet, includes: { users: [user] } } }));
  try {
    const result = await tools.x_get_post.execute({ id: '1930000000000000000' });
    expectToolResult(result);
    assert.match(fetchMock.calls[0], /^https:\/\/api\.x\.com\/2\/tweets\/1930000000000000000\?/);
    assert.match(result.text, /@XDevelopers/);
    assert.equal(result.data.likes, 7);
    assert.equal(result.references[0].referenceMeta.sourceUrl, 'https://x.com/i/web/status/1930000000000000000');
    assertCardData(tools.x_get_post, result.data);
  } finally { fetchMock.restore(); }
});

test('x_get_user_by_username renders public account metrics and citation', async () => {
  configureCredentials({ X_API_BEARER_TOKEN: 'TEST_TOKEN' });
  const fetchMock = mockFetch(() => ({ body: { data: user } }));
  try {
    const result = await tools.x_get_user_by_username.execute({ username: '@XDevelopers' });
    expectToolResult(result);
    assert.match(fetchMock.calls[0], /^https:\/\/api\.x\.com\/2\/users\/by\/username\/XDevelopers\?/);
    assert.match(result.text, /2244994945/);
    assert.equal(result.data.followers, 10);
    assert.equal(result.references[0].referenceMeta.sourceUrl, 'https://x.com/XDevelopers');
    assertCardData(tools.x_get_user_by_username, result.data);
  } finally { fetchMock.restore(); }
});

test('x_get_user_posts sends pagination and filters, renders IDs and card data', async () => {
  configureCredentials({ X_API_BEARER_TOKEN: 'TEST_TOKEN' });
  const fetchMock = mockFetch(() => ({ body: { data: [tweet], includes: { users: [user] }, meta: { result_count: 1, next_token: 'NEXT2' } } }));
  try {
    const result = await tools.x_get_user_posts.execute({ id: '2244994945', max_results: 5, pagination_token: 'PAGE', exclude: 'retweets' });
    expectToolResult(result);
    assert.equal(fetchMock.calls[0], 'https://api.x.com/2/users/2244994945/tweets?max_results=5&pagination_token=PAGE&exclude=retweets&tweet.fields=id%2Ctext%2Cauthor_id%2Ccreated_at%2Cpublic_metrics%2Cconversation_id%2Clang%2Csource%2Creferenced_tweets&expansions=author_id&user.fields=id%2Cname%2Cusername%2Cverified%2Cpublic_metrics%2Cdescription%2Clocation%2Curl%2Ccreated_at%2Cprofile_image_url');
    assert.match(result.text, /1930000000000000000/);
    assert.equal(result.data.posts[0].id, '1930000000000000000');
    assertCardData(tools.x_get_user_posts, result.data);
  } finally { fetchMock.restore(); }
});

test('x_get_trends_by_location returns ranked location trends with source references and card data', async () => {
  configureCredentials({ X_API_BEARER_TOKEN: 'TEST_TOKEN' });
  const fetchMock = mockFetch(() => ({ body: { data: [
    { trend_name: '#London', tweet_count: 42000 },
    { trend_name: 'Wimbledon', tweet_count: 31000 },
  ] } }));
  try {
    const result = await tools.x_get_trends_by_location.execute({ woeid: 44418, max_trends: 25 });
    expectToolResult(result);
    assert.equal(fetchMock.calls[0], 'https://api.x.com/2/trends/by/woeid/44418?max_trends=25&trend.fields=trend_name%2Ctweet_count');
    assert.match(result.text, /London/);
    assert.match(result.text, /#London/);
    assert.equal(result.data.location, 'London');
    assert.equal(result.data.trends[0].rank, 1);
    assert.equal(result.data.trends[0].tweet_count, 42000);
    assert.match(result.references[0].referenceMeta.sourceUrl, /^https:\/\/x\.com\/search\?/);
    assertCardData(tools.x_get_trends_by_location, result.data);
  } finally { fetchMock.restore(); }
});

test('tools require the declared X credential at execution time', async () => {
  configureCredentials({});
  await assert.rejects(
    () => tools.x_get_user_by_username.execute({ username: 'XDevelopers' }),
    (error) => error?.name === 'MissingCredentialError' && error?.credentialKey === 'X_API_BEARER_TOKEN',
  );
});
