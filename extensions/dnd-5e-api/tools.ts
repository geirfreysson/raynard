// Tool registry for the D&D 5e SRD API plugin — one focused tool per common
// question, all fetch helpers from ./client.ts, all citations via
// createApiReference from the shared Raynard plugin SDK.
import {
  buildQuery,
  createApiReference,
  defineCard,
  defineTools,
  requireNonEmpty,
  type ApiReference,
  type ApiTool,
  type ToolResult
} from '@raynard/plugin-sdk';
import {
  API_BASE,
  fetchClassLevels,
  fetchEndpoints,
  fetchMonster,
  fetchResource,
  fetchResourceList,
  fetchRule,
  fetchRuleSection,
  fetchRules,
  fetchSpell
} from './client.ts';
import type { ClassLevel, Monster, Spell } from './client.ts';

// --- Shared constants + small arg/render helpers ----------------------------

/** Every collection endpoint exposed by GET /api/2014/ (verified live). */
const ENDPOINTS = [
  'ability-scores',
  'alignments',
  'backgrounds',
  'classes',
  'conditions',
  'damage-types',
  'equipment',
  'equipment-categories',
  'feats',
  'features',
  'languages',
  'magic-items',
  'magic-schools',
  'monsters',
  'proficiencies',
  'races',
  'rule-sections',
  'rules',
  'skills',
  'spells',
  'subclasses',
  'subraces',
  'traits',
  'weapon-properties'
] as const;

const MAGIC_SCHOOLS = [
  'Abjuration',
  'Conjuration',
  'Divination',
  'Enchantment',
  'Evocation',
  'Illusion',
  'Necromancy',
  'Transmutation'
] as const;

const MAX_LIST_ROWS = 50;
const MAX_ITEM_REFERENCES = 10;
const MAX_RULE_SECTION_CHARS = 4000;

const optString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const optNumber = (value: unknown, label: string): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${label} must be a number, received: ${String(value)}`);
  }
  return numeric;
};

const optIntInRange = (
  value: unknown,
  label: string,
  min: number,
  max: number
): number | undefined => {
  const numeric = optNumber(value, label);
  if (numeric === undefined) return undefined;
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}, received: ${numeric}`);
  }
  return numeric;
};

const fullUrl = (path: string): string =>
  path.startsWith('http') ? path : `${API_BASE}${path}`;

const abilityModifier = (score: number): string => {
  const mod = Math.floor((score - 10) / 2);
  return mod >= 0 ? `+${mod}` : `${mod}`;
};

const yesNo = (flag: boolean | undefined): string => (flag ? 'yes' : 'no');

const ordinal = (n: number): string =>
  n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;

/** Describe the filters applied to a list query, for readable result text. */
const describeFilters = (filters: {
  name?: string;
  level?: number;
  school?: string;
  challengeRating?: number;
}): string => {
  const parts: string[] = [];
  if (filters.name) parts.push(`name contains "${filters.name}"`);
  if (filters.level !== undefined) parts.push(`level ${filters.level}`);
  if (filters.school) parts.push(`school ${filters.school}`);
  if (filters.challengeRating !== undefined)
    parts.push(`challenge rating ${filters.challengeRating}`);
  return parts.length ? ` (filters: ${parts.join(', ')})` : '';
};

/** Render a spellcasting/class_specific numeric map, skipping zero values. */
const renderSpellcasting = (spellcasting: Record<string, number> | undefined): string[] => {
  if (!spellcasting) return [];
  const parts: string[] = [];
  for (const [key, value] of Object.entries(spellcasting)) {
    if (typeof value !== 'number' || value <= 0) continue;
    const slotMatch = /^spell_slots_level_(\d)$/.exec(key);
    const label = slotMatch
      ? `${ordinal(Number(slotMatch[1]))}-level spell slots`
      : key.replace(/_/g, ' ');
    parts.push(`${label} ${value}`);
  }
  return parts;
};

const renderClassLevelLine = (row: ClassLevel): string => {
  const parts: string[] = [];
  if (row.prof_bonus !== undefined) parts.push(`proficiency bonus +${row.prof_bonus}`);
  if (row.features?.length) {
    parts.push(`features: ${row.features.map((f) => f.name).join(', ')}`);
  } else {
    parts.push('features: none');
  }
  parts.push(...renderSpellcasting(row.spellcasting));
  return `Level ${row.level}: ${parts.join('; ')}`;
};

/** Flatten a record's scalar fields into label/value rows (skips noisy keys). */
const collectScalars = (
  record: Record<string, unknown>,
  max = 12
): Array<{ label: string; value: string }> => {
  const skip = new Set(['index', 'name', 'url', 'updated_at', 'desc', 'image']);
  const fields: Array<{ label: string; value: string }> = [];
  for (const [key, value] of Object.entries(record)) {
    if (fields.length >= max) break;
    if (skip.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      fields.push({ label: key, value: String(value) });
    }
  }
  return fields;
};

const summarizeScalars = (record: Record<string, unknown>, max = 12): string[] =>
  collectScalars(record, max).map((field) => `- ${field.label}: ${field.value}`);

/** Join a resource's desc (string or string[]) into one description block. */
const resourceDescription = (record: Record<string, unknown>): string => {
  if (Array.isArray(record.desc) && record.desc.length) {
    return (record.desc as unknown[]).join('\n\n');
  }
  return typeof record.desc === 'string' && record.desc.trim() ? record.desc : '';
};

