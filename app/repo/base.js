'use strict';
const {AttributeError, MultipleRecordsFoundError, NoRecordFoundError, RecordExistsError} = require('./error');
const cache = require('./cache');
const {timeStampNow, quoteWrap, looksLikeRID, getParameterPrefix, VERBOSE} = require('./util');
const RID = require('orientjs').RID;
const _ = require('lodash');


const RELATED_NODE_DEPTH = 3;
const QUERY_LIMIT = 1000;
const FUZZY_CLASSES = ['AliasOf', 'DeprecatedBy'];
const SPECIAL_QUERY_ARGS = new Set(['fuzzyMatch', 'ancestors', 'descendants', 'returnProperties', 'limit', 'skip', 'neighbors', 'includeHistory']);


/**
 * Check if the error is a particular type (expected from orientdb) and return an instance of the corresponding error class
 */
const wrapIfTypeError = (err) => {
    if (err && err.type) {
        if (err.type.toLowerCase().includes('orecordduplicatedexception')) {
            return new RecordExistsError(err);
        } else if (err.type.toLowerCase().includes('orecordnotfoundexception')) {
            return new NoRecordFoundError(err);
        }
    }
    return err;
};


class Follow {
    /**
     * Sets up the edge following clause portion for tha match query statement
     * @param {string[]} classnames the names of the edge classes to follow
     * @param {string} [type='both'] the type of edge to follow (in, out, both)
     * @param {?number} [depth=RELATED_NODE_DEPTH] depth of the edges to follow
     *
     * @example
     * > new Follow().toString();
     * '.both(){while: ($depth < 3)}'
     *
     * > new Follow(['blargh', 'monkeys'], 'out', null).toString();
     * '.out('blargh', 'monkeys'){while: ($matched.out('blargh', 'monkeys').size() > 0)}'
     *
     */
    constructor(classnames=[], type='both', depth=RELATED_NODE_DEPTH, activeOnly=true) {
        if (!['both', 'in', 'out'].includes(type)) {
            throw new AttributeError(`expected type to be: in, out, or both. But was given: ${type}`);
        }
        if (type === 'both' && depth === null) {
            throw new Error('following edges requires a stopping point. Cannot have null depth with type \'both\'');
        }
        this.classnames = classnames;
        this.type = type;
        this.depth = depth === null ? null : Number(depth);
        this.activeOnly = activeOnly;
    }
    toString() {
        const classesString = Array.from(this.classnames, quoteWrap).join(', ');
        if (this.depth === null) {
            // follow until out of edge types
            if (this.activeOnly) {
                return `.${this.type}(${classesString}){while: ($matched.${this.type}(${classesString}).size() > 0 AND $matched.deletedAt IS NULL)}`;
            } else {
                return `.${this.type}(${classesString}){while: ($matched.${this.type}(${classesString}).size() > 0)}`;
            }
        } else {
            if (this.activeOnly) {
                return `.${this.type}(${classesString}){while: ($depth < ${this.depth} AND $matched.deletedAt IS NULL)}`;
            } else {
                return `.${this.type}(${classesString}){while: ($depth < ${this.depth})}`;
            }
        }
    }
    /**
     * Based on the input query, create the follow statement (part of a match expresion)
     * @param {object} query
     * @param {Array} [query.ancestors] list of edge class names to follow for all ancestors
     * @param {Array} [query.descendants] list of edge class names to follow for all descendants
     * @param {int} [query.fuzzyMatch] sets how far to follow 'aliasof' and 'deprecatedby' edges
     * @param {bool} [query.activeOnly=true] only follow active nodes/edges
     *
     * @returns {Follow} the follow statement
     */
    static parse(query) {
        const activeOnly = query.activeOnly === undefined ? true: query.activeOnly;
        const follow = [];
        // translate the fuzzyMatch/ancestors/descendants into proper follow statements
        if (query.ancestors) {
            follow.push([new this(query.ancestors, 'in', null, activeOnly)]);
        }
        if (query.descendants) {
            follow.push([new this(query.descendants, 'out', null, activeOnly)]);
        }
        if (query.fuzzyMatch) {
            const fuzzy = new this(FUZZY_CLASSES, 'both', query.fuzzyMatch, activeOnly);
            if (follow.length === 0) {
                follow.push([fuzzy]);
            } else {
                for (let followArr of follow) {
                    followArr.unshift(fuzzy);
                    followArr.push(fuzzy);
                }
            }
        }
        return follow;
    }
}


