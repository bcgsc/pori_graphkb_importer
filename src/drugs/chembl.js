/**
 * Load therapy recrods from CHEMBL
 */
const Ajv = require('ajv');

const {
    checkSpec, requestWithRetry,
} = require('./../util');
const {
    rid, generateCacheKey,
} = require('./../graphkb');
const { logger } = require('./../logging');
const { chembl: SOURCE_DEFN } = require('./../sources');

const ajv = new Ajv();

const recordSpec = ajv.compile({
    type: 'object',
    required: ['molecule_chembl_id'],
    properties: {
        molecule_chembl_id: { type: 'string', pattern: '^CHEMBL\\d+$' },
        pref_name: { type: ['string', 'null'] },
        usan_stem_definition: { type: ['string', 'null'] },
        molecule_properties: {
            oneOf: [{
                type: 'object',
                properties: {
                    full_molformula: { type: 'string' },
                },
            }, { type: 'null' }],
        },
    },
});


const API = 'https://www.ebi.ac.uk/chembl/api/data/molecule';

const CACHE = {};


/**
 * fetch drug by chemblId and load it into GraphKB
 * @param {ApiConnection} conn
 * @param {string} drugId
 */
const fetchAndLoadById = async (conn, drugId) => {
    const cacheKey = generateCacheKey({ sourceId: drugId });

    if (CACHE[cacheKey]) {
        return CACHE[cacheKey];
    }
    logger.info(`loading: ${API}/${drugId}`);
    const chemblRecord = await requestWithRetry({
        uri: `${API}/${drugId}`,
        json: true,
    });
    checkSpec(recordSpec, chemblRecord);

    if (!CACHE.SOURCE) {
        CACHE.SOURCE = await conn.addRecord({
            target: 'Source',
            content: SOURCE_DEFN,
            existsOk: true,
        });
    }
    const source = rid(CACHE.SOURCE);

    const content = {
        source,
        sourceId: chemblRecord.molecule_chembl_id,
        name: chemblRecord.pref_name,
    };

    if (content.name) {
        content.displayName = `${content.name} [${content.sourceId.toUpperCase()}]`;
    } else {
        content.displayName = content.sourceId.toUpperCase();
    }

    if (chemblRecord.molecule_properties && chemblRecord.molecule_properties.full_molformula) {
        content.molecularFormula = chemblRecord.molecule_properties.full_molformula;
    }

    const record = await conn.addRecord({
        target: 'Therapy',
        content,
        fetchConditions: { source, sourceId: content.sourceId, name: content.name },
        existsOk: true,
    });

    CACHE[cacheKey] = record;

    if (chemblRecord.usan_stem_definition) {
        try {
            const parent = await conn.addRecord({
                target: 'Therapy',
                content: {
                    source,
                    sourceId: chemblRecord.usan_stem_definition,
                    name: chemblRecord.usan_stem_definition,
                    comment: 'usan stem definition',
                },
                existsOk: true,
            });

            await conn.addRecord({
                target: 'SubclassOf',
                content: {
                    source,
                    out: rid(record),
                    in: rid(parent),
                },
                existsOk: true,
            });
        } catch (err) {}
    }
    return record;
};


const preLoadCache = async (api) => {
    const records = await api.getRecords({
        target: 'Therapy',
        filters: {
            AND: [
                { source: { target: 'Source', filters: { name: SOURCE_DEFN.name } } },
                { dependency: null },
                { deprecated: false },
            ],
        },
    });

    const dups = new Set();

    for (const record of records) {
        const cacheKey = generateCacheKey(record);

        if (CACHE[cacheKey]) {
            // duplicate
            dups.add(cacheKey);
        }
        CACHE[cacheKey] = record;
    }
    Array(dups).forEach((key) => {
        delete CACHE[key];
    });
    logger.info(`cache contains ${Object.keys(CACHE).length} keys`);
};


module.exports = {
    fetchAndLoadById,
    SOURCE_DEFN,
    preLoadCache,
};