/** Humanize a raw record key for display, e.g. "weapon_category" -> "Weapon category". */
const humanizeKey = (key: string): string =>
  key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Display name of an API reference object, e.g. { name: 'Uncommon' } -> 'Uncommon'. */
const referenceName = (value: unknown): string =>
  value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string'
    ? (value as { name: string }).name
    : '';

/**
 * Curated, human-readable highlight rows for a generic resource record.
 * Understands the common SRD shapes — cost, damage dice, armor class, ranges,
 * weight, rarity, categories, hit die, speed — and falls back to the record's
 * own scalar fields, skipping noise like `variant: false`, nulls, empty values
 * and raw API paths.
 */
const resourceStats = (
  record: Record<string, unknown>,
  max = 12
): Array<{ label: string; value: string }> => {
  const rows: Array<{ label: string; value: string }> = [];
  const handled = new Set(['index', 'name', 'url', 'updated_at', 'desc', 'image']);
  const push = (label: string, value: string): void => {
    if (value && rows.length < max) rows.push({ label, value });
  };
  const cost = record.cost as { quantity?: unknown; unit?: unknown } | undefined;
  if (cost && typeof cost.quantity === 'number') {
    push('Cost', `${cost.quantity} ${typeof cost.unit === 'string' ? cost.unit : ''}`.trim());
    handled.add('cost');
  }
  const damageBits = (key: string, label: string): void => {
    const damage = record[key] as { damage_dice?: unknown; damage_type?: unknown } | undefined;
    if (damage && typeof damage.damage_dice === 'string') {
      push(label, `${damage.damage_dice} ${referenceName(damage.damage_type)}`.trim());
      handled.add(key);
    }
  };
  damageBits('damage', 'Damage');
  damageBits('two_handed_damage', 'Two-handed damage');
  const armorClass = record.armor_class as
    | { base?: unknown; dex_bonus?: unknown; max_bonus?: unknown }
    | undefined;
  if (armorClass && typeof armorClass.base === 'number') {
    let value = String(armorClass.base);
    if (armorClass.dex_bonus === true) {
      value += typeof armorClass.max_bonus === 'number' ? ` + Dex (max ${armorClass.max_bonus})` : ' + Dex';
    }
    push('Armor class', value);
    handled.add('armor_class');
  }
  const rangeBits = (key: string, label: string): void => {
    const range = record[key] as { normal?: unknown; long?: unknown } | undefined;
    if (range && typeof range.normal === 'number') {
      push(
        label,
        typeof range.long === 'number' && range.long !== range.normal
          ? `${range.normal}/${range.long} ft.`
          : `${range.normal} ft.`
      );
      handled.add(key);
    }
  };
  rangeBits('range', 'Range');
  rangeBits('throw_range', 'Throw range');
  if (typeof record.weight === 'number') {
    push('Weight', `${record.weight} lb`);
    handled.add('weight');
  }
  if (typeof record.hit_die === 'number') {
    push('Hit die', `d${record.hit_die}`);
    handled.add('hit_die');
  }
  if (typeof record.speed === 'number') {
    push('Speed', `${record.speed} ft.`);
    handled.add('speed');
  } else {
    const speed = record.speed as { quantity?: unknown; unit?: unknown } | undefined;
    if (speed && typeof speed.quantity === 'number') {
      push('Speed', `${speed.quantity} ${typeof speed.unit === 'string' ? speed.unit : ''}`.trim());
      handled.add('speed');
    }
  }
  // Reference objects worth surfacing by name (rarity, categories, ability score).
  for (const key of [
    'rarity',
    'equipment_category',
    'armor_category',
    'gear_category',
    'tool_category',
    'vehicle_category',
    'ability_score'
  ]) {
    if (handled.has(key)) continue;
    const value = referenceName(record[key]);
    if (value) {
      push(humanizeKey(key), value);
      handled.add(key);
    }
  }
  // Remaining scalar fields, skipping noise (false flags, nulls, empties, API paths).
  for (const [key, value] of Object.entries(record)) {
    if (rows.length >= max) break;
    if (handled.has(key) || value === null || value === false || value === '') continue;
    if (typeof value === 'string' && !value.startsWith('/api/')) {
      push(humanizeKey(key), value);
    } else if (typeof value === 'number') {
      push(humanizeKey(key), String(value));
    } else if (value === true) {
      push(humanizeKey(key), 'yes');
    }
  }
  return rows;
};

/** One-line damage summary for a spell, e.g. "4d4 Acid". '' when not damaging. */
const spellDamageLabel = (spell: Spell): string => {
  const damageType = spell.damage?.damage_type?.name ?? '';
  const slotDamage = spell.damage?.damage_at_slot_level;
  if (slotDamage && spell.level !== undefined) {
    const dice = slotDamage[String(spell.level)] ?? Object.values(slotDamage)[0];
    if (dice) return `${dice} ${damageType}`.trim();
  }
  const charDamage = spell.damage?.damage_at_character_level;
  if (charDamage) {
    const dice = Object.values(charDamage)[0];
    if (dice) return `${dice} ${damageType}`.trim();
  }
  return '';
};

/** "14 (+2)" style ability-score label; '' when the score is missing. */
const abilityScoreLabel = (score: number | undefined): string =>
  score === undefined ? '' : `${score} (${abilityModifier(score)})`;

