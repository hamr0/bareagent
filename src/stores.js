'use strict';

const { SQLiteStore } = require('./store-sqlite');
const { JsonFileStore } = require('./store-jsonfile');

module.exports = {
  SQLite: SQLiteStore,
  JsonFile: JsonFileStore,
};
