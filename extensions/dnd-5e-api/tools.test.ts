// Mocked-fetch tests for every tool in the ./tools.ts registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, expectToolResult } from '@raynard/plugin-sdk/testing';
import { tools } from './tools.ts';
import { API_BASE } from './client.ts';

// --- Shared mock payloads -------------------------------------------------

const ENDPOINT_MAP = {
  'ability-scores': '/api/2014/ability-scores',
  classes: '/api/2014/classes',
  equipment: '/api/2014/equipment',
  'magic-items': '/api/2014/magic-items',
  monsters: '/api/2014/monsters',
  races: '/api/2014/races',
  rules: '/api/2014/rules',
  'rule-sections': '/api/2014/rule-sections',
  spells: '/api/2014/spells'
};

const SPELL_LIST = {
  count: 2,
  results: [
    { index: 'acid-arrow', name: 'Acid Arrow', level: 2, url: '/api/2014/spells/acid-arrow' },
    { index: 'acid-splash', name: 'Acid Splash', level: 0, url: '/api/2014/spells/acid-splash' }
  ]
};

const SPELL_ACID_ARROW = {
  index: 'acid-arrow',
  name: 'Acid Arrow',
  desc: [
    'A shimmering green arrow streaks toward a target within range and bursts in a spray of acid.'
  ],
  higher_level: [
    'When you cast this spell using a spell slot of 3rd level or higher, the damage increases by 1d4 for each slot level above 2nd.'
  ],
  range: '90 feet',
  components: ['V', 'S', 'M'],
  material: "Powdered rhubarb leaf and an adder's stomach.",
  ritual: false,
  duration: 'Instantaneous',
  concentration: false,
  casting_time: '1 action',
  level: 2,
  attack_type: 'ranged',
  damage: {
    damage_type: { index: 'acid', name: 'Acid', url: '/api/2014/damage-types/acid' },
    damage_at_slot_level: { '2': '4d4', '3': '5d4' }
  },
  school: { index: 'evocation', name: 'Evocation', url: '/api/2014/magic-schools/evocation' },
  classes: [{ index: 'wizard', name: 'Wizard', url: '/api/2014/classes/wizard' }],
  subclasses: [{ index: 'lore', name: 'Lore', url: '/api/2014/subclasses/lore' }],
  url: '/api/2014/spells/acid-arrow',
  updated_at: '2026-04-01T20:35:39.217Z'
};

const MONSTER_GOBLIN = {
  index: 'goblin',
  name: 'Goblin',
  size: 'Small',
  type: 'humanoid',
  subtype: 'goblinoid',
  alignment: 'neutral evil',
  armor_class: [{ type: 'armor', value: 15 }],
  hit_points: 7,
  hit_dice: '2d6',
  hit_points_roll: '2d6',
  speed: { walk: '30 ft.' },
  strength: 8,
  dexterity: 14,
  constitution: 10,
  intelligence: 10,
  wisdom: 8,
  charisma: 8,
  senses: { darkvision: '60 ft.', passive_perception: 9 },
  languages: 'Common, Goblin',
  challenge_rating: 0.25,
  proficiency_bonus: 2,
  xp: 50,
  special_abilities: [
    {
      name: 'Nimble Escape',
      desc: 'The goblin can take the Disengage or Hide action as a bonus action on each of its turns.'
    }
  ],
  actions: [
    {
      name: 'Scimitar',
      desc: 'Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage.'
    }
  ],
  image: '/api/images/monsters/goblin.png',
  url: '/api/2014/monsters/goblin',
  updated_at: '2026-04-01T20:35:39.217Z'
};

const EQUIPMENT_LONGSWORD = {
  index: 'longsword',
  name: 'Longsword',
  weapon_category: 'Martial',
  weapon_range: 'Melee',
  category_range: 'Martial Melee',
  cost: { quantity: 15, unit: 'gp' },
  damage: {
    damage_dice: '1d8',
    damage_type: { index: 'slashing', name: 'Slashing', url: '/api/2014/damage-types/slashing' }
  },
  weight: 3,
  url: '/api/2014/equipment/longsword',
  updated_at: '2026-04-01T20:35:39.217Z'
};

