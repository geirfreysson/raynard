# Dnd 5e Api

Access Dungeons & Dragons 5th Edition rule data via the 5e-bits API. Capabilities include: listing all available resource endpoints (spells, monsters, equipment, ability scores, skills, proficiencies, languages, classes, subclasses, features, class levels, races, subraces, traits, equipment categories, magic items, weapon properties, conditions, damage types, and more); fetching paginated lists of resources by type; retrieving detailed information for specific resources by index (e.g., a specific spell, monster, or magic item); and accessing rule sections and subsections. Supports query parameters for level filtering, school filtering, and other resource-specific filters where available.

Base URL: `https://www.dnd5eapi.co/api/2014` — free, no authentication, no API keys.

## Status

Implemented and tested. Nine Explore-mode tools cover endpoint discovery, filtered
resource listing, generic and focused detail lookups (spells, monsters), class level
progression, and SRD rules browsing. Run the mocked test suite with:

```sh
node --test
```

## Implemented Tools

| Tool | What it answers / fetches |
| --- | --- |
| `dnd_list_endpoints` | "What D&D data can I look up?" — `GET /api/2014/` endpoint map (24 endpoints). |
| `dnd_list_resources` | Filtered browsing of any endpoint. Filters: `name` substring (all endpoints), `level` 0-9 + `school` (spells/features), `challenge_rating` (monsters). Renders up to 50 rows; full list + up to 10 item citations attached. |
| `dnd_get_resource` | Full record for any `endpoint` + `index` (equipment, magic-items, classes, races, conditions, damage-types, ability-scores, skills, traits, …). Cites the complete raw payload. |
| `dnd_get_spell` | One spell by index: level, school, casting time, range, components, duration, damage, description, at-higher-levels, classes/subclasses. |
| `dnd_get_monster` | One monster by index: illustration (rendered as an image on the result card when the API provides one), size/type/alignment, AC, HP, speed, ability scores + modifiers, CR/XP, senses, languages, special abilities, actions, legendary actions. |
| `dnd_get_class_levels` | Class level progression (proficiency bonus, features per level, spell slots). Optional `level` 1-20 fetches the dedicated `/levels/{n}` endpoint for a single level. |
| `dnd_list_rules` | The six top-level SRD rule chapters. |
| `dnd_get_rule` | One rule chapter with its subsection index slugs. |
| `dnd_get_rule_section` | Full markdown rules text of one subsection (truncated at 4000 chars in text; complete markdown in the citation payload). |

All tools return `{ text, references }`; every reference is built with the shared
`createApiReference` plumbing and carries the source URL plus the raw API payload.

## Endpoint Inventory

