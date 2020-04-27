/**
 * Import the UNII for drugs from the FDA
 *
 * @module importer/fda
 */

const {
    orderPreferredOntologyTerms, loadDelimToJson, rid, convertRowFields,
} = require('./../util');
const { SOURCE_DEFN: { name: ncitSourceName } } = require('./../ncit');
const { logger } = require('./../logging');

const { fdaSrs: SOURCE_DEFN } = require('./../sources');

const HEADER = {
    id: 'UNII',
    ncit: 'NCIT',
    pubchem: 'PUBCHEM',
    name: 'PT',
};

/**
 * Given the TAB delimited UNII records file. Load therapy records and NCIT links
 *
 * @param {object} opt options
 * @param {string} opt.filename the path to the input file
 * @param {ApiConnection} opt.conn the api connection object
 */
const uploadFile = async (opt) => {
    const { filename, conn: api } = opt;
    const jsonList = await loadDelimToJson(filename);
    const source = await api.addRecord({
        target: 'Source',
        content: SOURCE_DEFN,
        existsOk: true,
        fetchConditions: { name: SOURCE_DEFN.name },
    });

    // only load FDA records if we have already loaded NCIT
    try {
        await api.getUniqueRecordBy({
            target: 'Source',
            filters: { name: ncitSourceName },
        });
    } catch (err) {
        logger.error('Cannot link to NCIT, Unable to find source record');
        throw err;
    }
    const counts = { success: 0, error: 0, skip: 0 };

    logger.info(`loading ${jsonList.length} records`);

    for (let i = 0; i < jsonList.length; i++) {
        const {
            pubchem, id, ncit, name,
        } = convertRowFields(HEADER, jsonList[i]);

        if (!name || !id || (!ncit && !pubchem)) {
            // only load records with at min these 3 values filled out
            counts.skip++;
            continue;
        }
        let ncitRec;
        logger.info(`processing ${id} (${i} / ${jsonList.length})`);

        if (ncit) {
            try {
                ncitRec = await api.getUniqueRecordBy({
                    target: 'Therapy',
                    filters: {
                        AND: [
                            { source: { target: 'Source', filters: { name: ncitSourceName } } },
                            { sourceId: ncit },
                        ],
                    },
                    sort: orderPreferredOntologyTerms,
                });
            } catch (err) {
                counts.skip++;
                continue;
            }
        }

        let drug;

        try {
            drug = await api.addRecord({
                target: 'Therapy',
                content: { name, sourceId: id, source: rid(source) },
                existsOk: true,
            });

            if (ncitRec) {
                await api.addRecord({
                    target: 'crossreferenceof',
                    content: { source: rid(source), out: rid(drug), in: rid(ncitRec) },
                    existsOk: true,
                    fetchExisting: false,
                });
            }
            counts.success++;
        } catch (err) {
            counts.error++;
            logger.error(err);
            continue;
        }
    }
    logger.info(JSON.stringify(counts));
};

module.exports = { uploadFile, SOURCE_DEFN, dependencies: [ncitSourceName] };