/**
 * @module importer/hgnc
 */
const request = require('request-promise');
const Ajv = require('ajv');
const _ = require('lodash');

const { checkSpec } = require('./util');
const {
    rid, orderPreferredOntologyTerms, convertRecordToQueryFilters,
} = require('./graphkb');
const { logger } = require('./logging');
const _entrez = require('./entrez/gene');
const { hgnc: SOURCE_DEFN, ensembl: { name: ensemblSourceName } } = require('./sources');


const ajv = new Ajv();

const HGNC_API = 'http://rest.genenames.org/fetch';


const CACHE = {};
/**
 * This defines the expected format of a response from the HGNC API
 */
const validateHgncSpec = ajv.compile({
    type: 'object',
    properties: {
        date_modified: { type: 'string' },
        hgnc_id: { type: 'string', pattern: '^HGNC:[0-9]+$' },
        name: { type: 'string' },
        symbol: { type: 'string' },
        ensembl_gene_id: { type: 'string', pattern: '^ENSG[0-9]+$' },
        prev_symbol: { type: 'array', items: { type: 'string' } },
        alias_symbol: { type: 'array', items: { type: 'string' } },
        entrez_id: { type: 'string', pattern: '^\\d+$' },
    },
});

const createDisplayName = symbol => symbol.toUpperCase().replace('ORF', 'orf');


/**
 * Upload a gene record and relationships from the corresponding HGNC record
 * @param {object} opt
 * @param {ApiConnection} opt.conn the graphkb api connection
 * @param {object.<string,object>} opt.source the source records
 * @param {object} opt.gene the gene record from HGNC
 */
const uploadRecord = async ({
    conn, sources: { hgnc, ensembl }, gene, deprecated = false,
}) => {
    const body = {
        source: rid(hgnc),
        sourceIdVersion: gene.date_modified,
        sourceId: gene.hgnc_id,
        name: gene.symbol,
        longName: gene.name,
        biotype: 'gene',
        deprecated,
        displayName: createDisplayName(gene.symbol),
    };

    // don't update version if nothing else has changed
    const currentRecord = await conn.addRecord({
        target: 'Feature',
        content: body,
        existsOk: true,
        fetchConditions: convertRecordToQueryFilters(_.omit(body, ['sourceIdVersion', 'displayName', 'longName'])),
        fetchFirst: true,
    });

    if (gene.ensembl_gene_id && ensembl) {
        try {
            const ensg = await conn.getUniqueRecordBy({
                target: 'Feature',
                filters: {
                    AND: [
                        { source: rid(ensembl) },
                        { biotype: 'gene' },
                        { sourceId: gene.ensembl_gene_id },
                    ],
                },
            });
            // try adding the cross reference relationship
            await conn.addRecord({
                target: 'crossreferenceof',
                content: { out: rid(currentRecord), in: rid(ensg), source: rid(hgnc) },
                existsOk: true,
                fetchExisting: false,
            });
        } catch (err) { }
    }

    for (const symbol of gene.prev_symbol || []) {
        const { sourceId, biotype } = currentRecord;

        // link to the current record
        try {
            const deprecatedRecord = await conn.addRecord({
                target: 'Feature',
                content: {
                    source: rid(hgnc),
                    sourceId,
                    dependency: rid(currentRecord),
                    deprecated: true,
                    biotype,
                    name: symbol,
                    displayName: createDisplayName(symbol),
                },
                existsOk: true,
                fetchConditions: convertRecordToQueryFilters({
                    source: rid(hgnc), sourceId, name: symbol, deprecated: true,
                }),
                fetchExisting: true,
            });
            await conn.addRecord({
                target: 'deprecatedby',
                content: { out: rid(deprecatedRecord), in: rid(currentRecord), source: rid(hgnc) },
                existsOk: true,
                fetchExisting: false,
            });
        } catch (err) { }
    }

    for (const symbol of gene.alias_symbol || []) {
        const { sourceId, biotype } = currentRecord;

        try {
            const aliasRecord = await this.addRecord({
                target: 'Feature',
                content: {
                    source: rid(hgnc),
                    name: symbol,
                    sourceId,
                    biotype,
                    dependency: rid(currentRecord),
                    displayName: createDisplayName(symbol),
                },
                existsOk: true,
                fetchConditions: convertRecordToQueryFilters({
                    source: rid(hgnc), sourceId, name: symbol,
                }),
            });
            await conn.addRecord({
                target: 'aliasof',
                content: { out: rid(aliasRecord), in: rid(currentRecord), source: rid(hgnc) },
                existsOk: true,
                fetchExisting: false,
            });
        } catch (err) { }
    }

    // cross reference the entrez gene
    if (gene.entrez_id) {
        try {
            const [entrezGene] = await _entrez.fetchAndLoadByIds(conn, [gene.entrez_id]);
            await conn.addRecord({
                target: 'crossreferenceof',
                content: { out: rid(currentRecord), in: rid(entrezGene), source: rid(hgnc) },
                existsOk: true,
                fetchExisting: false,
            });
        } catch (err) {
            logger.warn(err);
        }
    }
    return currentRecord;
};


