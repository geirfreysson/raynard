import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch } from '@raynard/plugin-sdk/testing';
import { fetchTrendsByWoeid, fetchTweet, fetchUserByUsername, fetchUserTweets, searchRecentTweets } from './client.ts';

const body = { data: [{ id: '1930000000000000000', text: 'Hello from X API', author_id: '2244994945' }], meta: { result_count: 1 } };

test('searchRecentTweets calls literal X recent search URL with query fields and paging parameters', async () => {
  const fetchMock = mockFetch((url) => {
    assert.equal(url, 'https://api.x.com/2/tweets/search/recent?query=from%3AXDevelopers&max_results=10&next_token=PAGE2&tweet.fields=id%2Ctext%2Cauthor_id%2Ccreated_at%2Cpublic_metrics%2Cconversation_id%2Clang%2Csource%2Creferenced_tweets&expansions=author_id%2Creferenced_tweets.id%2Creferenced_tweets.id.author_id&user.fields=id%2Cname%2Cusername%2Cverified%2Cpublic_metrics%2Cdescription%2Clocation%2Curl%2Ccreated_at%2Cprofile_image_url');
    return { body };
  });
  try {
    const result = await searchRecentTweets({ query: 'from:XDevelopers', max_results: 10, next_token: 'PAGE2', bearerToken: 'TEST_TOKEN' });
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(result.data?.[0]?.id, '1930000000000000000');
  } finally { fetchMock.restore(); }
});

test('fetchTweet calls the X tweet lookup endpoint with fields', async () => {
  const fetchMock = mockFetch((url) => {
    assert.equal(url, 'https://api.x.com/2/tweets/1930000000000000000?tweet.fields=id%2Ctext%2Cauthor_id%2Ccreated_at%2Cpublic_metrics%2Cconversation_id%2Clang%2Csource%2Creferenced_tweets&expansions=author_id%2Creferenced_tweets.id%2Creferenced_tweets.id.author_id&user.fields=id%2Cname%2Cusername%2Cverified%2Cpublic_metrics%2Cdescription%2Clocation%2Curl%2Ccreated_at%2Cprofile_image_url');
    return { body: { data: { id: '1930000000000000000', text: 'Hello' } } };
  });
  try {
    const result = await fetchTweet({ id: '1930000000000000000', bearerToken: 'TEST_TOKEN' });
    assert.equal(result.data?.id, '1930000000000000000');
  } finally { fetchMock.restore(); }
});

test('fetchUserByUsername strips @ and calls the X username endpoint', async () => {
  const fetchMock = mockFetch((url) => {
    assert.equal(url, 'https://api.x.com/2/users/by/username/XDevelopers?user.fields=id%2Cname%2Cusername%2Cverified%2Cpublic_metrics%2Cdescription%2Clocation%2Curl%2Ccreated_at%2Cprofile_image_url');
    return { body: { data: { id: '2244994945', name: 'X Developers', username: 'XDevelopers' } } };
  });
  try {
    const result = await fetchUserByUsername({ username: '@XDevelopers', bearerToken: 'TEST_TOKEN' });
    assert.equal(result.data?.id, '2244994945');
  } finally { fetchMock.restore(); }
});

test('fetchUserTweets calls user timeline endpoint with pagination and filters', async () => {
  const fetchMock = mockFetch((url) => {
    assert.equal(url, 'https://api.x.com/2/users/2244994945/tweets?max_results=5&pagination_token=PAGE&start_time=2026-08-24T00%3A00%3A00Z&exclude=retweets&tweet.fields=id%2Ctext%2Cauthor_id%2Ccreated_at%2Cpublic_metrics%2Cconversation_id%2Clang%2Csource%2Creferenced_tweets&expansions=author_id&user.fields=id%2Cname%2Cusername%2Cverified%2Cpublic_metrics%2Cdescription%2Clocation%2Curl%2Ccreated_at%2Cprofile_image_url');
    return { body };
  });
  try {
    const result = await fetchUserTweets({ id: '2244994945', max_results: 5, pagination_token: 'PAGE', start_time: '2026-08-24T00:00:00Z', exclude: 'retweets', bearerToken: 'TEST_TOKEN' });
    assert.equal(result.data?.[0]?.id, '1930000000000000000');
  } finally { fetchMock.restore(); }
});

test('fetchTrendsByWoeid calls the literal X trends endpoint with its bounded result limit', async () => {
  const fetchMock = mockFetch((url) => {
    assert.equal(url, 'https://api.x.com/2/trends/by/woeid/44418?max_trends=25&trend.fields=trend_name%2Ctweet_count');
    return { body: { data: [{ trend_name: '#London', tweet_count: 42000 }] } };
  });
  try {
    const result = await fetchTrendsByWoeid({ woeid: 44418, max_trends: 25, bearerToken: 'TEST_TOKEN' });
    assert.equal(result.data?.[0]?.trend_name, '#London');
  } finally { fetchMock.restore(); }
});