class Clause {
    /**
     * @param {string} type can be OR or AND
     * @param {Array.<(Comparison|Clause)>} comparisons the array of comparisons (or clauses) which make up the clause
     */
    constructor(type='OR', comparisons=[]) {
        this.type = type;
        this.comparisons = Array.from(comparisons, (comp) => {
            if (comp instanceof Clause || comp instanceof Comparison) {
                return comp;
            } else {
                return new Comparison(comp);
            }
        });
    }
    push(item) {
        this.comparisons.push(item);
    }
    get length() {
        return this.comparisons.length;
    }
    applyCast(cast) {
        for (let item of this.comparisons) {
            item.applyCast(cast);
        }
    }
    /**
     * @param {string} name the name of the attribute we are comparing to
     * @param {int} [paramIndex=0] the number to append to parameter names
     * @param {bool} [listableType=false] indicates if the attribute being compared to is a set/list/bag/map etc.
     */
    toString(name, paramIndex=0, listableType=false) {
        const params = {};
        let components = [];
        for (let comp of this.comparisons) {
            const result = comp.toString(name, paramIndex + (Object.keys(params).length), listableType);
            if (comp instanceof Clause && comp.length > 1) {
                // wrap in brackets
                result.query = `(${result.query})`;
            }
            Object.assign(params, result.params);
            components.push(result.query);
        }
        let query = components.join(` ${this.type} `);
        return {query, params};
    }
}


class Comparison {
    /**
     * @param value the value to be compared to
     * @param {string} operator the operator to use for the comparison
     * @param {bool} negate if true then surround the comparison with a negation
     */
    constructor(value, operator='=', negate=false) {
        this.value = value;
        this.operator = operator;
        this.negate = negate;
        if (operator !== '=' && operator !== '~') {
            throw new AttributeError('Invalid operator. Only = and ~ are supported operators');
        }
    }
    applyCast(cast) {
        this.value = cast(this.value);
    }
    /**
     * @param {string} name the name of the attribute we are comparing to
     * @param {int} [paramIndex=0] the number to append to parameter names
     * @param {bool} [listableType=false] indicates if the attribute being compared to is a set/list/bag/map etc.
     */
    toString(name, paramIndex=0, listableType=false) {
        const params = {};
        let query;
        const pname = `param${paramIndex}`;
        if (listableType) {
            if (this.value === null) {
                query = `${name} CONTAINS NULL`;
            } else {
                params[pname] = this.value;
                query = `${name} CONTAINS :${pname}`;
            }
        } else if (this.value !== null) {
            params[pname] = this.value;
            query = `${name} ${this.operator === '~' ? 'CONTAINSTEXT' : '=' } :${pname}`;
        } else {
            query = `${name} IS NULL`;
        }
        if (this.negate) {
            query = `NOT (${query})`;
        }
        return {query, params};
    }
}


