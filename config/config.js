const {ORIENTDB_HOME} = process.env;

const dbName = process.env.DB_NAME || `kbapi_v${process.env.npm_package_version}`;

const create = () => {
    const server = {
        pass: process.env.DBS_PASS || 'root',
        user: process.env.DBS_USER || 'root',
        port: process.env.DB_PORT || 2426,
        host: process.env.DB_HOST || 'orientdb02.bcgsc.ca'
    };

    const db = {
        name: dbName,
        url: `plocal:${ORIENTDB_HOME}/databases/${dbName}`,
        pass: process.env.DB_PASS || 'admin',
        user: process.env.DB_USER || 'admin',
        host: server.host,
        port: server.port,
        create: process.env.DB_CREATE === '1',
        migrate: process.env.DB_MIGRATE === '1'
    };

    const keycloak = {
        uri: process.env.KEYCLOAK_URI || 'https://sso.bcgsc.ca/auth/realms/GSC/protocol/openid-connect/token',
        clientID: process.env.KEYCLOAK_CLIENTID || 'GraphKB',
        publicKeyFile: process.env.KEYCLOAK_KEYFILE || 'keycloak.id_rsa.pub',
        role: process.env.KEYCLOAK_ROLE || 'GraphKB'
    };

    return {
        server,
        db,
        app: {port: process.env.PORT || 8080},
        privateKeyFile: process.env.KEY_FILE || 'id_rsa',
        disableAuth: process.env.DISABLE_AUTH === '1',
        keycloak,
        createUser: true
    };
};

module.exports = create;
