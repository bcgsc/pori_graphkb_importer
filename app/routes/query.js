/**
 * Module for parsing query parameters into a the format expected for POST queries
 */

/**
 * Parse the operators prefixed on the query parameters
 *
 * @param {Object} inputQuery
 */

const {error: {AttributeError}} = require('@bcgsc/knowledgebase-schema');

const {
    constants: {
        MAX_LIMIT,
        MAX_NEIGHBORS,
        OPERATORS,
        TRAVERSAL_TYPE
    },
    util: {
        castBoolean,
        castRangeInt,
        parseCompoundAttr
    }
} = require('./../repo/query');

const MIN_WORD_SIZE = 4;


/**
 * Given objects representing collapsed traversals. Return individual lists representing the
 * flattened form
 *
 * @param {Object} params nested params object
 * @param {Array.<string>} prefixList array of attributes that are accessed to get to the current attr
 */
const flattenQueryParams = (params, prefixList = []) => {
    const flattened = [];
    for (const [key, value] of Object.entries(params)) {
        const newPrefix = prefixList.slice();
        newPrefix.push(key);

        if (value !== null && typeof value === 'object' && !(value instanceof Array)) {
            const children = flattenQueryParams(value, newPrefix);
            flattened.push(...children);
        } else {
            const flat = {attrList: newPrefix, value};
            flattened.push(flat);
        }
    }
    return flattened;
};


/**
 * Given some list of attributes to be successively accessed, format as a traversal
 *
 * @param {Array.<string>} attrList the list of attributes being chained
 *
 * @returns {Object} the list of attribute names represented as a traversal object
 *
 * @example
 * > formatTraversal(['a', 'b'])
 * {
 *      attr: 'a',
 *      type: 'LINK',
 *      child: {attr: 'b'}
 * }
 */
const formatTraversal = (attrList) => {
    let curr = {attr: attrList[0]};
    const top = curr;
    for (const key of attrList.slice(1)) {
        curr.child = {attr: key};
        curr.type = TRAVERSAL_TYPE.LINK;
        curr = curr.child;
    }
    return top;
};

/**
 * Parses the querystring representation of a value comparison
 *
 * @param {string|Object} attr the attribute (or attribute traversal) associated with comparison to this value
 * @param value the value string
 *
 * @returns {Object} the object representing the value as a query
 */
const parseValue = (attr, value) => {
    if (value instanceof Array) {
        throw new AttributeError(`Cannot specify a query parameter (${attr.attr || attr}) more than once (${value.length})`);
    }
    const clause = {operator: 'OR', comparisons: []};
    for (let subValue of value.split('|')) {
        subValue = decodeURIComponent(subValue); // fix for qs not properly decoding nested components
        let negate = false;
        if (subValue.startsWith('!')) {
            negate = true;
            subValue = subValue.slice(1);
        }
        let operator;

        if (subValue.startsWith('~')) {
            // CONTAINSTEXT must be split on index separators or the search will not behave as expected on a fulltext index
            operator = OPERATORS.CONTAINSTEXT;
            subValue = subValue.slice(1);

            const wordList = subValue.split(/\s+/);

            if (wordList.length > 1) { // contains a separator char, should split into AND clause
                const andClause = {
                    operator: OPERATORS.AND,
                    comparisons: Array.from(
                        wordList, word => ({
                            attr, value: word, operator, negate
                        })
                    )
                };
                if (andClause.comparisons.some(comp => comp.value.length < MIN_WORD_SIZE)) {
                    throw new AttributeError(
                        `Word "${subValue}" is too short to query with ~ operator. Must be at least ${
                            MIN_WORD_SIZE
                        } letters after splitting on whitespace characters`
                    );
                }
                clause.comparisons.push(andClause);
                continue; // added already
            } else if (subValue.length < MIN_WORD_SIZE) {
                throw new AttributeError(
                    `Word is too short to query with ~ operator. Must be at least ${
                        MIN_WORD_SIZE
                    } letters`
                );
            }
        }
        if (subValue === 'null') {
            subValue = null;
        }
        const comp = {
            value: subValue, attr, negate
        };
        if (operator !== undefined) {
            comp.operator = operator;
        }
        clause.comparisons.push(comp);
    }
    if (clause.comparisons.length < 1) {
        throw new AttributeError(`Cannot define a comparison with no values ${attr}:${value}`);
    } if (clause.comparisons.length < 2) {
        return clause.comparisons[0];
    }
    return clause;
};


/**
 * @param {Object} queryParams Object representing the input query parameters
 */
const parse = (queryParams) => {
    const flat = flattenQueryParams(queryParams);
    const specialArgs = {};
    const queryConditions = [];
    let compoundSyntax = false;

    // split into special args and regular query conditions
    for (const condition of flat) {
        const {attrList, value} = condition;
        let attr;
        if (attrList.length === 1) {
            attr = attrList[0];
        }
        if (attr === 'neighbors') {
            specialArgs[attr] = castRangeInt(value, 0, MAX_NEIGHBORS);
        } else if (attr === 'limit') {
            specialArgs[attr] = castRangeInt(value, 1, MAX_LIMIT);
        } else if (attr === 'skip') {
            specialArgs[attr] = castRangeInt(value, 0, null);
        } else if (attr === 'or' || attr === 'returnProperties') {
            specialArgs[attr] = value.split(',');
        } else if (attr === 'activeOnly') {
            specialArgs[attr] = castBoolean(value);
        } else if (attr === 'compoundSyntax') {
            compoundSyntax = value;
        } else {
            if (!attr) {
                attr = formatTraversal(attrList);
            }
            queryConditions.push({attr, value});
        }
    }
    const topLevelOr = specialArgs.or
        ? {operator: OPERATORS.OR, comparisons: []}
        : null;

    const query = [];
    // add conditions to regular level or to the top level or and parse values
    for (const condition of queryConditions) {
        let {attr} = condition;
        if (typeof attr === 'string' && (compoundSyntax || attr.includes('.'))) {
            attr = parseCompoundAttr(attr);
        }

        const value = parseValue(attr, condition.value);

        if (specialArgs.or && specialArgs.or.includes(attr)) {
            topLevelOr.comparisons.push(value);
        } else {
            query.push(value);
        }
    }
    if (specialArgs.or) {
        if (topLevelOr.comparisons.length > 1) {
            query.push(topLevelOr);
        } else {
            query.push(topLevelOr.comparisons[0]);
        }
        delete specialArgs.or;
    }

    return Object.assign({where: query}, specialArgs);
};

module.exports = {
    parse, flattenQueryParams, formatTraversal, parseValue, parseCompoundAttr
};