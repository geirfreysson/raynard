import { createApiReference, defineTools, requireNonEmpty } from '@raynard/plugin-sdk';
import {
  BASE_URL,
  LATEST_VERSION,
  buildDataUrl,
  fetchAvailability,
  fetchCodelist,
  fetchData,
  fetchDataStructureConcepts,
  fetchDataflowWithStructure,
  fetchDataflows,
  parseDataMessage,
  parseUrn,
  type SdmxCodelist,
  type SdmxDataflow
} from './client.ts';

const MAX_TABLE_ROWS = 60;
const MAX_TEXT_LINES = 40;

/** A structure request that matches nothing answers 204, so the body is empty. */
function isEmptyResponse(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Unexpected end of JSON input|JSON input|Unexpected token/i.test(message);
}

function localized(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function truncateLines(lines: string[], limit = MAX_TEXT_LINES): string {
  if (lines.length <= limit) return lines.join('\n');
  return [...lines.slice(0, limit), `… and ${lines.length - limit} more`].join('\n');
}

function matchesQuery(dataflow: SdmxDataflow, query: string): boolean {
  if (!query) return true;
  const haystack = `${dataflow.id} ${localized(dataflow.name)} ${localized(dataflow.description)}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

/**
 * IMF publishes under department agencies (IMF.STA, IMF.RES, IMF.FAD, …), never
 * under a bare `IMF` agency for dataflows, so a dataflow ID alone is resolved
 * against the registry listing.
 */
async function resolveDataflow(
  dataflowId: string,
  agencyId?: string
): Promise<{ dataflow: SdmxDataflow | null; agencyID: string }> {
  if (agencyId) return { dataflow: null, agencyID: agencyId };
  const dataflows = await fetchDataflows();
  const wanted = dataflowId.toLowerCase();
  const match =
    dataflows.find((flow) => flow.id.toLowerCase() === wanted) ??
    dataflows.find((flow) => localized(flow.name).toLowerCase() === wanted);
  if (!match) {
    throw new Error(
      `No IMF dataflow with ID "${dataflowId}". Call imf_list_dataflows to find the exact ID and agency.`
    );
  }
  return { dataflow: match, agencyID: match.agencyID };
}

export const tools = defineTools({
  imf_list_dataflows: {
    description:
      'Search the IMF SDMX registry for dataflows (datasets) such as Balance of Payments (BOP), International Financial Statistics (IFS), or Government Finance Statistics. Returns each dataflow ID, its owning agency (IMF.STA, IMF.RES, IMF.FAD, ISORA, …), and version. Always start here: the agency and exact ID are required by every other IMF tool.',
    parameters: {
      type: 'object',
      required: [],
      properties: {
        query: {
          type: 'string',
          description:
            'Optional case-insensitive text filter matched against dataflow ID, name, and description (e.g. "balance of payments", "government finance").'
        },
        agency_id: {
          type: 'string',
          description: 'Optional agency filter, e.g. IMF.STA, IMF.RES, IMF.FAD, IMF.MCM, ISORA.'
        },
        limit: {
          type: 'integer',
          description: 'Maximum dataflows to return. Defaults to 25, capped at 60.'
        }
      }
    },
    card: {
      name: { singular: 'dataflow', plural: 'dataflows' },
      title: 'IMF dataflows',
      layout: [
        {
          component: 'KeyValue',
          pairs: [
            { label: 'Query', field: 'query' },
            { label: 'Matching', field: 'matched' },
            { label: 'Shown', field: 'shown' }
          ]
        },
        {
          component: 'Table',
          columns: [
            { header: 'ID', field: 'id' },
            { header: 'Name', field: 'name' },
            { header: 'Agency', field: 'agencyID' },
            { header: 'Version', field: 'version' }
          ],
          rows: 'dataflows'
        }
      ]
    },
    async execute(args) {
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      const agencyId = typeof args?.agency_id === 'string' ? args.agency_id.trim() : '';
      const requested = Number(args?.limit);
      const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 25, MAX_TABLE_ROWS);

      const all = await fetchDataflows();
      const matched = all
        .filter((flow) => (agencyId ? flow.agencyID.toLowerCase() === agencyId.toLowerCase() : true))
        .filter((flow) => matchesQuery(flow, query))
        .sort((a, b) => a.id.localeCompare(b.id));
      const shown = matched.slice(0, limit).map((flow) => ({
        id: flow.id,
        name: localized(flow.name),
        agencyID: flow.agencyID,
        version: flow.version,
        description: localized(flow.description).slice(0, 300)
      }));

      const text = shown.length
        ? `${matched.length} IMF dataflow(s) match${query ? ` "${query}"` : ''}${agencyId ? ` in ${agencyId}` : ''}; showing ${shown.length}:\n\n${truncateLines(
            shown.map((flow) => `${flow.agencyID}:${flow.id} (v${flow.version}) — ${flow.name}`)
          )}`
        : `No IMF dataflow matches${query ? ` "${query}"` : ''}${agencyId ? ` in agency ${agencyId}` : ''}. ${all.length} dataflows are published in total.`;

      return {
        text,
        data: {
          query: query || 'all dataflows',
          matched: matched.length,
          shown: shown.length,
          dataflows: shown
        },
        references: [
          createApiReference({
            id: 'imf-dataflow-registry',
            label: 'IMF SDMX dataflow registry',
            sourceUrl: `${BASE_URL}/structure/dataflow/*/*/${LATEST_VERSION}`,
            quote: `${matched.length} of ${all.length} published dataflows match`,
            payload: shown
          })
        ]
      };
    }
  },

  imf_get_dataflow: {
    description:
      'Describe one IMF dataflow: its data structure definition, the ordered dimensions that identify a series (for example COUNTRY, INDICATOR, UNIT, FREQUENCY), and the codelist that supplies valid values for each dimension. Call this before imf_get_data so the dimension names used as filters are correct, then call imf_get_codelist for the codes.',
    parameters: {
      type: 'object',
      required: ['dataflow_id'],
      properties: {
        dataflow_id: {
          type: 'string',
          description: 'Exact dataflow ID from imf_list_dataflows, e.g. BOP, IFS, GFSMAB.'
        },
        agency_id: {
          type: 'string',
          description:
            'Owning agency from imf_list_dataflows, e.g. IMF.STA. Omit to resolve it from the registry.'
        }
      }
    },
    card: {
      name: { singular: 'dataflow', plural: 'dataflows' },
      title: '{{name}} ({{agencyID}}:{{id}})',
      layout: [
        {
          component: 'KeyValue',
          pairs: [
            { label: 'Dataflow', field: 'id' },
            { label: 'Agency', field: 'agencyID' },
            { label: 'Version', field: 'version' },
            { label: 'Data structure', field: 'dataStructureId' }
          ]
        },
        {
          component: 'Section',
          title: 'Dimensions',
          layout: [
            {
              component: 'Table',
              columns: [
                { header: '#', field: 'position' },
                { header: 'Dimension', field: 'id' },
                { header: 'Codelist', field: 'codelistId' },
                { header: 'Codelist agency', field: 'codelistAgency' }
              ],
              rows: 'dimensions'
            }
          ]
        }
      ]
    },
    async execute(args) {
      const dataflowId = requireNonEmpty(args?.dataflow_id, 'dataflow_id');
      const agencyArg = typeof args?.agency_id === 'string' ? args.agency_id.trim() : '';
      const resolved = await resolveDataflow(dataflowId, agencyArg || undefined);

      let detail;
      try {
        detail = await fetchDataflowWithStructure(resolved.agencyID, dataflowId);
      } catch (error) {
        if (isEmptyResponse(error)) {
          throw new Error(
            `IMF returned no dataflow ${resolved.agencyID}:${dataflowId}. Check the ID and agency with imf_list_dataflows.`
          );
        }
        throw error;
      }

      const dataflow = detail.dataflow ?? resolved.dataflow;
      const dataStructure = detail.dataStructure;
      if (!dataflow || !dataStructure) {
        throw new Error(
          `IMF returned no data structure for ${resolved.agencyID}:${dataflowId}. Check the ID and agency with imf_list_dataflows.`
        );
      }

      // IMF dimensions carry no local representation, so each dimension's
      // codelist is only reachable through its concept's core representation.
      const conceptSchemes = await fetchDataStructureConcepts(
        dataStructure.agencyID,
        dataStructure.id,
        dataStructure.version
      );
      const conceptEnumerations = new Map<string, string>();
      for (const scheme of conceptSchemes) {
        for (const concept of scheme.concepts ?? []) {
          const urn = `urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=${scheme.agencyID}:${scheme.id}(${scheme.version}).${concept.id}`;
          if (concept.coreRepresentation?.enumeration) {
            conceptEnumerations.set(urn, concept.coreRepresentation.enumeration);
            conceptEnumerations.set(`${scheme.id}.${concept.id}`, concept.coreRepresentation.enumeration);
          }
        }
      }

      const dimensions = (dataStructure.dataStructureComponents?.dimensionList?.dimensions ?? [])
        .slice()
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((dimension) => {
          const conceptUrn = dimension.conceptIdentity ?? '';
          const shortKey = conceptUrn.split('=').pop() ?? '';
          const schemeAndConcept = shortKey.includes(':')
            ? `${shortKey.split(':')[1].replace(/\([^)]*\)/, '')}`
            : '';
          const enumeration =
            dimension.localRepresentation?.enumeration ??
            conceptEnumerations.get(conceptUrn) ??
            conceptEnumerations.get(schemeAndConcept) ??
            '';
          const codelist = parseUrn(enumeration);
          return {
            position: (dimension.position ?? 0) + 1,
            id: dimension.id,
            codelistId: codelist?.id ?? '(not enumerated)',
            codelistAgency: codelist?.agencyID ?? ''
          };
        });

      const text = truncateLines([
        `${localized(dataflow.name)} (${dataflow.agencyID}:${dataflow.id}, v${dataflow.version})`,
        `Data structure: ${dataStructure.agencyID}:${dataStructure.id} (v${dataStructure.version})`,
        '',
        `Series key dimensions, in order — pass these as imf_get_data filters:`,
        ...dimensions.map(
          (dimension) =>
            `  ${dimension.position}. ${dimension.id}${
              dimension.codelistId === '(not enumerated)'
                ? ' (free text)'
                : ` → codelist ${dimension.codelistAgency}:${dimension.codelistId}`
            }`
        ),
        '',
        'TIME_PERIOD is filtered separately through start_period / end_period.'
      ]);

      return {
        text,
        data: {
          id: dataflow.id,
          name: localized(dataflow.name),
          agencyID: dataflow.agencyID,
          version: dataflow.version,
          dataStructureId: `${dataStructure.agencyID}:${dataStructure.id}`,
          dimensions
        },
        references: [
          createApiReference({
            id: `${dataflow.agencyID}-${dataflow.id}`,
            label: `${localized(dataflow.name)} structure`,
            sourceUrl: `${BASE_URL}/structure/dataflow/${dataflow.agencyID}/${dataflow.id}/${LATEST_VERSION}?references=children`,
            quote: `${dimensions.length} dimensions: ${dimensions.map((d) => d.id).join(', ')}`,
            payload: { dataflow, dataStructure: { id: dataStructure.id, version: dataStructure.version }, dimensions }
          })
        ]
      };
    }
  },

  imf_get_codelist: {
    description:
      'List the valid codes for one IMF codelist, such as CL_BOP_COUNTRY (ISO-3 country codes like USA, DEU), CL_BOP_INDICATOR, or CL_FREQ (A, Q, M). Take the codelist ID and its agency from imf_get_dataflow. Use the query argument to search a large codelist instead of listing all of it.',
    parameters: {
      type: 'object',
      required: ['codelist_id'],
      properties: {
        codelist_id: {
          type: 'string',
          description: 'Codelist ID from imf_get_dataflow, e.g. CL_BOP_COUNTRY, CL_BOP_INDICATOR, CL_FREQ.'
        },
        agency_id: {
          type: 'string',
          description:
            'Codelist agency from imf_get_dataflow, e.g. IMF.STA or IMF. Omit to try IMF.STA then IMF.'
        },
        query: {
          type: 'string',
          description: 'Optional case-insensitive filter matched against code ID and name, e.g. "current account".'
        },
        limit: {
          type: 'integer',
          description: 'Maximum codes to return. Defaults to 40, capped at 60.'
        }
      }
    },
    card: {
      name: { singular: 'code', plural: 'codes' },
      title: '{{name}} ({{agencyID}}:{{id}})',
      layout: [
        {
          component: 'KeyValue',
          pairs: [
            { label: 'Codelist', field: 'id' },
            { label: 'Agency', field: 'agencyID' },
            { label: 'Codes in list', field: 'totalCodes' },
            { label: 'Shown', field: 'shown' }
          ]
        },
        {
          component: 'Table',
          columns: [
            { header: 'Code', field: 'id' },
            { header: 'Name', field: 'name' }
          ],
          rows: 'codes'
        }
      ]
    },
    async execute(args) {
      const codelistId = requireNonEmpty(args?.codelist_id, 'codelist_id');
      const agencyArg = typeof args?.agency_id === 'string' ? args.agency_id.trim() : '';
      const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : '';
      const requested = Number(args?.limit);
      const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 40, MAX_TABLE_ROWS);

      const candidates = agencyArg ? [agencyArg] : ['IMF.STA', 'IMF'];
      let codelist: SdmxCodelist | null = null;
      let usedAgency = candidates[0];
      for (const candidate of candidates) {
        try {
          const found = await fetchCodelist(candidate, codelistId);
          if (found) {
            codelist = found;
            usedAgency = candidate;
            break;
          }
        } catch (error) {
          if (!isEmptyResponse(error)) throw error;
        }
      }
      if (!codelist) {
        throw new Error(
          `No IMF codelist ${candidates.join(' or ')}:${codelistId}. Take the codelist ID and agency from imf_get_dataflow.`
        );
      }

      const allCodes = codelist.codes ?? [];
      const matched = allCodes.filter((code) =>
        query ? `${code.id} ${localized(code.name)}`.toLowerCase().includes(query) : true
      );
      const codes = matched.slice(0, limit).map((code) => ({
        id: code.id,
        name: localized(code.name)
      }));

      const text = codes.length
        ? `${localized(codelist.name) || codelist.id} (${usedAgency}:${codelist.id}) — ${allCodes.length} codes, ${matched.length} matching${
            query ? ` "${query}"` : ''
          }, showing ${codes.length}:\n\n${truncateLines(codes.map((code) => `${code.id} — ${code.name}`))}`
        : `${usedAgency}:${codelist.id} has ${allCodes.length} codes but none match "${query}".`;

      return {
        text,
        data: {
          id: codelist.id,
          name: localized(codelist.name) || codelist.id,
          agencyID: usedAgency,
          totalCodes: allCodes.length,
          shown: codes.length,
          codes
        },
        references: [
          createApiReference({
            id: `${usedAgency}-${codelist.id}`,
            label: `${localized(codelist.name) || codelist.id} codelist`,
            sourceUrl: `${BASE_URL}/structure/codelist/${usedAgency}/${codelist.id}/${LATEST_VERSION}`,
            quote: `${allCodes.length} codes; ${matched.length} match${query ? ` "${query}"` : ''}`,
            payload: codes
          })
        ]
      };
    }
  },

  imf_get_data: {
    description:
      'Fetch IMF observation values (time series) for a dataflow. Filters are given as dimension/value pairs taken from imf_get_dataflow and imf_get_codelist, for example dimension COUNTRY with values "USA,DEU" and dimension FREQUENCY with value "A". Always supply enough filters to select a specific indicator: an unfiltered request covers hundreds of thousands of series. start_period and end_period accept a year, YYYY-MM, or YYYY-Qn.',
    parameters: {
      type: 'object',
      required: ['dataflow_id'],
      properties: {
        dataflow_id: {
          type: 'string',
          description: 'Exact dataflow ID from imf_list_dataflows, e.g. BOP.'
        },
        agency_id: {
          type: 'string',
          description: 'Owning agency, e.g. IMF.STA. Omit to resolve it from the registry.'
        },
        filters: {
          type: 'array',
          description:
            'Dimension filters. Each entry names a dimension from imf_get_dataflow and one or more comma-separated codes.',
          items: {
            type: 'object',
            required: ['dimension', 'values'],
            properties: {
              dimension: {
                type: 'string',
                description: 'Dimension ID, e.g. COUNTRY, INDICATOR, UNIT, FREQUENCY.'
              },
              values: {
                type: 'string',
                description: 'One code, or several separated by commas, e.g. "USA,DEU".'
              }
            }
          }
        },
        start_period: {
          type: 'string',
          description: 'Earliest period, e.g. 2015, 2015-01, or 2015-Q1.'
        },
        end_period: {
          type: 'string',
          description: 'Latest period, e.g. 2024, 2024-12, or 2024-Q4.'
        },
        max_series: {
          type: 'integer',
          description: 'Maximum series to describe. Defaults to 8.'
        }
      }
    },
    card: {
      name: { singular: 'observation', plural: 'observations' },
      title: '{{dataflowLabel}}',
      layout: [
        {
          component: 'KeyValue',
          pairs: [
            { label: 'Dataflow', field: 'dataflowLabel' },
            { label: 'Filters', field: 'filterSummary' },
            { label: 'Period', field: 'periodSummary' },
            { label: 'Series', field: 'seriesCount' },
            { label: 'Observations', field: 'observationCount' }
          ]
        },
        {
          component: 'Table',
          columns: [
            { header: 'Series', field: 'series' },
            { header: 'Period', field: 'period' },
            { header: 'Value', field: 'value' }
          ],
          rows: 'observations'
        }
      ]
    },
    async execute(args) {
      const dataflowId = requireNonEmpty(args?.dataflow_id, 'dataflow_id');
      const agencyArg = typeof args?.agency_id === 'string' ? args.agency_id.trim() : '';
      const startPeriod = typeof args?.start_period === 'string' ? args.start_period.trim() : '';
      const endPeriod = typeof args?.end_period === 'string' ? args.end_period.trim() : '';
      const requestedSeries = Number(args?.max_series);
      const maxSeries = Math.min(
        Number.isFinite(requestedSeries) && requestedSeries > 0 ? requestedSeries : 8,
        25
      );

      const filters: Record<string, string> = {};
      const rawFilters = Array.isArray(args?.filters) ? args.filters : [];
      for (const entry of rawFilters as Array<{ dimension?: unknown; values?: unknown }>) {
        const dimension = typeof entry?.dimension === 'string' ? entry.dimension.trim() : '';
        const values = typeof entry?.values === 'string' ? entry.values.trim() : '';
        if (dimension && values) filters[dimension] = values;
      }

      const resolved = await resolveDataflow(dataflowId, agencyArg || undefined);
      const query = {
        agencyID: resolved.agencyID,
        dataflowID: dataflowId,
        filters,
        startPeriod: startPeriod || undefined,
        endPeriod: endPeriod || undefined
      };
      const sourceUrl = buildDataUrl(query);
      const message = await fetchData(query);
      const series = parseDataMessage(message);

      const filterSummary = Object.entries(filters)
        .map(([dimension, value]) => `${dimension}=${value}`)
        .join(', ');
      const periodSummary = startPeriod || endPeriod ? `${startPeriod || '…'} to ${endPeriod || '…'}` : 'full history';
      const dataflowLabel = `${resolved.agencyID}:${dataflowId}`;

      const shownSeries = series.slice(0, maxSeries);
      const observations = shownSeries.flatMap((entry) =>
        entry.observations.map((observation) => ({
          series: entry.key,
          period: observation.period,
          value: observation.value
        }))
      );
      const observationCount = series.reduce((total, entry) => total + entry.observations.length, 0);

      const text = series.length
        ? truncateLines([
            `${dataflowLabel} — ${series.length} series, ${observationCount} observations (${periodSummary}).`,
            filterSummary ? `Filters: ${filterSummary}` : 'No dimension filters applied.',
            '',
            ...shownSeries.flatMap((entry) => [
              `${entry.key} [${Object.entries(entry.dimensions)
                .map(([dimension, value]) => `${dimension}=${value}`)
                .join(' ')}]`,
              ...entry.observations
                .slice(0, 24)
                .map((observation) => `  ${observation.period}: ${observation.value ?? 'n/a'}`)
            ]),
            series.length > shownSeries.length ? `… ${series.length - shownSeries.length} more series not shown` : ''
          ].filter(Boolean))
        : `${dataflowLabel} returned no observations for ${filterSummary || 'the request'} (${periodSummary}). Verify dimension IDs with imf_get_dataflow and codes with imf_get_codelist — an unknown code returns an empty dataset rather than an error.`;

      return {
        text,
        data: {
          dataflowLabel,
          filterSummary: filterSummary || 'none',
          periodSummary,
          seriesCount: series.length,
          observationCount,
          observations: observations.slice(0, MAX_TABLE_ROWS)
        },
        references: [
          createApiReference({
            id: `${dataflowLabel}-data`,
            label: `${dataflowLabel} observations`,
            sourceUrl,
            quote: `${series.length} series, ${observationCount} observations (${periodSummary})`,
            payload: shownSeries
          })
        ]
      };
    }
  },

  imf_get_availability: {
    description:
      'Report the data coverage of an IMF dataflow before querying it: how many series it holds, the earliest and latest period observed, and which dimensions constrain it. Use this to confirm a dataflow actually covers the years asked about. It reports coverage, not the list of valid codes — use imf_get_codelist for codes.',
    parameters: {
      type: 'object',
      required: ['dataflow_id'],
      properties: {
        dataflow_id: {
          type: 'string',
          description: 'Exact dataflow ID from imf_list_dataflows, e.g. BOP.'
        },
        agency_id: {
          type: 'string',
          description: 'Owning agency, e.g. IMF.STA. Omit to resolve it from the registry.'
        }
      }
    },
    card: {
      name: { singular: 'dataflow coverage', plural: 'dataflow coverage' },
      title: 'Coverage of {{dataflowLabel}}',
      layout: [
        {
          component: 'KeyValue',
          pairs: [
            { label: 'Dataflow', field: 'dataflowLabel' },
            { label: 'Series', field: 'seriesCount' },
            { label: 'Earliest period', field: 'timePeriodStart' },
            { label: 'Latest period', field: 'timePeriodEnd' }
          ]
        },
        {
          component: 'Section',
          title: 'Constrained dimensions',
          layout: [
            {
              component: 'Table',
              columns: [{ header: 'Dimension', field: 'id' }],
              rows: 'dimensions'
            }
          ]
        }
      ]
    },
    async execute(args) {
      const dataflowId = requireNonEmpty(args?.dataflow_id, 'dataflow_id');
      const agencyArg = typeof args?.agency_id === 'string' ? args.agency_id.trim() : '';
      const resolved = await resolveDataflow(dataflowId, agencyArg || undefined);
      const dataflowLabel = `${resolved.agencyID}:${dataflowId}`;

      let constraint;
      try {
        constraint = await fetchAvailability(resolved.agencyID, dataflowId);
      } catch (error) {
        if (isEmptyResponse(error)) {
          throw new Error(
            `IMF published no availability constraint for ${dataflowLabel}. Confirm the dataflow with imf_list_dataflows.`
          );
        }
        throw error;
      }
      if (!constraint) {
        throw new Error(
          `IMF published no availability constraint for ${dataflowLabel}. Confirm the dataflow with imf_list_dataflows.`
        );
      }

      const annotation = (id: string) =>
        constraint.annotations?.find((entry) => entry.id === id)?.title ?? '';
      const dimensions = (constraint.cubeRegions ?? []).flatMap((region) =>
        (region.components ?? []).map((component) => ({ id: component.id }))
      );

      const seriesCount = annotation('series_count') || 'unknown';
      const timePeriodStart = annotation('time_period_start') || 'unknown';
      const timePeriodEnd = annotation('time_period_end') || 'unknown';

      const text = truncateLines([
        `${dataflowLabel} coverage`,
        `Series: ${seriesCount}`,
        `Observed period: ${timePeriodStart} to ${timePeriodEnd}`,
        dimensions.length
          ? `Constrained dimensions: ${dimensions.map((dimension) => dimension.id).join(', ')}`
          : 'No dimension constraints published.',
        '',
        'Valid codes per dimension come from imf_get_codelist; this endpoint reports coverage only.'
      ]);

      return {
        text,
        data: {
          dataflowLabel,
          seriesCount,
          timePeriodStart,
          timePeriodEnd,
          dimensions
        },
        references: [
          createApiReference({
            id: `${dataflowLabel}-availability`,
            label: `${dataflowLabel} availability`,
            sourceUrl: `${BASE_URL}/availability/dataflow/${resolved.agencyID}/${dataflowId}/${LATEST_VERSION}/*/*`,
            quote: `${seriesCount} series covering ${timePeriodStart} to ${timePeriodEnd}`,
            payload: { annotations: constraint.annotations, dimensions }
          })
        ]
      };
    }
  }
});