const MAGIC_ITEM_BAG = {
  index: 'bag-of-holding',
  name: 'Bag of Holding',
  equipment_category: {
    index: 'wondrous-items',
    name: 'Wondrous Items',
    url: '/api/2014/equipment-categories/wondrous-items'
  },
  rarity: { name: 'Uncommon' },
  variants: [],
  variant: false,
  desc: ['This bag has an interior space considerably larger than its outside dimensions.'],
  url: '/api/2014/magic-items/bag-of-holding',
  updated_at: '2026-04-01T20:35:39.217Z'
};

const CLASS_WIZARD = {
  index: 'wizard',
  name: 'Wizard',
  hit_die: 6,
  proficiency_choices: [],
  proficiencies: [],
  saving_throws: [],
  starting_equipment: [],
  class_levels: '/api/2014/classes/wizard/levels',
  subclasses: [],
  url: '/api/2014/classes/wizard',
  updated_at: '2026-04-01T20:35:37.787Z'
};

const WIZARD_LEVELS = [
  {
    level: 1,
    ability_score_bonuses: 0,
    prof_bonus: 2,
    features: [
      { index: 'spellcasting-wizard', name: 'Spellcasting: Wizard', url: '/api/2014/features/spellcasting-wizard' },
      { index: 'arcane-recovery', name: 'Arcane Recovery', url: '/api/2014/features/arcane-recovery' }
    ],
    spellcasting: { cantrips_known: 3, spell_slots_level_1: 2, spell_slots_level_2: 0 },
    class_specific: { arcane_recovery_levels: 1 },
    index: 'wizard-1',
    class: { index: 'wizard', name: 'Wizard', url: '/api/2014/classes/wizard' },
    url: '/api/2014/classes/wizard/levels/1',
    updated_at: '2026-04-01T20:35:37.787Z'
  },
  {
    level: 2,
    ability_score_bonuses: 0,
    prof_bonus: 2,
    features: [
      { index: 'arcane-tradition', name: 'Arcane Tradition', url: '/api/2014/features/arcane-tradition' }
    ],
    spellcasting: { cantrips_known: 3, spell_slots_level_1: 3, spell_slots_level_2: 0 },
    class_specific: { arcane_recovery_levels: 1 },
    index: 'wizard-2',
    class: { index: 'wizard', name: 'Wizard', url: '/api/2014/classes/wizard' },
    url: '/api/2014/classes/wizard/levels/2',
    updated_at: '2026-04-01T20:35:37.787Z'
  }
];

const RULES_LIST = {
  count: 2,
  results: [
    { name: 'Adventuring', index: 'adventuring', url: '/api/2014/rules/adventuring' },
    { name: 'Combat', index: 'combat', url: '/api/2014/rules/combat' }
  ]
};

const RULE_ADVENTURING = {
  name: 'Adventuring',
  index: 'adventuring',
  desc: '# Adventuring\n',
  subsections: [
    { name: 'Time', index: 'time', url: '/api/2014/rule-sections/time' },
    { name: 'Movement', index: 'movement', url: '/api/2014/rule-sections/movement' },
    { name: 'Traps', index: 'traps', url: '/api/2014/rule-sections/traps' }
  ],
  url: '/api/2014/rules/adventuring',
  updated_at: '2026-04-01T20:35:37.787Z'
};

const RULE_SECTION_ENV = {
  name: 'The Environment',
  index: 'the-environment',
  desc: '## The Environment\n\nBy its nature, adventuring involves delving into places that are dark, dangerous, and full of mysteries.\n\n### Falling\n\nA fall from a great height is one of the most common hazards facing an adventurer.',
  url: '/api/2014/rule-sections/the-environment',
  updated_at: '2026-04-01T20:35:37.787Z'
};

// --- Tests -----------------------------------------------------------------

test('dnd_list_endpoints renders every endpoint name and cites the API root', async () => {
  const fetchMock = mockFetch(() => ({ body: ENDPOINT_MAP }));
  try {
    const result = await tools.dnd_list_endpoints.execute({});
    expectToolResult(result);
    assert.match(result.text, /spells/);
    assert.match(result.text, /magic-items/);
    assert.match(result.text, /rule-sections/);
    assert.equal(result.references[0].referenceMeta.sourceUrl, `${API_BASE}/api/2014/`);
    assert.equal(fetchMock.calls[0], `${API_BASE}/api/2014/`);
  } finally {
    fetchMock.restore();
  }
});