const fetchAndLoadBySymbol = async ({
    conn, symbol, paramType = 'symbol', ignoreCache = false,
}) => {
    symbol = symbol.toString().toLowerCase();

    if (!CACHE[paramType]) {
        CACHE[paramType] = {};
    }
    if (CACHE[paramType][symbol] && !ignoreCache) {
        return CACHE[paramType][symbol];
    }

    try {
        const filters = {
            AND: [
                { source: { target: 'Source', filters: { name: SOURCE_DEFN.name } } },
            ],
        };

        if (paramType === 'symbol') {
            filters.AND.push({ name: symbol });
        } else {
            filters.AND.push({ sourceId: symbol });
        }
        const record = await conn.getUniqueRecordBy({
            target: 'Feature',
            sort: orderPreferredOntologyTerms,
            filters,
        });

        if (!ignoreCache) {
            CACHE[paramType][symbol] = record;
        }
        return record;
    } catch (err) { }
    // fetch from the HGNC API and upload
    const uri = `${HGNC_API}/${paramType}/${
        paramType === 'hgnc_id'
            ? symbol.replace(/^HGNC:/i, '')
            : symbol
    }`;
    logger.info(`loading: ${uri}`);
    const { response: { docs } } = await request(`${uri}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        json: true,
    });

    for (const record of docs) {
        checkSpec(validateHgncSpec, record, rec => rec.hgnc_id);
    }
    const [gene] = docs;

    let hgnc;

    if (CACHE.SOURCE) {
        hgnc = CACHE.SOURCE;
    } else {
        hgnc = await conn.addRecord({
            target: 'Source',
            content: SOURCE_DEFN,
            fetchConditions: { name: SOURCE_DEFN.name },
            existsOk: true,
            fetchExisting: true,
        });
        CACHE.SOURCE = hgnc;
    }
    let ensembl;

    try {
        ensembl = await conn.getUniqueRecordBy({
            target: 'Source',
            filters: { name: ensemblSourceName },
        });
    } catch (err) { }
    const result = await uploadRecord({
        conn,
        gene,
        sources: { hgnc, ensembl },
        deprecated: (
            paramType === 'prev_symbol' || paramType === 'prev_name'
        ),
    });
    CACHE[paramType][symbol] = result;
    return result;
};

/**
 * Upload the HGNC genes and ensembl links
 * @param {object} opt options
 * @param {string} opt.filename the path to the input JSON file
 * @param {ApiConnection} opt.conn the API connection object
 */
const uploadFile = async (opt) => {
    logger.info('loading the external HGNC data');
    const { filename, conn } = opt;
    logger.info(`loading: ${filename}`);
    const hgncContent = require(filename); // eslint-disable-line import/no-dynamic-require,global-require
    const genes = hgncContent.response.docs;
    const hgnc = await conn.addRecord({
        target: 'Source',
        content: SOURCE_DEFN,
        existsOk: true,
        fetchConditions: { name: SOURCE_DEFN.name },
    });
    let ensembl;

    try {
        ensembl = await conn.getUniqueRecordBy({
            target: 'Source',
            filters: { name: ensemblSourceName },
        });
    } catch (err) {
        logger.info('Unable to fetch ensembl source for linking records');
    }

    logger.info(`adding ${genes.length} feature records`);

    for (const gene of genes) {
        try {
            checkSpec(validateHgncSpec, gene, rec => rec.hgnc_id);
        } catch (err) {
            logger.error(err);
            continue;
        }

        if (gene.longName && gene.longName.toLowerCase().trim() === 'entry withdrawn') {
            continue;
        }
        await uploadRecord({ conn, sources: { hgnc, ensembl }, gene });
    }
};

module.exports = {
    uploadFile, fetchAndLoadBySymbol, uploadRecord, SOURCE_DEFN, dependencies: [ensemblSourceName], ensemblSourceName,
};