const renderMonsterAbilities = (title: string, abilities: Monster['special_abilities']): string[] => {
  if (!abilities?.length) return [];
  return [title, ...abilities.map((a) => `- ${a.name}: ${a.desc}`)];
};

const renderSpellText = (spell: Spell): string => {
  const schoolName = spell.school?.name ?? 'Unknown school';
  const heading =
    spell.level === 0
      ? `${spell.name} — ${schoolName} cantrip`
      : `${spell.name} — level ${spell.level ?? '?'} ${schoolName} spell`;
  const lines = [heading];
  const castingBits = [
    spell.casting_time ? `Casting time: ${spell.casting_time}` : '',
    spell.range ? `Range: ${spell.range}` : '',
    spell.duration ? `Duration: ${spell.duration}` : '',
    `Concentration: ${yesNo(spell.concentration)}`,
    `Ritual: ${yesNo(spell.ritual)}`
  ].filter(Boolean);
  lines.push(`- ${castingBits.join(' | ')}`);
  if (spell.components?.length) {
    lines.push(
      `- Components: ${spell.components.join(', ')}${spell.material ? ` — ${spell.material}` : ''}`
    );
  }
  const extra: string[] = [];
  if (spell.attack_type) extra.push(`Attack type: ${spell.attack_type}`);
  const slotDamage = spell.damage?.damage_at_slot_level;
  if (slotDamage && spell.level !== undefined) {
    const dice = slotDamage[String(spell.level)] ?? Object.values(slotDamage)[0];
    if (dice) extra.push(`Damage: ${dice} ${spell.damage?.damage_type?.name ?? ''}`.trimEnd());
  }
  const charDamage = spell.damage?.damage_at_character_level;
  if (charDamage) {
    const dice = Object.values(charDamage)[0];
    if (dice) extra.push(`Damage: ${dice} ${spell.damage?.damage_type?.name ?? ''}`.trimEnd());
  }
  if (extra.length) lines.push(`- ${extra.join(' | ')}`);
  if (spell.desc?.length) lines.push(`Description: ${spell.desc.join('\n\n')}`);
  if (spell.higher_level?.length) lines.push(`At higher levels: ${spell.higher_level.join(' ')}`);
  if (spell.classes?.length)
    lines.push(`Classes: ${spell.classes.map((c) => c.name).join(', ')}`);
  if (spell.subclasses?.length)
    lines.push(`Subclasses: ${spell.subclasses.map((c) => c.name).join(', ')}`);
  return lines.join('\n');
};

const renderMonsterText = (monster: Monster): string => {
  const subtype = monster.subtype ? ` (${monster.subtype})` : '';
  const lines = [
    `${monster.name} — ${monster.size ?? 'Unknown size'} ${monster.type ?? 'creature'}${subtype}${
      monster.alignment ? `, ${monster.alignment}` : ''
    }`
  ];
  if (monster.image) lines.push(`Image: ${fullUrl(monster.image)}`);
  const ac = monster.armor_class?.map((a) => a.value).join(' + ');
  const speed = monster.speed
    ? Object.entries(monster.speed)
        .map(([mode, value]) => `${mode} ${value}`)
        .join(', ')
    : '';
  const combat = [
    ac ? `AC ${ac}` : '',
    monster.hit_points !== undefined
      ? `HP ${monster.hit_points}${monster.hit_dice ? ` (${monster.hit_dice})` : ''}`
      : '',
    speed ? `Speed: ${speed}` : ''
  ].filter(Boolean);
  if (combat.length) lines.push(`- ${combat.join(' | ')}`);
  const abilities: Array<[string, number | undefined]> = [
    ['STR', monster.strength],
    ['DEX', monster.dexterity],
    ['CON', monster.constitution],
    ['INT', monster.intelligence],
    ['WIS', monster.wisdom],
    ['CHA', monster.charisma]
  ];
  if (abilities.some(([, v]) => v !== undefined)) {
    lines.push(
      `- ${abilities
        .filter(([, v]) => v !== undefined)
        .map(([label, score]) => `${label} ${score} (${abilityModifier(score as number)})`)
        .join(' | ')}`
    );
  }
  const meta = [
    monster.challenge_rating !== undefined
      ? `CR ${monster.challenge_rating}${monster.xp !== undefined ? ` (${monster.xp} XP)` : ''}`
      : '',
    monster.proficiency_bonus !== undefined ? `Proficiency bonus +${monster.proficiency_bonus}` : ''
  ].filter(Boolean);
  if (meta.length) lines.push(`- ${meta.join(' | ')}`);
  const senses = monster.senses
    ? Object.entries(monster.senses)
        .map(([key, value]) => `${key.replace(/_/g, ' ')} ${value}`)
        .join(', ')
    : '';
  const extras = [senses ? `Senses: ${senses}` : '', monster.languages ? `Languages: ${monster.languages}` : ''].filter(
    Boolean
  );
  if (extras.length) lines.push(`- ${extras.join(' | ')}`);
  lines.push(...renderMonsterAbilities('Special abilities:', monster.special_abilities));
  lines.push(...renderMonsterAbilities('Actions:', monster.actions));
  lines.push(...renderMonsterAbilities('Legendary actions:', monster.legendary_actions));
  return lines.join('\n');
};

// --- Tool registry -----------------------------------------------------------