class SelectionQuery {
    /**
     * Builds the query statement for selecting or matching records from the database
     *
     * @param {Object} opt Selection options
     * @param {boolean} [opt.activeOnly=true] Return only non-deleted records
     * @param {ClassModel} model the model to be selected from
     * @param {Object} [inputQuery={}] object of property names linked to values, comparisons, or clauses
     *
     */
    constructor(model, inputQuery={}, opt={}) {
        this.model = model;
        console.log('model', model);
        this.conditions = {};
        this.follow = [];
        this.skip = opt.skip ? opt.skip : null;
        this.activeOnly = opt.activeOnly === undefined ? true : opt.activeOnly;
        this.properties = Object.assign({}, model.properties);
        this.returnProperties = inputQuery.returnProperties ? inputQuery.returnProperties : null;
        const propertyNames = this.model.propertyNames;
        console.log('propertyNames', propertyNames);
        // can only return properties which belong to this class
        for (let propName of this.returnProperties || []) {
            if (! propertyNames.includes(propName)) {
                throw new AttributeError(`invalid return property '${propName}' is not a valid member of class '${this.model.name}'`);
            }
        }

        if (this.activeOnly && propertyNames.includes('deletedAt')) {
            inputQuery.deletedAt = null;
        }
        this.cast = Object.assign({}, this.model.cast);
        const subqueries = {};
        const odbArgs = ['@rid', '@class'];
        // split the original query into subqueries where appropriate
        for (let [name, value] of Object.entries(inputQuery)) {
            if (SPECIAL_QUERY_ARGS.has(name)) {
                continue;
            }

            let {prefix, suffix} = getParameterPrefix(name);

            if (! (SPECIAL_QUERY_ARGS.has(suffix)) && ! (value instanceof Comparison || value instanceof Clause)) {
                value = new Comparison(value);  // default to basic equals
            }

            if (! propertyNames.includes(prefix) && ! odbArgs.includes(prefix)) {
                throw new AttributeError(`unexpected attribute ${prefix} for class ${this.model.name}`);
            }
            if (suffix && this.properties[prefix].linkedModel) {
                if (subqueries[prefix] === undefined) {
                    subqueries[prefix] = {where: {}, model: this.properties[prefix].linkedModel};
                }
                subqueries[prefix].where[suffix] = value;
                continue;
            }
            this.conditions[name] = value;
        }
        this.follow = Follow.parse(Object.assign({activeOnly: this.activeOnly}, inputQuery));

        for (let [name, value] of Object.entries(subqueries)) {
            const subquery = new SelectionQuery(value.model, value.where, {activeOnly: this.activeOnly});
            if (subquery.follow.length === 0) {  // don't need a subquery, can use direct links instead and add the property definition here
                for (let subPropName of Object.keys(subquery.conditions)) {
                    const combinedName = `${name}.${subPropName}`;
                    this.conditions[combinedName] = subquery.conditions[subPropName];
                    const propDefn = this.properties[name].linkedModel.properties[subPropName];
                    this.properties[combinedName] = propDefn;
                    if (subquery.model.cast[subPropName]) {
                        this.cast[combinedName] = subquery.model.cast[subPropName];
                    }
                }
            } else {
                this.conditions[name] = subquery;
            }
        }
        for (let [name, condition] of Object.entries(this.conditions)) {
            if (! (condition instanceof SelectionQuery) && this.cast[name]) {
                condition.applyCast(this.cast[name]);
            }
        }
    }