| Endpoint | Purpose | Parameters | Response shape | Status | Tool |
| --- | --- | --- | --- | --- | --- |
| `GET /api/2014/` | Discover all resource endpoints | none | `{ endpointName: path, … }` (24 entries) | Implemented | `dnd_list_endpoints` |
| `GET /api/2014/{endpoint}` | List resources of one type | `name` (substring, most endpoints), `level` (spells/features), `school` (spells), `challenge_rating` (monsters). No pagination — returns the whole collection | `{ count, results: [{ index, name, url, level? }] }` | Implemented | `dnd_list_resources` (covers all 24 collections: ability-scores, alignments, backgrounds, classes, conditions, damage-types, equipment, equipment-categories, feats, features, languages, magic-items, magic-schools, monsters, proficiencies, races, rule-sections, rules, skills, spells, subclasses, subraces, traits, weapon-properties) |
| `GET /api/2014/{endpoint}/{index}` | Detail record for any resource | path: `endpoint`, `index` | Resource-specific JSON object (always has `index`, `name`, `url`, `updated_at`) | Implemented | `dnd_get_resource` |
| `GET /api/2014/spells/{index}` | Spell detail | path: `index` | `desc[]`, `higher_level[]`, `range`, `components[]`, `level`, `school`, `damage`, `classes[]`, `subclasses[]`, … | Implemented | `dnd_get_spell` |
| `GET /api/2014/monsters/{index}` | Monster stat block | path: `index` | `armor_class[]`, `hit_points`, `speed{}`, six ability scores, `challenge_rating`, `xp`, `special_abilities[]`, `actions[]`, … | Implemented | `dnd_get_monster` |
| `GET /api/2014/classes/{index}/levels` | Full class progression 1-20 | path: class `index`. (The `?level=` query param is ignored by the live API.) | `ClassLevel[]` (`level`, `prof_bonus`, `features[]`, `spellcasting{}`, `class_specific{}`) | Implemented | `dnd_get_class_levels` |
| `GET /api/2014/classes/{index}/levels/{level}` | One class level | path: class `index`, `level` 1-20 | single `ClassLevel` object | Implemented | `dnd_get_class_levels` |
| `GET /api/2014/rules` | Top-level SRD rule chapters | none | `{ count, results: [{ index, name, url }] }` (6 chapters) | Implemented | `dnd_list_rules` |
| `GET /api/2014/rules/{index}` | Rule chapter + subsections | path: `index` | `{ index, name, desc, subsections: [{ index, name, url }] }` | Implemented | `dnd_get_rule` |
| `GET /api/2014/rule-sections/{index}` | Full markdown rules text | path: `index` | `{ index, name, desc (markdown), url }` | Implemented | `dnd_get_rule_section` |
| `GET /api/2014/classes/{index}/features` | All features a class grants | path: class `index` | `{ count, results: [{ index, name, url }] }` | Planned | future `dnd_get_class_features` |
| `GET /api/2014/classes/{index}/proficiencies` | Starting proficiencies of a class | path: class `index` | `{ count, results: [{ index, name, url }] }` | Planned | future `dnd_get_class_proficiencies` |
| `GET /api/2014/subclasses/{index}/levels` | Subclass level progression | path: subclass `index` | `[{ level, features[], class, subclass, … }]` | Planned | extend `dnd_get_class_levels` with a subclass mode |
| `GET /api/2014/subclasses/{index}/features` | Features a subclass grants | path: subclass `index` | `{ count, results: [{ index, name, url }] }` | Planned | future `dnd_get_subclass_features` |
| `GET /api/2014/races/{index}/proficiencies` | Racial starting proficiencies | path: race `index` | `{ count, results: [{ index, name, url }] }` | Planned | future `dnd_get_race_proficiencies` |
| GraphQL `POST /graphql` | Alternative query API | GraphQL body | GraphQL envelope | Not applicable | Explore-mode tools are REST/GET based; out of scope |

Rate limits: none documented; the API is free and unauthenticated. Collections are
not paginated — list endpoints always return the full (filtered) collection, so the
plugin caps rendered rows at 50 and attaches the complete list to the citation payload.

## Future Endpoint Notes

The `Planned` rows above are thin list/detail variants that slot into the existing
patterns: add one `apiGet` helper in `client.ts`, one focused tool in `tools.ts`, and
mocked tests. A `dnd_get_class_features` / `dnd_get_subclass_features` pair plus a
subclass mode for `dnd_get_class_levels` would complete the character-progression
surface. A generic `dnd_get_subresource` (path-template tool) is intentionally avoided
in favour of these focused tools.

## Source Documentation

- https://5e-bits.github.io/docs/api/get-all-resource-ur-ls (root endpoint map)
- https://5e-bits.github.io/docs/api/ (full 2014 API reference; endpoint shapes verified against the live API)

## Build Contract

Build TypeScript API tooling for Raynard explore mode. Do not build React, routes, pages, CSS, or a standalone visual explorer. The chat UI already exists; this plugin exists so the agent can call API tools and talk to returned data.

## API Surface Contract

Treat the source API documentation as a whole API surface, not only the latest narrow user query. Build a practical suite of small, focused tools for important endpoints/resources such as list/search, detail-by-id, user/profile/account, metadata/status, and update/history endpoints when available. If only a subset is implemented, keep an `Endpoint Inventory` in this README that records each relevant endpoint path, purpose, required and optional parameters, response shape summary, pagination/rate-limit notes, status (`Implemented`, `Planned`, or `Not applicable`), and the future tool that should expose it.

## Tool Description Contract

Every exported tool must include a specific `description` and JSON `parameters` schema. Explore mode injects generated tool names, descriptions, and schemas into the prompt so the agent can choose the right tool across plugins. Avoid vague descriptions; state what user questions the tool answers, what API data it fetches, required arguments, useful optional arguments, and important limits or follow-up tools.

## Explore-Mode Contract

API tools should return concise text plus structured references with `referenceId`, `referenceLabel`, `referenceMeta`, and expanded raw payload content. Assistant answers should cite the returned references when discussing API data.