export const tools = defineTools({
  dnd_list_endpoints: {
    description:
      'Answers "what D&D 5e data can I look up?" Fetches the API root of the 5e-bits D&D 5e SRD API and lists every available resource endpoint (spells, monsters, equipment, magic-items, classes, subclasses, races, subraces, features, traits, conditions, damage-types, rules, rule-sections, and more) with its API path. Takes no arguments. Follow up with dnd_list_resources to browse one endpoint.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    card: defineCard({
      name: { singular: 'endpoint', plural: 'endpoints' },
      title: 'D&D 5e API resources',
      layout: [
        { component: 'MetricRow', items: [{ label: 'Endpoints', field: 'count' }] },
        {
          component: 'Table',
          columns: [
            { header: 'Resource', field: 'name' },
            { header: 'API path', field: 'path' }
          ],
          rows: 'endpoints'
        }
      ]
    }),
    async execute(): Promise<ToolResult> {
      const map = await fetchEndpoints();
      const names = Object.keys(map).sort();
      const lines = names.map((name) => `- ${name} — ${fullUrl(map[name])}`);
      return {
        text: `The D&D 5e SRD API exposes ${names.length} resource endpoints:\n${lines.join('\n')}\n\nUse dnd_list_resources with one of these endpoint names to browse its records.`,
        data: {
          count: names.length,
          endpoints: names.map((name) => ({ name, path: map[name] }))
        },
        references: [
          createApiReference({
            id: 'dnd5e-api-root',
            label: 'D&D 5e API root — endpoint map',
            sourceUrl: `${API_BASE}/api/2014/`,
            quote: `${names.length} endpoints: ${names.join(', ')}`,
            payload: map
          })
        ]
      };
    }
  },

  dnd_list_resources: {
    description:
      'Browses one D&D 5e resource endpoint and returns the matching resources with their index slugs, names, and API URLs. Optional server-side filters: name substring (most endpoints), spell level 0-9 and magic school (spells endpoint), exact challenge rating (monsters endpoint), level (features endpoint). Use dnd_list_endpoints to discover endpoint names; follow up with dnd_get_resource, dnd_get_spell, or dnd_get_monster for full detail on one result.',
    parameters: {
      type: 'object',
      required: ['endpoint'],
      properties: {
        endpoint: {
          type: 'string',
          enum: [...ENDPOINTS],
          description:
            'Resource endpoint to list, e.g. "spells", "monsters", "equipment", "magic-items", "classes", "races", "conditions".'
        },
        name: {
          type: 'string',
          description:
            'Optional case-insensitive substring filter on resource names, e.g. "Acid" matches "Acid Arrow" and "Acid Splash".'
        },
        level: {
          type: 'integer',
          minimum: 0,
          maximum: 9,
          description:
            'Optional spell level filter (0 = cantrips, 1-9 = spell levels). Meaningful for the spells and features endpoints.'
        },
        school: {
          type: 'string',
          enum: [...MAGIC_SCHOOLS],
          description: 'Optional magic school filter; only applies to the spells endpoint.'
        },
        challenge_rating: {
          type: 'number',
          description:
            'Optional exact challenge rating filter (e.g. 0.125, 0.25, 1, 13); only applies to the monsters endpoint.'
        }
      }
    },
    card: defineCard({
      name: { singular: 'resource', plural: 'resources' },
      title: 'D&D 5e {{endpoint}}',
      layout: [
        { component: 'MetricRow', items: [{ label: 'Matches', field: 'count' }] },
        {
          component: 'Table',
          columns: [
            { header: 'Index', field: 'index' },
            { header: 'Name', field: 'name' },
            { header: 'Level', field: 'level' }
          ],
          rows: 'resources'
        }
      ]
    }),
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const endpoint = requireNonEmpty(args?.endpoint, 'endpoint');
      const filters = {
        name: optString(args?.name),
        level: optIntInRange(args?.level, 'level', 0, 9),
        school: optString(args?.school),
        challengeRating: optNumber(args?.challenge_rating, 'challenge_rating')
      };
      const list = await fetchResourceList(endpoint, filters);
      const filterText = describeFilters(filters);
      const requestUrl = `${API_BASE}/api/2014/${encodeURIComponent(endpoint)}${buildQuery({
        name: filters.name,
        level: filters.level,
        school: filters.school,
        challenge_rating: filters.challengeRating
      })}`;

      if (list.count === 0 || list.results.length === 0) {
        return {
          text: `No ${endpoint} resources matched your query${filterText}. Try relaxing the filters (for example a broader name substring).`,
          data: { endpoint, count: 0, resources: [] },
          references: [
            createApiReference({
              id: `list:${endpoint}`,
              label: `D&D 5e list: ${endpoint} (0 results)`,
              sourceUrl: requestUrl,
              quote: `Empty result set for ${endpoint}${filterText}.`,
              payload: list
            })
          ]
        };
      }

      const rows = list.results.slice(0, MAX_LIST_ROWS).map((r) => {
        const levelBit = typeof r.level === 'number' ? ` (level ${r.level})` : '';
        return `- ${r.name} — index: ${r.index}${levelBit} — ${fullUrl(r.url)}`;
      });
      const truncated =
        list.results.length > MAX_LIST_ROWS
          ? `\n… and ${list.results.length - MAX_LIST_ROWS} more (full list is in the citation payload).`
          : '';
      const header = `${list.count} resource${list.count === 1 ? '' : 's'} found in "${endpoint}"${filterText}:`;

      const references: ApiReference[] = [
        createApiReference({
          id: `list:${endpoint}${filterText ? `${buildQuery({ name: filters.name, level: filters.level, school: filters.school, challenge_rating: filters.challengeRating })}` : ''}`,
          label: `D&D 5e list: ${endpoint} (${list.count} results)`,
          sourceUrl: requestUrl,
          quote: `${list.count} results including ${list.results
            .slice(0, 5)
            .map((r) => r.name)
            .join(', ')}`,
          payload: list
        }),
        ...list.results.slice(0, MAX_ITEM_REFERENCES).map((r) =>
          createApiReference({
            id: r.index,
            label: r.name,
            sourceUrl: fullUrl(r.url),
            quote: `${r.name} — ${endpoint} resource with index "${r.index}"${typeof r.level === 'number' ? ` (level ${r.level})` : ''}.`,
            payload: r
          })
        )
      ];

      return {
        text: `${header}\n${rows.join('\n')}${truncated}`,
        data: {
          endpoint,
          count: list.count,
          resources: list.results.slice(0, MAX_LIST_ROWS).map((resource) => ({
            index: resource.index,
            name: resource.name,
            level: resource.level ?? '—'
          }))
        },
        references
      };
    }
  },

  dnd_get_resource: {
    description:
      'Fetches the complete JSON record for any D&D 5e resource by endpoint + index slug, e.g. equipment "longsword", magic-items "bag-of-holding", classes "wizard", races "elf", conditions "prone", damage-types "fire", ability-scores "str", skills "stealth", traits "darkvision". Renders a readable summary and cites the full raw payload; the result card leads with type-specific highlights (cost, damage dice, armor class, rarity, hit die, …) and an illustration when the API provides one. Prefer dnd_get_spell or dnd_get_monster when the target is a spell or monster; find index slugs with dnd_list_resources.',
    parameters: {
      type: 'object',
      required: ['endpoint', 'index'],
      properties: {
        endpoint: {
          type: 'string',
          enum: [...ENDPOINTS],
          description: 'Resource endpoint containing the record, e.g. "equipment" or "magic-items".'
        },
        index: {
          type: 'string',
          description:
            'Index slug of the record, e.g. "longsword", "bag-of-holding", "wizard". Find slugs with dnd_list_resources.'
        }
      }
    },
    card: defineCard({
      name: { singular: 'resource', plural: 'resources' },
      title: '{{name}}',
      layout: [
        // Summary on the left (75%), illustration on the right (25%) when the
        // API provides one; curated type-specific highlights full-width below.
        {
          component: 'Columns',
          gap: 'md',
          collapseBelow: 'sm',
          columns: [
            {
              width: 3,
              layout: [
                { component: 'Badge', field: 'kind', tone: 'muted' },
                { component: 'Text', text: '{{description}}' }
              ]
            },
            {
              width: 1,
              layout: [
                {
                  component: 'Image',
                  field: 'image',
                  alt: 'Resource illustration',
                  variant: 'media',
                  fit: 'contain'
                }
              ]
            }
          ]
        },
        {
          component: 'Section',
          title: 'Details',
          layout: [
            {
              component: 'Table',
              columns: [
                { header: 'Property', field: 'label' },
                { header: 'Value', field: 'value' }
              ],
              rows: 'stats'
            }
          ]
        }
      ]
    }),
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const endpoint = requireNonEmpty(args?.endpoint, 'endpoint');
      const index = requireNonEmpty(args?.index, 'index');
      const record = await fetchResource<Record<string, unknown>>(endpoint, index);
      const name = typeof record.name === 'string' ? record.name : index;
      const description = resourceDescription(record);
      const fields = collectScalars(record);
      const stats = resourceStats(record);
      const image =
        typeof record.image === 'string' && record.image ? fullUrl(record.image) : '';
      const lines = [`${name} — ${endpoint}/${index}`];
      if (description) lines.push(`Description: ${description}`);
      lines.push(...summarizeScalars(record));
      return {
        text: lines.join('\n'),
        data: { name, kind: endpoint, description, image, stats, fields },
        references: [
          createApiReference({
            id: index,
            label: name,
            sourceUrl: `${API_BASE}/api/2014/${encodeURIComponent(endpoint)}/${encodeURIComponent(index)}`,
            quote: `${name} (${endpoint} record, index "${index}")`,
            payload: record
          })
        ]
      };
    }
  },

  dnd_get_spell: {
    description:
      'Fetches one D&D 5e spell by index slug and renders its level, magic school, casting time, range, components, duration, concentration/ritual flags, damage, full description, at-higher-levels text, and which classes/subclasses can cast it. Example indexes: "acid-arrow", "fireball", "cure-wounds". Find spell indexes with dnd_list_resources (endpoint "spells", optional level/school/name filters).',
    parameters: {
      type: 'object',
      required: ['index'],
      properties: {
        index: {
          type: 'string',
          description: 'Spell index slug, e.g. "acid-arrow" or "fireball".'
        }
      }
    },
    card: defineCard({
      name: { singular: 'spell', plural: 'spells' },
      title: '{{name}}',
      layout: [
        { component: 'Text', text: '{{subtitle}}' },
        {
          component: 'MetricRow',
          items: [
            { label: 'Level', field: 'level' },
            { label: 'Casting time', field: 'casting_time' },
            { label: 'Range', field: 'range' },
            { label: 'Duration', field: 'duration' }
          ]
        },
        {
          component: 'KeyValue',
          pairs: [
            { label: 'School', field: 'school' },
            { label: 'Components', field: 'components' },
            { label: 'Concentration', field: 'concentration' },
            { label: 'Ritual', field: 'ritual' },
            { label: 'Damage', field: 'damage' },
            { label: 'Classes', field: 'classes' }
          ]
        },
        { component: 'Text', text: '{{description}}' }
      ]
    }),
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const index = requireNonEmpty(args?.index, 'index');
      const spell = await fetchSpell(index);
      const quoteBits = [
        spell.level === 0 ? 'Cantrip' : `Level ${spell.level ?? '?'}`,
        spell.school?.name ?? '',
        spell.desc?.[0] ?? ''
      ].filter(Boolean);
      const schoolName = spell.school?.name ?? 'Unknown school';
      return {
        text: renderSpellText(spell),
        data: {
          name: spell.name,
          subtitle:
            spell.level === 0
              ? `${schoolName} cantrip`
              : `Level ${spell.level ?? '?'} ${schoolName} spell`,
          level: spell.level === 0 ? 'Cantrip' : `${spell.level ?? '?'}`,
          school: schoolName,
          casting_time: spell.casting_time ?? '',
          range: spell.range ?? '',
          duration: spell.duration ?? '',
          components: spell.components?.length
            ? `${spell.components.join(', ')}${spell.material ? ` — ${spell.material}` : ''}`
            : '',
          concentration: yesNo(spell.concentration),
          ritual: yesNo(spell.ritual),
          damage: spellDamageLabel(spell),
          classes: spell.classes?.map((c) => c.name).join(', ') ?? '',
          description: spell.desc?.join('\n\n') ?? ''
        },
        references: [
          createApiReference({
            id: spell.index,
            label: spell.name,
            sourceUrl: fullUrl(spell.url),
            quote: quoteBits.join(' — '),
            payload: spell
          })
        ]
      };
    }
  },

  dnd_get_monster: {
    description:
      'Fetches one D&D 5e monster stat block by index slug and renders size/type/alignment, armor class, hit points, speed, the six ability scores with modifiers, challenge rating and XP, senses, languages, special abilities, actions, and legendary actions. When the API provides one, the monster\'s illustration is rendered as an image on the right side of the result card, occupying 25% of its width. Example indexes: "goblin", "adult-red-dragon", "tarrasque". Find monster indexes with dnd_list_resources (endpoint "monsters", optional challenge_rating/name filters).',
    parameters: {
      type: 'object',
      required: ['index'],
      properties: {
        index: {
          type: 'string',
          description: 'Monster index slug, e.g. "goblin" or "adult-red-dragon".'
        }
      }
    },
    card: defineCard({
      name: { singular: 'monster', plural: 'monsters' },
      title: '{{name}}',
      layout: [
        // Stats on the left (75%), illustration on the right (25%).
        {
          component: 'Columns',
          columns: [
            {
              width: 3,
              layout: [
                { component: 'Badge', field: 'subtitle', tone: 'muted' },
                {
                  component: 'MetricRow',
                  items: [
                    { label: 'AC', field: 'armor_class' },
                    { label: 'HP', field: 'hit_points' },
                    { label: 'CR', field: 'challenge_rating' },
                    { label: 'Speed', field: 'speed' }
                  ]
                },
                {
                  component: 'Table',
                  columns: [
                    { header: 'STR', field: 'str' },
                    { header: 'DEX', field: 'dex' },
                    { header: 'CON', field: 'con' },
                    { header: 'INT', field: 'int' },
                    { header: 'WIS', field: 'wis' },
                    { header: 'CHA', field: 'cha' }
                  ],
                  rows: 'ability_scores'
                },
                {
                  component: 'KeyValue',
                  pairs: [
                    { label: 'Senses', field: 'senses' },
                    { label: 'Languages', field: 'languages' },
                    { label: 'Proficiency bonus', field: 'proficiency_bonus' }
                  ]
                }
              ]
            },
            {
              width: 1,
              layout: [
                {
                  component: 'Image',
                  field: 'image_url',
                  alt: 'Monster illustration',
                  variant: 'media',
                  fit: 'contain'
                }
              ]
            }
          ]
        },
        {
          component: 'Section',
          title: 'Traits & actions',
          layout: [
            {
              component: 'Table',
              columns: [
                { header: 'Name', field: 'name' },
                { header: 'Type', field: 'kind' },
                { header: 'Description', field: 'desc' }
              ],
              rows: 'features'
            }
          ]
        }
      ]
    }),
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const index = requireNonEmpty(args?.index, 'index');
      const monster = await fetchMonster(index);
      const quote = [
        `${monster.size ?? ''} ${monster.type ?? 'creature'}`.trim(),
        monster.challenge_rating !== undefined
          ? `CR ${monster.challenge_rating}${monster.xp !== undefined ? ` (${monster.xp} XP)` : ''}`
          : '',
        monster.hit_points !== undefined ? `HP ${monster.hit_points}` : ''
      ]
        .filter(Boolean)
        .join(', ');
      const speed = monster.speed
        ? Object.entries(monster.speed)
            .map(([mode, value]) => `${mode} ${value}`)
            .join(', ')
        : '';
      const senses = monster.senses
        ? Object.entries(monster.senses)
            .map(([key, value]) => `${key.replace(/_/g, ' ')} ${value}`)
            .join(', ')
        : '';
      return {
        text: renderMonsterText(monster),
        data: {
          name: monster.name,
          subtitle: `${monster.size ?? 'Unknown size'} ${monster.type ?? 'creature'}${
            monster.subtype ? ` (${monster.subtype})` : ''
          }${monster.alignment ? `, ${monster.alignment}` : ''}`,
          armor_class: monster.armor_class?.map((a) => a.value).join(' + ') ?? '',
          hit_points:
            monster.hit_points !== undefined
              ? `${monster.hit_points}${monster.hit_dice ? ` (${monster.hit_dice})` : ''}`
              : '',
          challenge_rating:
            monster.challenge_rating !== undefined
              ? `${monster.challenge_rating}${monster.xp !== undefined ? ` (${monster.xp} XP)` : ''}`
              : '',
          speed,
          proficiency_bonus:
            monster.proficiency_bonus !== undefined ? `+${monster.proficiency_bonus}` : '',
          image_url: monster.image ? fullUrl(monster.image) : '',
          senses,
          languages: monster.languages ?? '',
          ability_scores: [
            {
              str: abilityScoreLabel(monster.strength),
              dex: abilityScoreLabel(monster.dexterity),
              con: abilityScoreLabel(monster.constitution),
              int: abilityScoreLabel(monster.intelligence),
              wis: abilityScoreLabel(monster.wisdom),
              cha: abilityScoreLabel(monster.charisma)
            }
          ],
          features: [
            ...(monster.special_abilities ?? []).map((a) => ({
              name: a.name,
              kind: 'Trait',
              desc: a.desc
            })),
            ...(monster.actions ?? []).map((a) => ({ name: a.name, kind: 'Action', desc: a.desc })),
            ...(monster.legendary_actions ?? []).map((a) => ({
              name: a.name,
              kind: 'Legendary action',
              desc: a.desc
            }))
          ]
        },
        references: [
          createApiReference({
            id: monster.index,
            label: monster.name,
            sourceUrl: fullUrl(monster.url),
            quote: `${monster.name} — ${quote}`,
            payload: monster
          })
        ]
      };
    }
  },

  dnd_get_class_levels: {
    description:
      'Fetches the level progression table for one D&D 5e class: proficiency bonus, class features gained per level, and spellcasting slot counts. Optionally narrow to a single level (1-20). Example class indexes: "wizard", "fighter", "rogue", "cleric". Answers questions like "what does a wizard get at level 3?" or "how many spell slots does a level 5 cleric have?". Follow up with dnd_get_resource (endpoint "features") for details on a named feature.',
    parameters: {
      type: 'object',
      required: ['class_index'],
      properties: {
        class_index: {
          type: 'string',
          description: 'Class index slug, e.g. "wizard", "fighter", "rogue".'
        },
        level: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Optional single level to fetch (1-20). Omit for the full 1-20 progression.'
        }
      }
    },
    card: defineCard({
      name: { singular: 'class level', plural: 'class levels' },
      title: '{{className}} progression',
      layout: [
        { component: 'MetricRow', items: [{ label: 'Levels', field: 'count' }] },
        {
          component: 'Table',
          columns: [
            { header: 'Level', field: 'level' },
            { header: 'Progression', field: 'summary' }
          ],
          rows: 'levels'
        }
      ]
    }),
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const classIndex = requireNonEmpty(args?.class_index, 'class_index');
      const level = optIntInRange(args?.level, 'level', 1, 20);
      const levels = await fetchClassLevels(classIndex, level);
      const className = levels[0]?.class?.name ?? classIndex;
      const requestUrl = `${API_BASE}/api/2014/classes/${encodeURIComponent(classIndex)}/levels${level !== undefined ? `/${level}` : ''}`;
      if (levels.length === 0) {
        return {
          text: `No class level data returned for "${classIndex}"${level !== undefined ? ` at level ${level}` : ''}. Check the class index with dnd_list_resources (endpoint "classes").`,
          data: { className, count: 0, levels: [] },
          references: [
            createApiReference({
              id: `class-levels:${classIndex}`,
              label: `${className} class levels (empty)`,
              sourceUrl: requestUrl,
              quote: `Empty class level response for ${classIndex}.`,
              payload: levels
            })
          ]
        };
      }
      const lines = levels.map(renderClassLevelLine);
      const scope = level !== undefined ? `level ${level}` : `${levels.length} level${levels.length === 1 ? '' : 's'}`;
      return {
        text: `${className} level progression — ${scope} returned:\n${lines.join('\n')}`,
        data: {
          className,
          count: levels.length,
          levels: levels.map((entry) => ({
            level: entry.level,
            summary: renderClassLevelLine(entry)
          }))
        },
        references: [
          createApiReference({
            id: `class-levels:${classIndex}${level !== undefined ? `:${level}` : ''}`,
            label: `${className} class levels${level !== undefined ? ` (level ${level})` : ''}`,
            sourceUrl: requestUrl,
            quote: `${className} progression: ${lines[0] ?? 'no levels'}`,
            payload: levels
          })
        ]
      };
    }
  },

  dnd_list_rules: {
    description:
      'Lists the top-level D&D 5e SRD rule chapters (Adventuring, Appendix, Combat, Equipment, Spellcasting, Using Ability Scores) with their index slugs. Answers "what rules topics exist?". Follow up with dnd_get_rule for a chapter\'s subsections, then dnd_get_rule_section for the full rules text.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    card: defineCard({
      name: { singular: 'rule chapter', plural: 'rule chapters' },
      title: 'D&D 5e rule chapters',
      layout: [
        { component: 'MetricRow', items: [{ label: 'Chapters', field: 'count' }] },
        {
          component: 'Table',
          columns: [
            { header: 'Index', field: 'index' },
            { header: 'Chapter', field: 'name' }
          ],
          rows: 'rules'
        }
      ]
    }),
    async execute(): Promise<ToolResult> {
      const rules = await fetchRules();
      const lines = rules.results.map((r) => `- ${r.name} — index: ${r.index} — ${fullUrl(r.url)}`);
      return {
        text: `D&D 5e SRD rule chapters (${rules.count}):\n${lines.join('\n')}\n\nUse dnd_get_rule with one of these indexes to see its subsections.`,
        data: {
          count: rules.count,
          rules: rules.results.map((rule) => ({ index: rule.index, name: rule.name }))
        },
        references: [
          createApiReference({
            id: 'rules-list',
            label: `D&D 5e rules (${rules.count} chapters)`,
            sourceUrl: `${API_BASE}/api/2014/rules`,
            quote: `${rules.count} rule chapters: ${rules.results.map((r) => r.name).join(', ')}`,
            payload: rules
          })
        ]
      };
    }
  },

  dnd_get_rule: {
    description:
      'Fetches one top-level D&D 5e SRD rule chapter by index (adventuring, appendix, combat, equipment, spellcasting, using-ability-scores) and lists its subsections with their index slugs. Answers "what does the combat chapter cover?". Follow up with dnd_get_rule_section to read the full markdown text of any subsection.',
    parameters: {
      type: 'object',
      required: ['index'],
      properties: {
        index: {
          type: 'string',
          enum: ['adventuring', 'appendix', 'combat', 'equipment', 'spellcasting', 'using-ability-scores'],
          description: 'Rule chapter index slug, e.g. "combat" or "adventuring".'
        }
      }
    },
    card: defineCard({
      name: { singular: 'rule chapter', plural: 'rule chapters' },
      title: '{{name}}',
      layout: [
        {
          component: 'KeyValue',
          pairs: [{ label: 'Subsections', field: 'subsectionCount' }]
        },
        { component: 'Text', text: '{{description}}' },
        {
          component: 'Table',
          columns: [
            { header: 'Index', field: 'index' },
            { header: 'Subsection', field: 'name' }
          ],
          rows: 'subsections'
        }
      ]
    }),
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const index = requireNonEmpty(args?.index, 'index');
      const rule = await fetchRule(index);
      const subsections = rule.subsections ?? [];
      const lines = [`${rule.name} — D&D 5e rule chapter`];
      if (rule.desc?.trim()) lines.push(rule.desc.trim());
      if (subsections.length) {
        lines.push(`Subsections (${subsections.length}):`);
        lines.push(...subsections.map((s) => `- ${s.name} — index: ${s.index}`));
        lines.push('Use dnd_get_rule_section with a subsection index for the full rules text.');
      } else {
        lines.push('This chapter has no subsections.');
      }
      return {
        text: lines.join('\n'),
        data: {
          name: rule.name,
          description: rule.desc?.trim() ?? '',
          subsectionCount: subsections.length,
          subsections: subsections.map((section) => ({
            index: section.index,
            name: section.name
          }))
        },
        references: [
          createApiReference({
            id: rule.index,
            label: rule.name,
            sourceUrl: fullUrl(rule.url),
            quote: `${rule.name} rule chapter with ${subsections.length} subsections: ${subsections
              .map((s) => s.name)
              .join(', ')}`,
            payload: rule
          })
        ]
      };
    }
  },

  dnd_get_rule_section: {
    description:
      'Fetches the full markdown rules text for one D&D 5e SRD rule subsection by index, e.g. "time", "movement", "the-environment", "traps", "diseases", "madness", "resting", "making-an-attack", "spell-level". Answers "what are the exact rules for X?". Find subsection indexes with dnd_get_rule. Long sections are truncated in the text output; the complete markdown is always in the citation payload.',
    parameters: {
      type: 'object',
      required: ['index'],
      properties: {
        index: {
          type: 'string',
          description: 'Rule subsection index slug, e.g. "the-environment" or "making-an-attack".'
        }
      }
    },
    card: defineCard({
      name: { singular: 'rule section', plural: 'rule sections' },
      title: '{{name}}',
      layout: [{ component: 'Text', text: '{{description}}' }]
    }),
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const index = requireNonEmpty(args?.index, 'index');
      const section = await fetchRuleSection(index);
      const desc = section.desc?.trim() ?? '';
      const truncated = desc.length > MAX_RULE_SECTION_CHARS;
      const shown = truncated ? `${desc.slice(0, MAX_RULE_SECTION_CHARS)}\n\n…(truncated — full markdown is in the citation payload)` : desc;
      return {
        text: `${section.name} (D&D 5e rule section)\n\n${shown || 'No rules text returned.'}`,
        data: {
          name: section.name,
          description: shown || 'No rules text returned.'
        },
        references: [
          createApiReference({
            id: section.index,
            label: section.name,
            sourceUrl: fullUrl(section.url),
            quote: desc.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.trim() ?? section.name,
            payload: section
          })
        ]
      };
    }
  }
});
