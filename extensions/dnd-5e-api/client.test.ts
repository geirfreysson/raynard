// Mocked-fetch tests for the D&D 5e API client helpers in ./client.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch } from '@raynard/plugin-sdk/testing';
import {
  API_BASE,
  fetchEndpoints,
  fetchResourceList,
  fetchResource,
  fetchSpell,
  fetchMonster,
  fetchClassLevels,
  fetchRules,
  fetchRule,
  fetchRuleSection
} from './client.ts';

const ENDPOINT_MAP = {
  'ability-scores': '/api/2014/ability-scores',
  classes: '/api/2014/classes',
  monsters: '/api/2014/monsters',
  spells: '/api/2014/spells'
};

const SPELL_LIST = {
  count: 2,
  results: [
    { index: 'acid-arrow', name: 'Acid Arrow', level: 2, url: '/api/2014/spells/acid-arrow' },
    { index: 'acid-splash', name: 'Acid Splash', level: 0, url: '/api/2014/spells/acid-splash' }
  ]
};

test('fetchEndpoints hits the API root and returns the endpoint map', async () => {
  const fetchMock = mockFetch(() => ({ body: ENDPOINT_MAP }));
  try {
    const map = await fetchEndpoints();
    assert.deepEqual(map, ENDPOINT_MAP);
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0], `${API_BASE}/api/2014/`);
  } finally {
    fetchMock.restore();
  }
});

test('fetchResourceList without filters requests the bare endpoint URL', async () => {
  const fetchMock = mockFetch(() => ({ body: SPELL_LIST }));
  try {
    const list = await fetchResourceList('spells');
    assert.equal(list.count, 2);
    assert.deepEqual(list.results.map((r) => r.index), ['acid-arrow', 'acid-splash']);
    assert.equal(fetchMock.calls[0], `${API_BASE}/api/2014/spells`);
  } finally {
    fetchMock.restore();
  }
});

test('fetchResourceList forwards name/level/school filters as query params', async () => {
  const fetchMock = mockFetch(() => ({ body: SPELL_LIST }));
  try {
    const list = await fetchResourceList('spells', { name: 'Acid', level: 1, school: 'Evocation' });
    assert.equal(list.count, 2);
    assert.equal(
      fetchMock.calls[0],
      `${API_BASE}/api/2014/spells?name=Acid&level=1&school=Evocation`
    );
  } finally {
    fetchMock.restore();
  }
});

test('fetchResourceList maps challengeRating to the challenge_rating query param', async () => {
  const fetchMock = mockFetch(() => ({
    body: { count: 1, results: [{ index: 'goblin', name: 'Goblin', url: '/api/2014/monsters/goblin' }] }
  }));
  try {
    const list = await fetchResourceList('monsters', { challengeRating: 0.25 });
    assert.equal(list.results[0].index, 'goblin');
    assert.equal(fetchMock.calls[0], `${API_BASE}/api/2014/monsters?challenge_rating=0.25`);
  } finally {
    fetchMock.restore();
  }
});

