const {expect} = require('chai');
const conf = require('./../config/db');
const {models, createSchema, loadSchema, serverConnect} = require('./../../app/repo');
const _ = require('lodash');


describe('database schema tests (empty db)', () => {
    var server, db = null;
    beforeEach((done) => { /* build and connect to the empty database */
        // set up the database server
        serverConnect(conf)
            .then((result) => {
                server = result;
                return server.create({name: conf.emptyDbName, username: conf.dbUsername, password: conf.dbPassword});
            }).then((result) => {
                db = result;
                return db.class.list();
            }).then((clsList) => {
                done();
            }).catch((error) => {
                console.log('error in connecting', error);
                done(error);
            });
    });
    it('create the evidence schema model', () => {
        return models.Evidence.createClass(db)
            .then((result) => {
                expect(result).to.be.an.instanceof(models.Evidence);
                expect(result).to.have.property('dbClass');
                expect(result.properties).to.be.empty;
                expect(result.is_abstract).to.be.true;
                // test creating a record?
            });
    });
    it('create the evidence-publication schema model', () => {
        return models.Evidence.createClass(db)
            .catch((error) => {
                throw DependencyError(error.message);
            }).then(() => {
                return models.Publication.createClass(db);
            }).then((result) => {
                expect(result).to.be.an.instanceof(models.Publication);
                expect(result).to.have.property('dbClass');
                expect(result.propertyNames).to.have.members(['pubmed_id', 'title', 'journal', 'year']);
                expect(result.is_abstract).to.be.false; 
            });
    });
    it('create the evidence-study schema model', () => {
        return models.Evidence.createClass(db)
            .catch((error) => {
                throw DependencyError(error.message);
            }).then(() => {
                return models.Study.createClass(db);
            }).then((result) => {
                expect(result).to.be.an.instanceof(models.Study);
                expect(result).to.have.property('dbClass');
                expect(result.is_abstract).to.be.false;
            });
    });
    it('create the evidence-external_db schema model', () => {
        return models.Evidence.createClass(db)
            .catch((error) => {
                throw DependencyError(error.message);
            }).then(() => {
                return models.ExternalDB.createClass(db);
            }).then((result) => {
                expect(result).to.be.an.instanceof(models.ExternalDB);
                expect(result).to.have.property('dbClass');
                expect(result.is_abstract).to.be.false; 
            });
    });

    it('create the context schema model', () => {
        return models.Context.createClass(db)
            .then((result) => {
                expect(result).to.be.an.instanceof(models.Context);
                expect(result).to.have.property('dbClass');
                expect(result.properties).to.be.empty;
                expect(result.is_abstract).to.be.true;
            });
    });
    it('create the context-evaluation model', () => {
        return models.Context.createClass(db)
            .catch((error) => {
                throw DependencyError(error.message);
            }).then((result) => {
                return models.Evaluation.createClass(db);
            }).then((result) => {
                expect(result).to.be.an.instanceof(models.Evaluation);
                expect(result).to.have.property('dbClass');
                expect(result.is_abstract).to.be.false;
                expect(result.propertyNames).to.have.members(['consequence']);
            });
    });
    it('create the context-evaluation-comparison model', () => {
        return models.Context.createClass(db)
            .then(() => {
                return models.Evaluation.createClass(db); 
            }).catch((error) => {
                throw DependencyError(error.message);
            }).then((result) => {
                return models.Comparison.createClass(db);
            }).then((result) => {
                expect(result).to.be.an.instanceof(models.Comparison);
                expect(result).to.have.property('dbClass');
                expect(result.is_abstract).to.be.false;
                expect(result.propertyNames).to.have.members(['consequence']);
            });
    });
    it('create the context-feature model');
    it('create the context-disease model', () => {
        return models.Context.createClass(db)
            .catch((error) => {
                throw DependencyError(error.message);
            }).then((result) => {
                return models.Disease.createClass(db);
            }).then((result) => {
                expect(result).to.be.an.instanceof(models.Disease);
                expect(result).to.have.property('dbClass');
                expect(result.is_abstract).to.be.false;
                expect(result.propertyNames).to.have.members(['name']);
            });
    });
    it('create the context-therapy model', () => {
        return models.Context.createClass(db)
            .catch((error) => {
                throw DependencyError(error.message);
            }).then((result) => {
                return models.Therapy.createClass(db);
            }).then((result) => {
                expect(result).to.be.an.instanceof(models.Therapy);
                expect(result).to.have.property('dbClass');
                expect(result.is_abstract).to.be.false;
                expect(result.propertyNames).to.have.members(['name']);
            });
    });
    it('create the context-event model');
    it('create the context-event-vocab model');
    it('create the context-event-positional model');
    if('create the range model');
    it('create the position model');
    it('create the position-genomic model');
    it('create the position-cds model');
    it('create the position-protein model');
    it('create the position-cytoband model');
    it('create the position-exon model');
    it.skip('create the full schema', () => {
        return createSchema(db)
            .then((result) => {
                console.log('result', Object.keys(result));
                // check the abstract classes exist
                expect(result).to.have.all.keys([
                    'evidence', 'context', 'publication', 'feature', 'disease', 'therapy'
                ]);
                // check the evidence and subclasses
                expect(result.evidence).to.have.property('properties');
                expect(result.evidence.properties).to.have.members([]);
            });
    });
    afterEach((done) => {
        /* disconnect from the database */
        console.log('dropping the test database');
        server.drop({name: conf.emptyDbName})
            .catch((error) => {
                console.log('error:', error);
            }).then(() => {
                console.log('closing the server server');
                return server.close();
            }).then(() => {
                done();
            }).catch((error) => {
                console.log('error closing the server', error);
                done(error);
            });
    })
});