    /**
     * @param {string} name name of the parameter
     * @param {Clause|Comparison} value possible value(s)
     * @param {int} [paramIndex=0] the index to use for naming parameters
     *
     * @example
     *  >>> query.OrClause('thing', new Clause('OR', [new Comparison('blargh'), new Comparison(null)]))
     *  {query: '(thing = :param0 OR thing IS NULL)', params: {param0: 'blargh'}}
     *
     * @example
     *  >>> query.OrClause('thing', new Comparison(2))
     *  {query: 'thing = :param0', params: {param0: 2}}
     */
    conditionClause(name, value, paramIndex=0) {
        const property = this.properties[name];

        let isList = false;
        if (! property || ! property.type) {
            throw new AttributeError(`property '${name}' is not defined on this model '${this.model.name}'`);
        }
        if (/^(embedded|link)(list|set|map|bag)$/.exec(property.type)) {
            isList = true;
        }

        const {query, params} = value.toString(name, paramIndex, isList);
        if (property.type.includes('link')) {
            for (let pname of Object.keys(params)) {
                if (params[pname] !== null && ! looksLikeRID(params[pname])) {
                    throw new AttributeError(`'${name}' expects an RID or null but saw '${params[pname]}'`);
                } else if (params[pname] !== null) {
                    params[pname] = new RID(`#${params[pname].replace(/^#/, '')}`);
                }
            }
        }
        return {query, params};
    }
    /**
     * print the selection query as a string with SQL paramters.
     *
     * @param {int} paramStartIndex
     *
     * @returns {object} an object containing the SQL query statment (query) and the parameters (params)
     */
    toString(paramStartIndex=0) {
        let queryString;
        const selectionElements = this.returnProperties ? this.returnProperties.join(', ') : '*';
        const conditions = [];
        const params = {};
        const conditionNames = Object.keys(this.conditions);
        conditionNames.sort();  // parameters will have the same aliases
        for (let attr of conditionNames) {
            let clause;
            if (this.conditions[attr] instanceof SelectionQuery) {
                clause = this.conditions[attr].toString(paramStartIndex);
                clause.query = `${attr} IN (SELECT @rid FROM (${clause.query}))`;
            } else {
                clause = this.conditionClause(attr, this.conditions[attr], paramStartIndex);
            }
            paramStartIndex += Object.keys(clause.params).length;
            Object.assign(params, clause.params);
            if (this.conditions[attr] instanceof Clause && this.conditions[attr].length > 1) {
                clause.query = `(${clause.query})`;
            }
            conditions.push(clause.query);
        }
        if (this.follow.length > 0) {
            // must be a match query to follow edges
            let prefix;
            if (conditions.length > 0) {
                prefix = `{class: ${this.model.name}, where: (${conditions.join(' AND ')})}`;
            } else {
                prefix = `{class: ${this.model.name}}`;
            }
            const expressions = [];
            for (let arr of this.follow) {
                expressions.push(`${prefix}${Array.from(arr, x => x.toString()).join('')}`);
            }
            queryString = `MATCH ${expressions.join(', ')} RETURN \$pathElements`;
            if (selectionElements !== '*') {
                queryString = `SELECT ${selectionElements} FROM (${queryString})`;
            }
        } else {
            queryString = `SELECT ${selectionElements} FROM ${this.model.name}`;
            if (conditions.length > 0) {
                queryString = `${queryString} WHERE ${conditions.join(' AND ')}`;
            }
        }
        if (this.skip != null) {
            queryString = `${queryString} skip ${this.skip}`;
        }
        return {query: queryString, params: params};
    }
    /**
     * Returns the query as a string but substitutes all parameters to make the results more readable.
     *
     * @warning
     *      use the toString and params to query the db. This method is for VERBOSEging/logging only
     */
    displayString() {
        let {query: statement, params} = this.toString();
        for (let key of Object.keys(params)) {
            let value = params[key];
            if (typeof value === 'string') {
                value = `'${value}'`;
            }
            statement = statement.replace(new RegExp(':' + key, 'g'), `${value}`);
        }
        return statement;
    }
}


const checkAccess = (user, model, permissionsRequired) => {
    if (! user.permissions) {
        return false;
    }
    if (user.permissions[model.name] !== undefined && (permissionsRequired & user.permissions[model.name])) {
        return true;
    }
    for (let name of model.inherits) {
        if (user.permissions[name] !== undefined) {
            if (permissionsRequired & user.permissions[name]) {
                return true;
            }
        }
    }
    return false;
};

/**
 * Create new User record
 *
 * @param {object} db the orientjs database connection
 * @param {object} opt options
 * @param {ClassModel} opt.model the class model for User
 * @param {string} opt.userName the name of the new user
 * @param {string[]} opt.groupNames the list of group names for which to add the new user to
 */
const createUser = async (db, opt) => {
    const {model, userName, groupNames} = opt;
    const record = model.formatRecord({
        name: userName,
        groups: Array.from(groupNames, x => cache.userGroups[x]['@rid']),
        deletedAt: null
    }, {dropExtra: false, addDefaults: true});
    await db.insert().into(model.name)
        .set(record)
        .one();
    try {
        return await select(db, {where: {name: userName}, model: model, exactlyN: 1});
    } catch (err) {
        throw wrapIfTypeError(err);
    }
};


const populateCache = async (db, schema) => {
    // load the user groups
    const groups = await select(db, {model: schema.UserGroup});
    for (let group of groups) {
        cache.userGroups[group.name] = group;
    }
    // load the individual users
    const users = await select(db, {model: schema.User});
    for (let user of users) {
        cache.users[user.name] = user;
    }
    // load the vocabulary
    await cacheVocabulary(db, schema.Vocabulary);
};