test('fetchResourceList rejects an empty endpoint name', async () => {
  const fetchMock = mockFetch(() => ({ body: SPELL_LIST }));
  try {
    await assert.rejects(() => fetchResourceList('   '), /endpoint must be a non-empty string/);
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test('fetchResource fetches a single record by endpoint and index', async () => {
  const fetchMock = mockFetch(() => ({ body: { index: 'longsword', name: 'Longsword' } }));
  try {
    const record = await fetchResource<{ index: string; name: string }>('equipment', 'longsword');
    assert.equal(record.name, 'Longsword');
    assert.equal(fetchMock.calls[0], `${API_BASE}/api/2014/equipment/longsword`);
  } finally {
    fetchMock.restore();
  }
});

test('fetchSpell returns a typed spell record', async () => {
  const fetchMock = mockFetch(() => ({
    body: {
      index: 'acid-arrow',
      name: 'Acid Arrow',
      level: 2,
      desc: ['A shimmering green arrow streaks toward a target.'],
      school: { index: 'evocation', name: 'Evocation', url: '/api/2014/magic-schools/evocation' },
      url: '/api/2014/spells/acid-arrow'
    }
  }));
  try {
    const spell = await fetchSpell('acid-arrow');
    assert.equal(spell.name, 'Acid Arrow');
    assert.equal(spell.level, 2);
    assert.equal(spell.school?.name, 'Evocation');
    assert.equal(fetchMock.calls[0], `${API_BASE}/api/2014/spells/acid-arrow`);
  } finally {
    fetchMock.restore();
  }
});

test('fetchMonster returns a typed monster record', async () => {
  const fetchMock = mockFetch(() => ({
    body: {
      index: 'goblin',
      name: 'Goblin',
      size: 'Small',
      type: 'humanoid',
      hit_points: 7,
      challenge_rating: 0.25,
      xp: 50,
      url: '/api/2014/monsters/goblin'
    }
  }));
  try {
    const monster = await fetchMonster('goblin');
    assert.equal(monster.name, 'Goblin');
    assert.equal(monster.challenge_rating, 0.25);
    assert.equal(fetchMock.calls[0], `${API_BASE}/api/2014/monsters/goblin`);
  } finally {
    fetchMock.restore();
  }
});

test('fetchClassLevels requests the levels collection, or one level via /levels/{n}', async () => {
  const allBody = [
    { level: 1, prof_bonus: 2, index: 'wizard-1', url: '/api/2014/classes/wizard/levels/1' },
    { level: 2, prof_bonus: 2, index: 'wizard-2', url: '/api/2014/classes/wizard/levels/2' }
  ];
  const oneBody = { level: 3, prof_bonus: 2, index: 'wizard-3', url: '/api/2014/classes/wizard/levels/3' };
  const fetchMock = mockFetch((url) =>
    url.endsWith('/levels/3') ? { body: oneBody } : { body: allBody }
  );
  try {
    const all = await fetchClassLevels('wizard');
    assert.equal(all.length, 2);
    assert.equal(all[0].level, 1);
    assert.equal(fetchMock.calls[0], `${API_BASE}/api/2014/classes/wizard/levels`);

    const one = await fetchClassLevels('wizard', 3);
    assert.equal(one.length, 1);
    assert.equal(one[0].index, 'wizard-3');
    assert.equal(fetchMock.calls[1], `${API_BASE}/api/2014/classes/wizard/levels/3`);
  } finally {
    fetchMock.restore();
  }
});

test('fetchRules lists the top-level rule chapters', async () => {
  const fetchMock = mockFetch(() => ({
    body: {
      count: 2,
      results: [
        { name: 'Adventuring', index: 'adventuring', url: '/api/2014/rules/adventuring' },
        { name: 'Combat', index: 'combat', url: '/api/2014/rules/combat' }
      ]
    }
  }));
  try {
    const rules = await fetchRules();
    assert.equal(rules.count, 2);
    assert.deepEqual(rules.results.map((r) => r.index), ['adventuring', 'combat']);
    assert.equal(fetchMock.calls[0], `${API_BASE}/api/2014/rules`);
  } finally {
    fetchMock.restore();
  }
});

test('fetchRule returns a rule chapter with its subsections', async () => {
  const fetchMock = mockFetch(() => ({
    body: {
      name: 'Adventuring',
      index: 'adventuring',
      desc: '# Adventuring\n',
      subsections: [{ name: 'Time', index: 'time', url: '/api/2014/rule-sections/time' }],
      url: '/api/2014/rules/adventuring'
    }
  }));
  try {
    const rule = await fetchRule('adventuring');
    assert.equal(rule.name, 'Adventuring');
    assert.equal(rule.subsections?.[0].index, 'time');
    assert.equal(fetchMock.calls[0], `${API_BASE}/api/2014/rules/adventuring`);
  } finally {
    fetchMock.restore();
  }
});

test('fetchRuleSection returns the markdown rules text for a subsection', async () => {
  const fetchMock = mockFetch(() => ({
    body: {
      name: 'The Environment',
      index: 'the-environment',
      desc: '## The Environment\n\n### Falling\n\nA fall from a great height deals 1d6 damage per 10 feet.',
      url: '/api/2014/rule-sections/the-environment'
    }
  }));
  try {
    const section = await fetchRuleSection('the-environment');
    assert.match(section.desc ?? '', /Falling/);
    assert.equal(fetchMock.calls[0], `${API_BASE}/api/2014/rule-sections/the-environment`);
  } finally {
    fetchMock.restore();
  }
});

test('client helpers surface HTTP errors from the API', async () => {
  const fetchMock = mockFetch(() => ({ status: 404, body: { error: 'Not found' } }));
  try {
    await assert.rejects(() => fetchSpell('not-a-spell'), /HTTP 404/);
  } finally {
    fetchMock.restore();
  }
});