test('dnd_list_resources renders non-empty indexes, applies filters, and cites the query', async () => {
  const fetchMock = mockFetch(() => ({ body: SPELL_LIST }));
  try {
    const result = await tools.dnd_list_resources.execute({
      endpoint: 'spells',
      name: 'Acid',
      level: 2,
      school: 'Evocation'
    });
    expectToolResult(result);
    assert.match(result.text, /2 resources?/i);
    assert.match(result.text, /acid-arrow/);
    assert.match(result.text, /acid-splash/);
    assert.match(result.text, /Acid Arrow/);
    assert.equal(
      fetchMock.calls[0],
      `${API_BASE}/api/2014/spells?name=Acid&level=2&school=Evocation`
    );
    const listRef = result.references[0];
    assert.equal(listRef.referenceMeta.sourceUrl, fetchMock.calls[0]);
    // Item-level citations exist for follow-up quoting.
    const itemIds = result.references.map((r) => r.referenceId);
    assert.ok(itemIds.includes('acid-arrow') && itemIds.includes('acid-splash'));
  } finally {
    fetchMock.restore();
  }
});

test('dnd_list_resources reports empty result sets without crashing', async () => {
  const fetchMock = mockFetch(() => ({ body: { count: 0, results: [] } }));
  try {
    const result = await tools.dnd_list_resources.execute({ endpoint: 'monsters', name: 'Tarrasque Jr' });
    expectToolResult(result);
    assert.match(result.text, /[Nn]o monsters resources matched/);
    assert.match(result.text, /Tarrasque Jr/);
  } finally {
    fetchMock.restore();
  }
});