const cacheVocabulary = async (db, model) => {
    // load the vocabulary
    if (VERBOSE) {
        console.log('updating the vocabulary cache');
    }
    const rows = await select(db, {model: model});
    // reformats the rows to fit with the cache expected structure
    cache.vocabulary = {};  // remove old vocabulary
    for (let row of rows) {
        if (cache.vocabulary[row.class] === undefined) {
            cache.vocabulary[row.class] = {};
        }
        if (cache.vocabulary[row.class][row.property] === undefined) {
            cache.vocabulary[row.class][row.property] = [];
        }
        cache.vocabulary[row.class][row.property].push(row);
    }
    if (VERBOSE) {
        console.log(cache.vocabulary);
    }
};

/**
 * create new record in the database
 *
 * @param {object} db the orientjs database connection
 * @param {object} opt options
 * @param {object} opt.content the contents of the new record
 * @param {ClassModel} opt.model the model for the table/class to insert the new record into
 * @param {object} opt.user the user creating the new record
 */
const create = async (db, opt) => {
    const {content, model, user} = opt;
    if (model.isEdge) {
        return await createEdge(db, opt);
    }
    const record = model.formatRecord(
        Object.assign({}, content, {createdBy: user['@rid']}),
        {dropExtra: false, addDefaults: true});
    if (VERBOSE) {
        console.log('create:', record);
    }
    try {
        return await db.insert().into(model.name).set(record).one();
    } catch (err) {
        throw wrapIfTypeError(err);
    }
};

/**
 * create new edge record in the database
 *
 * @param {object} db the orientjs database connection
 * @param {object} opt options
 * @param {object} opt.content the contents of the new record
 * @param {string} opt.content.out the @rid of the source node
 * @param {string} opt.content.in the @rid of the target node
 * @param {ClassModel} opt.model the model for the table/class to insert the new record into
 * @param {object} opt.user the user creating the new record
 */
const createEdge = async (db, opt) => {
    const {content, model, user} = opt;
    content.createdBy = user['@rid'];
    const record = model.formatRecord(content, {dropExtra: false, addDefaults: true});
    const from = record.out;
    const to = record.in;
    delete record.out;
    delete record.in;
    try {
        return await db.create('EDGE', model.name).from(from).to(to).set(record).one();
    } catch (err) {
        throw wrapIfTypeError(err);
    }
};


/**
 * Builds the query statement for selecting or matching records from the database
 *
 * @param {Object} db Database connection from orientjs
 *
 * @param {Object} opt Selection options
 * @param {boolean} [opt.activeOnly=true] Return only non-deleted records
 * @param {ClassModel} opt.model the model to be selected from
 * @param {string} [opt.fetchPlan='*: 1'] key value mapping of class names to depths of edges to follow or '*' for any class
 * @param {Array} [opt.where=[]] the query requirements
 * @param {?number} [opt.exactlyN=null] if not null, check that the returned record list is the same length as this value
 * @param {?number} [opt.limit=QUERY_LIMIT] the maximum number of records to return
 * @param {number} [opt.skip=0] the number of records to skip (for pagination)
 *
 */
const select = async (db, opt) => {
    // set the default options
    opt = Object.assign({
        activeOnly: true,
        exactlyN: null,
        fetchPlan: '*:1',
        limit: QUERY_LIMIT,
        skip: 0
    }, opt);

    const query = new SelectionQuery(opt.model, opt.where || {}, opt);
    if (VERBOSE) {
        console.log('select query statement:', query.displayString(), {limit: opt.limit, fetchPlan: opt.fetchPlan, skip: opt.skip});
    }

    // send the query statement to the database
    const {params, query: statement} = query.toString();
    const recordList = await db.query(`${statement}`, {
        params: params,
        limit: opt.limit,
        fetchPlan: opt.fetchPlan
    }).all();

    if (process.env.DEBUG == '1') {
        console.log(`selected ${recordList.length} records`);
    }

    if (opt.exactlyN !== null) {
        if (recordList.length === 0) {
            if (opt.exactlyN === 0) {
                return [];
            } else {
                throw new NoRecordFoundError({
                    message: 'query expected results but returned an empty list',
                    sql: query.displayString()
                });
            }
        } else if (opt.exactlyN !== recordList.length) {
            throw new MultipleRecordsFoundError({
                message: `query returned unexpected number of results. Found ${recordList.length} results but expected ${opt.exactlyN} results`,
                sql: query.displayString()
            });
        } else {
            return recordList;
        }
    } else {
        return recordList;
    }
};


