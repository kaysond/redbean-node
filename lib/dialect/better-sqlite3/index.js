// SQLite3
// -------
const defaults = require('lodash/defaults');
const map = require('lodash/map');
const {promisify} = require('util');

const Client = require('knex/lib/client');

const Raw = require('knex/lib/raw');
const Transaction = require('./execution/sqlite-transaction');
const SqliteQueryCompiler = require('./query/sqlite-querycompiler');
const SchemaCompiler = require('./schema/sqlite-compiler');
const ColumnCompiler = require('./schema/sqlite-columncompiler');
const TableCompiler = require('./schema/sqlite-tablecompiler');
const SQLite3_DDL = require('./schema/ddl');
const Formatter = require('knex/lib/formatter');

class Client_SQLite3 extends Client {

    options = {};

    constructor(config) {
        console.log(config)
        super(config);
        if (config.useNullAsDefault === undefined) {
            this.logger.warn(
                'sqlite does not support inserting default values. Set the ' +
                '`useNullAsDefault` flag to hide this warning. ' +
                '(see docs http://knexjs.org/#Builder-insert).'
            );
        }
    }

    _driver() {
        return require('better-sqlite3');
    }

    schemaCompiler() {
        return new SchemaCompiler(this, ...arguments);
    }

    transaction() {
        return new Transaction(this, ...arguments);
    }

    queryCompiler(builder, formatter) {
        return new SqliteQueryCompiler(this, builder, formatter);
    }

    columnCompiler() {
        return new ColumnCompiler(this, ...arguments);
    }

    tableCompiler() {
        return new TableCompiler(this, ...arguments);
    }

    ddl(compiler, pragma, connection) {
        return new SQLite3_DDL(this, compiler, pragma, connection);
    }

    wrapIdentifierImpl(value) {
        return value !== '*' ? `\`${value.replace(/`/g, '``')}\`` : '*';
    }

    // Get a raw connection from the database, returning a promise with the connection object.
    async acquireRawConnection() {
        const Database = this._driver();
        return new Database(this.connectionSettings.filename, this.options);
    }

    // Used to explicitly close a connection, called internally by the pool when
    // a connection times out or the pool is shutdown.
    async destroyRawConnection(connection) {
        const close = promisify((cb) => connection.close(cb));
        return close();
    }

    // Runs the query on the specified connection, providing the bindings and any
    // other necessary prep work.
    _query(connection, obj) {
        if (!obj.sql) throw new Error('The query is empty');

        const {method} = obj;
        let callMethod;
        switch (method) {
            case 'insert':
            case 'update':
            case 'counter':
            case 'del':
                callMethod = 'run';
                break;
            default:
                callMethod = 'all';
        }
        return new Promise(function (resolver, rejecter) {
            if (!connection || !connection[callMethod]) {
                return rejecter(
                    new Error(`Error calling ${callMethod} on connection.`)
                );
            }
            connection[callMethod](obj.sql, obj.bindings, function (err, response) {
                if (err) return rejecter(err);
                obj.response = response;

                // We need the context here, as it contains
                // the "this.lastID" or "this.changes"
                obj.context = this;
                return resolver(obj);
            });
        });
    }

    _stream(connection, obj, stream) {
        if (!obj.sql) throw new Error('The query is empty');

        const client = this;
        return new Promise(function (resolver, rejecter) {
            stream.on('error', rejecter);
            stream.on('end', resolver);
            return client
                ._query(connection, obj)
                .then((obj) => obj.response)
                .then((rows) => rows.forEach((row) => stream.write(row)))
                .catch(function (err) {
                    stream.emit('error', err);
                })
                .then(function () {
                    stream.end();
                });
        });
    }

    // Ensures the response is returned in the same format as other clients.
    processResponse(obj, runner) {
        const ctx = obj.context;
        const {response} = obj;
        if (obj.output) return obj.output.call(runner, response);
        switch (obj.method) {
            case 'select':
                return response;
            case 'first':
                return response[0];
            case 'pluck':
                return map(response, obj.pluck);
            case 'insert':
                return [ctx.lastID];
            case 'del':
            case 'update':
            case 'counter':
                return ctx.changes;
            default:
                return response;
        }
    }

    poolDefaults() {
        return defaults({min: 1, max: 1}, super.poolDefaults());
    }

    formatter(builder) {
        return new Formatter(this, builder);
    }

    values(values, builder, formatter) {
        if (Array.isArray(values)) {
            if (Array.isArray(values[0])) {
                return `( values ${values
                    .map(
                        (value) =>
                            `(${this.parameterize(value, undefined, builder, formatter)})`
                    )
                    .join(', ')})`;
            }
            return `(${this.parameterize(values, undefined, builder, formatter)})`;
        }

        if (values instanceof Raw) {
            return `(${this.parameter(values, builder, formatter)})`;
        }

        return this.parameter(values, builder, formatter);
    }
}

Object.assign(Client_SQLite3.prototype, {
    dialect: 'sqlite3',
    driverName: 'sqlite3',
});

module.exports = Client_SQLite3;