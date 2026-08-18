// Thin fetch helpers for the 5e-bits D&D 5e SRD API (https://www.dnd5eapi.co).
// One helper per endpoint, all built on the shared apiGet plumbing — no custom
// HTTP handling here. Source docs: https://5e-bits.github.io/docs/api/
import { apiGet, requireNonEmpty } from '@raynard/plugin-sdk';

export const API_BASE = 'https://www.dnd5eapi.co';
const API_ROOT = `${API_BASE}/api/2014`;

// --- Shared shapes ---------------------------------------------------------

/** Short resource descriptor used inside list and detail payloads. */
export type ApiResourceSummary = {
  index: string;
  name: string;
  url: string;
  /** Present on spell list rows only. */
  level?: number;
};

/** Shape returned by every collection endpoint: { count, results[] }. */
export type ResourceList = {
  count: number;
  results: ApiResourceSummary[];
};

// --- API root: endpoint discovery ------------------------------------------

/** Map of endpoint name -> API path, e.g. { "spells": "/api/2014/spells" }. */
export type EndpointMap = Record<string, string>;

/** GET /api/2014/ — discover every available resource endpoint. */
export const fetchEndpoints = (): Promise<EndpointMap> =>
  apiGet<EndpointMap>(`${API_ROOT}/`, { label: 'D&D 5e API' });

// --- Generic collection + detail -------------------------------------------

export type ResourceListFilters = {
  /** Case-insensitive substring match on resource names (most endpoints). */
  name?: string;
  /** Spell/feature level, 0-9 (0 = cantrip). */
  level?: number;
  /** Magic school name for spells, e.g. "Evocation". */
  school?: string;
  /** Exact challenge rating for monsters, e.g. 0.25, 1, 13. */
  challengeRating?: number;
};

/** GET /api/2014/{endpoint} with optional server-side filters. */
export const fetchResourceList = async (
  endpoint: string,
  filters: ResourceListFilters = {}
): Promise<ResourceList> => {
  const slug = requireNonEmpty(endpoint, 'endpoint');
  return apiGet<ResourceList>(`${API_ROOT}/${encodeURIComponent(slug)}`, {
    label: `D&D 5e API (${slug})`,
    query: {
      name: filters.name,
      level: filters.level,
      school: filters.school,
      challenge_rating: filters.challengeRating
    }
  });
};

/** GET /api/2014/{endpoint}/{index} — full detail record for one resource. */
export const fetchResource = async <T = Record<string, unknown>>(
  endpoint: string,
  index: string
): Promise<T> => {
  const slug = requireNonEmpty(endpoint, 'endpoint');
  const idx = requireNonEmpty(index, 'index');
  return apiGet<T>(`${API_ROOT}/${encodeURIComponent(slug)}/${encodeURIComponent(idx)}`, {
    label: `D&D 5e API (${slug}/${idx})`
  });
};

// --- Spells ------------------------------------------------------------------

export type SpellDamage = {
  damage_type?: ApiResourceSummary;
  damage_at_slot_level?: Record<string, string>;
  damage_at_character_level?: Record<string, string>;
};

export type Spell = {
  index: string;
  name: string;
  desc?: string[];
  higher_level?: string[];
  range?: string;
  components?: string[];
  material?: string;
  ritual?: boolean;
  duration?: string;
  concentration?: boolean;
  casting_time?: string;
  level?: number;
  attack_type?: string;
  damage?: SpellDamage;
  school?: ApiResourceSummary;
  classes?: ApiResourceSummary[];
  subclasses?: ApiResourceSummary[];
  url: string;
  updated_at?: string;
};

/** GET /api/2014/spells/{index} — one spell in full detail. */
export const fetchSpell = (index: string): Promise<Spell> => fetchResource<Spell>('spells', index);

// --- Monsters ----------------------------------------------------------------

export type MonsterArmorClass = { type?: string; value: number };
export type MonsterAbility = { name: string; desc: string };

export type Monster = {
  index: string;
  name: string;
  size?: string;
  type?: string;
  subtype?: string | null;
  alignment?: string;
  armor_class?: MonsterArmorClass[];
  hit_points?: number;
  hit_dice?: string;
  hit_points_roll?: string;
  speed?: Record<string, string>;
  strength?: number;
  dexterity?: number;
  constitution?: number;
  intelligence?: number;
  wisdom?: number;
  charisma?: number;
  damage_vulnerabilities?: string[];
  damage_resistances?: string[];
  damage_immunities?: string[];
  senses?: Record<string, unknown>;
  languages?: string;
  challenge_rating?: number;
  proficiency_bonus?: number;
  xp?: number;
  special_abilities?: MonsterAbility[];
  actions?: MonsterAbility[];
  legendary_actions?: MonsterAbility[];
  reactions?: MonsterAbility[];
  /** Relative image path, e.g. "/api/images/monsters/goblin.png"; most monsters have one. */
  image?: string;
  url: string;
  updated_at?: string;
};

/** GET /api/2014/monsters/{index} — one monster stat block. */
export const fetchMonster = (index: string): Promise<Monster> =>
  fetchResource<Monster>('monsters', index);

// --- Class levels --------------------------------------------------------------

export type ClassLevel = {
  index: string;
  level: number;
  ability_score_bonuses?: number;
  prof_bonus?: number;
  features?: ApiResourceSummary[];
  spellcasting?: Record<string, number>;
  class_specific?: Record<string, unknown>;
  class?: ApiResourceSummary;
  url: string;
  updated_at?: string;
};

/**
 * GET /api/2014/classes/{classIndex}/levels — full 1-20 level progression for
 * a class. When `level` (1-20) is given, GETs the dedicated single-level
 * endpoint /levels/{level} and returns it as a one-element array.
 */
export const fetchClassLevels = async (classIndex: string, level?: number): Promise<ClassLevel[]> => {
  const slug = requireNonEmpty(classIndex, 'class index');
  const label = `D&D 5e API (class levels: ${slug})`;
  if (level !== undefined) {
    const single = await apiGet<ClassLevel>(
      `${API_ROOT}/classes/${encodeURIComponent(slug)}/levels/${level}`,
      { label }
    );
    return [single];
  }
  return apiGet<ClassLevel[]>(`${API_ROOT}/classes/${encodeURIComponent(slug)}/levels`, { label });
};

// --- Rules ---------------------------------------------------------------------

export type Rule = {
  index: string;
  name: string;
  desc?: string;
  subsections?: ApiResourceSummary[];
  url: string;
  updated_at?: string;
};

export type RuleSection = {
  index: string;
  name: string;
  desc?: string;
  url: string;
  updated_at?: string;
};

/** GET /api/2014/rules — the top-level SRD rule chapters. */
export const fetchRules = (): Promise<ResourceList> =>
  apiGet<ResourceList>(`${API_ROOT}/rules`, { label: 'D&D 5e API (rules)' });

/** GET /api/2014/rules/{index} — one rule chapter with its subsections. */
export const fetchRule = (index: string): Promise<Rule> => fetchResource<Rule>('rules', index);

/** GET /api/2014/rule-sections/{index} — full markdown text of one rule subsection. */
export const fetchRuleSection = (index: string): Promise<RuleSection> =>
  fetchResource<RuleSection>('rule-sections', index);