/**
 * Mark a particular record as deleted
 *
 *
 */
const remove = async (db, opt) => {
    const {model, user, where} = opt;
    let rid = where['@rid'];
    if (rid === undefined) {
        const rec = (await select(db, {model: model, where: where, exactlyN: 1}))[0];
        rid = rec['@rid'];
        where['createdAt'] = rec['createdAt'];
    }
    delete where['@rid'];
    const commit = db.let(
        'updatedRID', (tx) => {
            // update the original record and set the history link to link to the copy
            return tx.update(`${rid}`)
                .set({deletedAt: timeStampNow()})
                .set(`deletedBy = ${user['@rid']}`)
                .return('AFTER @rid')
                .where(where);
        }).let('updated', (tx) => {
            return tx.select().from('$updatedRID').fetch({'*': 1});
        }).commit();
    if (VERBOSE) {
        console.log('remove:', commit.buildStatement());
    }
    try {
        return await commit.return('$updated').one();
    } catch (err) {
        err.sql = commit.buildStatement();
        throw wrapIfTypeError(err);
    }
};


/**
 * uses a transaction to copy the current record into a new record
 * then update the actual current record (to preserve links)
 * the link the copy to the current record with the history link
 *
 * @param {Object} db orientjs database connection
 * @param {Object} opt options
 * @param {Object} opt.content the content for the new node (any unspecified attributes are assumed to be unchanged)
 * @param {Array} opt.where the selection criteria for the original node
 * @param {Object} opt.user the user updating the record
 */
const update = async (db, opt) => {
    const {content, model, user, where} = opt;
    const original = (await select(db, {model: model, where: where, exactlyN: 1}))[0];
    const originalWhere = Object.assign(model.formatRecord(original, {dropExtra: true, addDefaults: false}));
    delete originalWhere.createdBy;
    delete originalWhere.history;
    const copy = Object.assign({}, _.omit(originalWhere, ['@rid', '@version']), {deletedAt: timeStampNow()});

    const commit = db.let(
        'copy', (tx) => {
            // create the copy of the original record with a deletion time
            if (original.history !== undefined) {
                return tx.create(model.isEdge ? 'EDGE' : 'VERTEX', model.name)
                    .set(copy)
                    .set(`createdBy = ${original.createdBy['@rid']}`)
                    .set(`deletedBy = ${user['@rid']}`)
                    .set(`history = ${original.history['@rid']}`);
            } else {
                return tx.create(model.isEdge ? 'EDGE' : 'VERTEX', model.name)
                    .set(copy)
                    .set(`createdBy = ${original.createdBy['@rid']}`)
                    .set(`deletedBy = ${user['@rid']}`);
            }
        }).let('updatedRID', (tx) => {
            // update the original record and set the history link to link to the copy
            return tx.update(`${original['@rid']}`)
                .set(content)
                .set('history = $copy')
                .return('AFTER @rid')
                .where(originalWhere);
        }).let('updated', (tx) => {
            return tx.select().from('$updatedRID').fetch({'*': 1});
        }).commit();
    if (VERBOSE) {
        console.log(`update: ${commit.buildStatement()}`);
    }
    try {
        return await commit.return('$updated').one();
    } catch (err) {
        err.sql = commit.buildStatement();
        throw wrapIfTypeError(err);
    }
};

module.exports = {select, create, update, remove, checkAccess, createUser, populateCache, cacheVocabulary, QUERY_LIMIT, SelectionQuery, Follow, RELATED_NODE_DEPTH, Comparison, Clause};
