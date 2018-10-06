const fs = require('fs-extra');
const Loki = require('lokijs');
const { createGenesisBlock } = require('./Blockchain');
const lfsa = require('../libs/loki-fs-structured-adapter');
const { IPC } = require('../libs/IPC');

if (process.env.NODE_ENV === 'test') console.log = () => {}; // eslint-disable-line

const PLUGIN_NAME = 'Database';
const PLUGIN_PATH = require.resolve(__filename);

const PLUGIN_ACTIONS = {
  ADD_BLOCK: 'addBlock',
  GET_LATEST_BLOCK_INFO: 'getLatestBlockInfo',
  FIND_CONTRACT: 'findContract',
  ADD_CONTRACT: 'addContract',
  FIND: 'find',
  FIND_ONE: 'findOne',
  CREATE_TABLE: 'createTable',
  INSERT: 'insert',
  REMOVE: 'remove',
  UPDATE: 'update',
  GET_TABLE_DETAILS: 'getTableDetails',
};

const actions = {};

const ipc = new IPC(PLUGIN_NAME);

let database = null;
let chain = null;
let saving = false;

// load the database from the filesystem
function init(conf, callback) {
  const {
    autosaveInterval,
    chainId,
    databaseFileName,
    dataDirectory,
  } = conf;

  const databaseFilePath = dataDirectory + databaseFileName;

  // init the database
  database = new Loki(databaseFilePath, {
    adapter: new lfsa(), // eslint-disable-line new-cap
    autosave: autosaveInterval > 0,
    autosaveInterval,
  });

  // check if the app has already be run
  if (fs.pathExistsSync(databaseFilePath)) {
    // load the database from the filesystem to the RAM
    database.loadDatabase({}, (errorDb) => {
      if (errorDb) {
        callback(errorDb);
      }

      // if the chain or the contracts collection doesn't exist we return an error
      chain = database.getCollection('chain');
      const contracts = database.getCollection('contracts');
      if (chain === null || contracts === null) {
        callback('The database is missing either the chain or the contracts table');
      }

      callback(null);
    });
  } else {
    // create the data directory if necessary and empty it if files exists
    fs.emptyDirSync(dataDirectory);

    // init the main tables
    chain = database.addCollection('chain');
    database.addCollection('contracts', { indices: ['name'] });

    // insert the genesis block
    chain.insert(createGenesisBlock(chainId));

    callback(null);
  }
}

// save the blockchain as well as the database on the filesystem
function stop(callback) {
  saving = true;

  // save the database from the RAM to the filesystem
  database.saveDatabase((err) => {
    saving = false;
    if (err) {
      callback(err);
    }

    callback(null);
  });
}

actions.addBlock = (block) => { // eslint-disable-line no-unused-vars
  chain.insert(block);
};

actions.getLatestBlockInfo = () => { // eslint-disable-line no-unused-vars
  const { maxId } = chain;
  return chain.get(maxId);
};

/**
 * Get the information of a contract (owner, source code, etc...)
 * @param {String} contract name of the contract
 * @returns {Object} returns the contract info if it exists, null otherwise
 */
actions.findContract = (payload) => {
  const { name } = payload;
  if (name && typeof name === 'string') {
    const contracts = database.getCollection('contracts');
    const contractInDb = contracts.findOne({ name });

    if (contractInDb) {
      return contractInDb;
    }
  }

  return null;
};

/**
 * add a smart contract to the database
 * @param {String} name name of the contract
 * @param {String} owner owner of the contract
 * @param {String} code code of the contract
 * @param {String} tables tables linked to the contract
 */
actions.addContract = (payload) => { // eslint-disable-line no-unused-vars
  const {
    name,
    owner,
    code,
    tables,
  } = payload;

  if (name && typeof name === 'string'
    && owner && typeof owner === 'string'
    && code && typeof code === 'string'
    && tables && Array.isArray(tables)) {
    const contracts = database.getCollection('contracts');
    contracts.insert(payload);
  }
};

/**
 * Add a table to the database
 * @param {String} contractName name of the contract
 * @param {String} tableName name of the table
 * @param {Array} indexes array of string containing the name of the indexes to create
 */
actions.createTable = (payload) => { // eslint-disable-line no-unused-vars
  const { contractName, tableName, indexes } = payload;
  const RegexLetters = /^[a-zA-Z_]+$/;

  // check that the params are correct
  // each element of the indexes array have to be a string if defined
  if (RegexLetters.test(tableName)
    && Array.isArray(indexes)
    && (indexes.length === 0
    || (indexes.length > 0 && indexes.every(el => typeof el === 'string')))) {
    const finalTableName = `${contractName}_${tableName}`;
    // get the table from the database
    const table = database.getCollection(finalTableName);
    if (table === null) {
      // if it doesn't exist, create it (with the binary indexes)
      database.addCollection(finalTableName, { indices: indexes });
      return true;
    }
  }

  return false;
};