test('dnd_list_resources rejects a missing endpoint argument', async () => {
  const fetchMock = mockFetch(() => ({ body: SPELL_LIST }));
  try {
    await assert.rejects(() => tools.dnd_list_resources.execute({}), /endpoint must be a non-empty string/);
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test('dnd_get_resource renders a generic record summary with the raw payload cited', async () => {
  const fetchMock = mockFetch(() => ({ body: EQUIPMENT_LONGSWORD }));
  try {
    const result = await tools.dnd_get_resource.execute({ endpoint: 'equipment', index: 'longsword' });
    expectToolResult(result);
    assert.match(result.text, /Longsword/);
    assert.match(result.text, /weapon_category: Martial/);
    assert.match(result.text, /weight: 3/);
    const ref = result.references[0];
    assert.equal(ref.referenceId, 'longsword');
    assert.equal(ref.referenceMeta.sourceUrl, `${API_BASE}/api/2014/equipment/longsword`);
    assert.match(ref.expandedContent[2].text, /damage_dice/);
    assert.equal(fetchMock.calls[0], `${API_BASE}/api/2014/equipment/longsword`);
  } finally {
    fetchMock.restore();
  }
});

test('dnd_get_spell renders level, school, casting details and description', async () => {
  const fetchMock = mockFetch(() => ({ body: SPELL_ACID_ARROW }));
  try {
    const result = await tools.dnd_get_spell.execute({ index: 'acid-arrow' });
    expectToolResult(result);
    assert.match(result.text, /Acid Arrow/);
    assert.match(result.text, /level 2/i);
    assert.match(result.text, /Evocation/);
    assert.match(result.text, /Casting time: 1 action/);
    assert.match(result.text, /Range: 90 feet/);
    assert.match(result.text, /V, S, M/);
    assert.match(result.text, /shimmering green arrow/);
    assert.match(result.text, /higher levels/i);
    const ref = result.references[0];
    assert.equal(ref.referenceId, 'acid-arrow');
    assert.equal(ref.referenceMeta.sourceUrl, `${API_BASE}/api/2014/spells/acid-arrow`);
    assert.match(ref.expandedContent[2].text, /acid-arrow/);
  } finally {
    fetchMock.restore();
  }
});

test('dnd_get_monster renders combat stats and abilities', async () => {
  const fetchMock = mockFetch(() => ({ body: MONSTER_GOBLIN }));
  try {
    const result = await tools.dnd_get_monster.execute({ index: 'goblin' });
    expectToolResult(result);
    assert.match(result.text, /Goblin/);
    assert.match(result.text, /Small humanoid/);
    assert.match(result.text, /AC 15/);
    assert.match(result.text, /HP 7 \(2d6\)/);
    assert.match(result.text, /STR 8 \(-1\)/);
    assert.match(result.text, /DEX 14 \(\+2\)/);
    assert.match(result.text, /CR 0\.25 \(50 XP\)/);
    assert.match(result.text, /Nimble Escape/);
    assert.match(result.text, /Scimitar/);
    assert.match(result.text, /Image: https:\/\/www\.dnd5eapi\.co\/api\/images\/monsters\/goblin\.png/);
    const ref = result.references[0];
    assert.equal(ref.referenceId, 'goblin');
    assert.equal(ref.referenceMeta.sourceUrl, `${API_BASE}/api/2014/monsters/goblin`);
  } finally {
    fetchMock.restore();
  }
});

test('dnd_get_class_levels renders full progression and honours the level filter', async () => {
  const fetchMock = mockFetch((url) =>
    url.endsWith('/levels/1') ? { body: WIZARD_LEVELS[0] } : { body: WIZARD_LEVELS }
  );
  try {
    const full = await tools.dnd_get_class_levels.execute({ class_index: 'wizard' });
    expectToolResult(full);
    assert.match(full.text, /Wizard/);
    assert.match(full.text, /Level 1:/);
    assert.match(full.text, /Level 2:/);
    assert.match(full.text, /proficiency bonus \+2/i);
    assert.match(full.text, /Arcane Recovery/);
    assert.match(full.text, /Arcane Tradition/);
    assert.equal(fetchMock.calls[0], `${API_BASE}/api/2014/classes/wizard/levels`);
    assert.match(full.references[0].expandedContent[2].text, /wizard-1/);

    const single = await tools.dnd_get_class_levels.execute({ class_index: 'wizard', level: 1 });
    expectToolResult(single);
    assert.match(single.text, /Level 1:/);
    assert.doesNotMatch(single.text, /Level 2:/);
    assert.match(single.text, /Arcane Recovery/);
    assert.equal(fetchMock.calls[1], `${API_BASE}/api/2014/classes/wizard/levels/1`);
    assert.equal(single.references[0].referenceMeta.sourceUrl, fetchMock.calls[1]);
  } finally {
    fetchMock.restore();
  }
});

test('dnd_get_class_levels rejects an out-of-range level', async () => {
  const fetchMock = mockFetch(() => ({ body: WIZARD_LEVELS }));
  try {
    await assert.rejects(
      () => tools.dnd_get_class_levels.execute({ class_index: 'wizard', level: 99 }),
      /level must be an integer between 1 and 20/
    );
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test('dnd_list_rules renders the top-level rule chapters', async () => {
  const fetchMock = mockFetch(() => ({ body: RULES_LIST }));
  try {
    const result = await tools.dnd_list_rules.execute({});
    expectToolResult(result);
    assert.match(result.text, /Adventuring/);
    assert.match(result.text, /Combat/);
    assert.match(result.text, /adventuring/);
    assert.equal(fetchMock.calls[0], `${API_BASE}/api/2014/rules`);
  } finally {
    fetchMock.restore();
  }
});

test('dnd_get_rule renders a chapter with its subsection indexes', async () => {
  const fetchMock = mockFetch(() => ({ body: RULE_ADVENTURING }));
  try {
    const result = await tools.dnd_get_rule.execute({ index: 'adventuring' });
    expectToolResult(result);
    assert.match(result.text, /Adventuring/);
    assert.match(result.text, /Time/);
    assert.match(result.text, /Movement/);
    assert.match(result.text, /traps/);
    const ref = result.references[0];
    assert.equal(ref.referenceId, 'adventuring');
    assert.equal(ref.referenceMeta.sourceUrl, `${API_BASE}/api/2014/rules/adventuring`);
  } finally {
    fetchMock.restore();
  }
});

test('dnd_get_rule_section renders the rules markdown text', async () => {
  const fetchMock = mockFetch(() => ({ body: RULE_SECTION_ENV }));
  try {
    const result = await tools.dnd_get_rule_section.execute({ index: 'the-environment' });
    expectToolResult(result);
    assert.match(result.text, /The Environment/);
    assert.match(result.text, /Falling/);
    assert.match(result.text, /dark, dangerous/);
    const ref = result.references[0];
    assert.equal(ref.referenceId, 'the-environment');
    assert.equal(ref.referenceMeta.sourceUrl, `${API_BASE}/api/2014/rule-sections/the-environment`);
    assert.match(ref.expandedContent[2].text, /Falling/);
  } finally {
    fetchMock.restore();
  }
});

test('dnd_get_resource declares a card and returns matching data fields', async () => {
  const fetchMock = mockFetch(() => ({ body: EQUIPMENT_LONGSWORD }));
  try {
    const card = tools.dnd_get_resource.card;
    assert.ok(card, 'dnd_get_resource must declare a card');
    assert.deepEqual(
      card.layout.map((block) => block.component),
      ['Columns', 'Section'],
      'resource card must be a Columns row (summary + illustration) followed by the details Section'
    );
    const columnsBlock = card.layout[0] as {
      component: 'Columns';
      columns: Array<{ width?: number; layout: Array<{ component: string; field?: string }> }>;
    };
    assert.equal(columnsBlock.columns[0].width, 3, 'summary column must take 75% of the width');
    assert.equal(columnsBlock.columns[1].width, 1, 'illustration column must take 25% of the width');
    const imageBlock = columnsBlock.columns[1].layout[0];
    assert.equal(imageBlock.component, 'Image', 'illustration must sit in the right-hand column');
    assert.equal(imageBlock.field, 'image');
    const result = await tools.dnd_get_resource.execute({ endpoint: 'equipment', index: 'longsword' });
    expectToolResult(result);
    const data = result.data as {
      name: string;
      kind: string;
      description: string;
      image: string;
      stats: Array<{ label: string; value: string }>;
      fields: Array<{ label: string; value: string }>;
    };
    assert.equal(data.name, 'Longsword');
    assert.equal(data.kind, 'equipment');
    assert.equal(data.image, '', 'no illustration when the record has no image field');
    // Curated, formatted highlights replace the raw scalar dump on the card.
    const stats = new Map(data.stats.map((row) => [row.label, row.value]));
    assert.equal(stats.get('Cost'), '15 gp');
    assert.equal(stats.get('Damage'), '1d8 Slashing');
    assert.equal(stats.get('Weight'), '3 lb');
    assert.equal(stats.get('Weapon category'), 'Martial');
    // Raw scalars remain available in data for drill-down.
    assert.ok(Array.isArray(data.fields));
    const labels = data.fields.map((f) => f.label);
    assert.ok(labels.includes('weapon_category'));
    assert.equal(data.fields.find((f) => f.label === 'weight')?.value, '3');
  } finally {
    fetchMock.restore();
  }
});

test('dnd_get_resource tailors stats per endpoint type and skips false-flag noise', async () => {
  const fetchMock = mockFetch((url) =>
    url.includes('/magic-items/') ? { body: MAGIC_ITEM_BAG } : { body: CLASS_WIZARD }
  );
  try {
    const item = await tools.dnd_get_resource.execute({ endpoint: 'magic-items', index: 'bag-of-holding' });
    expectToolResult(item);
    const itemData = item.data as { stats: Array<{ label: string; value: string }>; description: string };
    const itemStats = new Map(itemData.stats.map((row) => [row.label, row.value]));
    assert.equal(itemStats.get('Rarity'), 'Uncommon');
    assert.equal(itemStats.get('Equipment category'), 'Wondrous Items');
    assert.ok(!itemStats.has('Variant'), 'false flags like variant: false must not appear as stats');
    assert.match(itemData.description, /interior space/);

    const cls = await tools.dnd_get_resource.execute({ endpoint: 'classes', index: 'wizard' });
    expectToolResult(cls);
    const clsData = cls.data as { stats: Array<{ label: string; value: string }> };
    const clsStats = new Map(clsData.stats.map((row) => [row.label, row.value]));
    assert.equal(clsStats.get('Hit die'), 'd6');
    assert.ok(!clsStats.has('Class levels'), 'raw API paths must not appear as stats');
  } finally {
    fetchMock.restore();
  }
});

test('dnd_get_spell declares a card and returns matching data fields', async () => {
  const fetchMock = mockFetch(() => ({ body: SPELL_ACID_ARROW }));
  try {
    assert.ok(tools.dnd_get_spell.card, 'dnd_get_spell must declare a card');
    const result = await tools.dnd_get_spell.execute({ index: 'acid-arrow' });
    expectToolResult(result);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.name, 'Acid Arrow');
    assert.match(String(data.subtitle), /Level 2 Evocation spell/);
    assert.equal(data.level, '2');
    assert.equal(data.school, 'Evocation');
    assert.equal(data.casting_time, '1 action');
    assert.equal(data.range, '90 feet');
    assert.equal(data.duration, 'Instantaneous');
    assert.match(String(data.components), /V, S, M/);
    assert.equal(data.concentration, 'no');
    assert.equal(data.ritual, 'no');
    assert.match(String(data.damage), /4d4 Acid/);
    assert.equal(data.classes, 'Wizard');
    assert.match(String(data.description), /shimmering green arrow/);
  } finally {
    fetchMock.restore();
  }
});

test('dnd_get_monster declares a card and returns matching data fields', async () => {
  const fetchMock = mockFetch(() => ({ body: MONSTER_GOBLIN }));
  try {
    const card = tools.dnd_get_monster.card;
    assert.ok(card, 'dnd_get_monster must declare a card');
    const components = card.layout.map((block) => block.component);
    assert.deepEqual(
      components,
      ['Columns', 'Section'],
      'monster card must be a Columns row (stats + illustration) followed by the traits Section'
    );
    const columnsBlock = card.layout[0] as unknown as {
      component: 'Columns';
      columns: Array<{ width?: number; layout: Array<{ component: string; field?: string }> }>;
    };
    assert.equal(columnsBlock.columns.length, 2, 'monster card must have two columns');
    assert.equal(columnsBlock.columns[0].width, 3, 'stat column must take 75% of the width');
    assert.equal(columnsBlock.columns[1].width, 1, 'illustration column must take 25% of the width');
    const imageBlock = columnsBlock.columns[1].layout[0];
    assert.equal(imageBlock.component, 'Image', 'illustration must sit in the right-hand column');
    assert.equal(imageBlock.field, 'image_url');
    assert.ok(!('size' in imageBlock), 'image block must not set a size field');
    const result = await tools.dnd_get_monster.execute({ index: 'goblin' });
    expectToolResult(result);
    const data = result.data as {
      name: string;
      subtitle: string;
      armor_class: string;
      hit_points: string;
      challenge_rating: string;
      speed: string;
      senses: string;
      languages: string;
      proficiency_bonus: string;
      image_url: string;
      ability_scores: Array<Record<string, string>>;
      features: Array<{ name: string; kind: string; desc: string }>;
    };
    assert.equal(data.name, 'Goblin');
    assert.match(data.subtitle, /Small humanoid \(goblinoid\), neutral evil/);
    assert.equal(data.armor_class, '15');
    assert.equal(data.hit_points, '7 (2d6)');
    assert.equal(data.challenge_rating, '0.25 (50 XP)');
    assert.equal(data.speed, 'walk 30 ft.');
    assert.match(data.senses, /darkvision 60 ft\./);
    assert.equal(data.languages, 'Common, Goblin');
    assert.equal(data.proficiency_bonus, '+2');
    assert.equal(data.image_url, 'https://www.dnd5eapi.co/api/images/monsters/goblin.png');
    assert.equal(data.ability_scores[0].str, '8 (-1)');
    assert.equal(data.ability_scores[0].dex, '14 (+2)');
    const kinds = data.features.map((f) => `${f.kind}:${f.name}`);
    assert.ok(kinds.includes('Trait:Nimble Escape'));
    assert.ok(kinds.includes('Action:Scimitar'));
  } finally {
    fetchMock.restore();
  }
});

test('tools propagate API errors with the failing URL in the message', async () => {
  const fetchMock = mockFetch(() => ({ status: 404, body: { error: 'Not found' } }));
  try {
    await assert.rejects(
      () => tools.dnd_get_spell.execute({ index: 'not-a-spell' }),
      /HTTP 404.*not-a-spell/
    );
  } finally {
    fetchMock.restore();
  }
});

test('every D&D API tool declares a result card', () => {
  for (const [name, tool] of Object.entries(tools)) {
    assert.ok(tool.card, `${name} must declare a card`);
    assert.ok(tool.card.layout.length > 0, `${name} card must have layout blocks`);
  }
});