/**
 * retrieve records from the table of a contract
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {JSON} query query to perform on the table
 * @param {Integer} limit limit the number of records to retrieve
 * @param {Integer} offset offset applied to the records set
 * @param {String} index name of the index to use for the query
 * @param {Boolean} descending the records set is sorted ascending if false, descending if true
 * @returns {Array<Object>} returns an array of objects if records found, an empty array otherwise
 */
actions.find = (payload) => { // eslint-disable-line no-unused-vars
  const {
    contract,
    table,
    query,
    limit,
    offset,
    index,
    descending,
  } = payload;

  const lim = limit || 1000;
  const off = offset || 0;
  const ind = index || '';
  const des = descending || false;

  if (contract && typeof contract === 'string'
    && table && typeof table === 'string'
    && query && typeof query === 'object'
    && typeof ind === 'string'
    && typeof des === 'boolean'
    && Number.isInteger(lim)
    && Number.isInteger(off)
    && lim > 0 && lim <= 1000
    && off >= 0) {
    const contractInDb = actions.findContract({ name: contract });

    if (contractInDb) {
      const finalTableName = `${contract}_${table}`;
      if (contractInDb.tables.includes(finalTableName)) {
        const tableData = database.getCollection(finalTableName);

        // if there is an index passed, check if it exists
        if (ind !== '' && tableData.binaryIndices[ind] !== undefined) {
          return tableData.chain()
            .find(query)
            .simplesort(ind, des)
            .offset(off)
            .limit(lim)
            .data();
        }

        return tableData.chain()
          .find(query)
          .offset(off)
          .limit(lim)
          .data();
      }
    }
  }

  return null;
};

/**
 * retrieve a record from the table of a contract
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {JSON} query query to perform on the table
 * @returns {Object} returns a record if it exists, null otherwise
 */
actions.findOne = (payload) => { // eslint-disable-line no-unused-vars
  const { contract, table, query } = payload;

  if (contract && typeof contract === 'string'
    && table && typeof table === 'string'
    && query && typeof query === 'object') {
    const contractInDb = actions.findContract({ name: contract });

    if (contractInDb) {
      const finalTableName = `${contract}_${table}`;
      if (contractInDb.tables.includes(finalTableName)) {
        const tableData = database.getCollection(finalTableName);
        return tableData.findOne(query);
      }
    }
  }

  return null;
};

/**
 * insert a record in the table of a contract
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {String} record record to save in the table
 */
actions.insert = (payload) => { // eslint-disable-line no-unused-vars
  const { contract, table, record } = payload;
  const finalTableName = `${contract}_${table}`;

  const contractInDb = actions.findContract({ name: contract });
  if (contractInDb && contractInDb.tables.includes(finalTableName)) {
    const tableInDb = database.getCollection(finalTableName);
    if (tableInDb) {
      return tableInDb.insert(record);
    }
  }
  return null;
};

/**
 * remove a record in the table of a contract
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {String} record record to remove from the table
 */
actions.remove = (payload) => { // eslint-disable-line no-unused-vars
  const { contract, table, record } = payload;
  const finalTableName = `${contract}_${table}`;

  const contractInDb = actions.findContract({ name: contract });
  if (contractInDb && contractInDb.tables.includes(finalTableName)) {
    const tableInDb = database.getCollection(finalTableName);
    if (tableInDb) {
      tableInDb.remove(record);
    }
  }
};

/**
 * update a record in the table of a contract
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {String} record record to update in the table
 */
actions.update = (payload) => { // eslint-disable-line no-unused-vars
  const { contract, table, record } = payload;
  const finalTableName = `${contract}_${table}`;

  const contractInDb = actions.findContract({ name: contract });
  if (contractInDb && contractInDb.tables.includes(finalTableName)) {
    const tableInDb = database.getCollection(finalTableName);
    if (tableInDb) {
      tableInDb.update(record);
    }
  }
};

/**
 * get the details of a smart contract table
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {String} record record to update in the table
 * @returns {Object} returns the table details if it exists, null otherwise
 */
actions.getTableDetails = (payload) => { // eslint-disable-line no-unused-vars
  const { contract, table } = payload;
  const finalTableName = `${contract}_${table}`;
  const contractInDb = actions.findContract({ name: contract });
  if (contractInDb && contractInDb.tables.includes(finalTableName)) {
    const tableInDb = database.getCollection(finalTableName);
    if (tableInDb) {
      return { ...tableInDb, data: [] };
    }
  }

  return null;
};

ipc.onReceiveMessage((message) => {
  const {
    action,
    payload,
    // from,
  } = message;

  if (action === 'init') {
    init(payload, (res) => {
      console.log('successfully initialized');
      ipc.reply(message, res);
    });
  } else if (action === 'stop') {
    stop((res) => {
      console.log('successfully saved');
      ipc.reply(message, res);
    });
  } else if (action && typeof actions[action] === 'function') {
    if (!saving) {
      const res = actions[action](payload);
      // console.log('action', action, 'res', res, 'payload', payload);
      ipc.reply(message, res);
    } else {
      ipc.reply(message);
    }
  } else {
    ipc.reply(message);
  }
});

module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLUGIN_PATH = PLUGIN_PATH;
module.exports.PLUGIN_ACTIONS = PLUGIN_ACTIONS;
