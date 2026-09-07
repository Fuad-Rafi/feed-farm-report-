// Pooled, read-only connection to the DWH warehouse.
// Every query in this project goes through here. Nothing writes.
require('dotenv').config();
const sql = require('mssql');

const config = {
  server: process.env.MSSQL_SERVER,
  port: Number(process.env.MSSQL_PORT || 1433),
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  database: process.env.MSSQL_DATABASE,
  options: {
    encrypt: String(process.env.MSSQL_ENCRYPT).toLowerCase() === 'true',
    trustServerCertificate: String(process.env.MSSQL_TRUST_SERVER_CERTIFICATE).toLowerCase() === 'true',
    enableArithAbort: true
  },
  pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
  requestTimeout: 180000,
  connectionTimeout: 30000
};

let poolPromise = null;

function getPool() {
  if (!poolPromise) poolPromise = new sql.ConnectionPool(config).connect();
  return poolPromise;
}

// params: { name: value } or { name: { type, value } }
async function query(text, params = {}) {
  const pool = await getPool();
  const req = pool.request();
  for (const [name, raw] of Object.entries(params)) {
    if (raw && typeof raw === 'object' && 'type' in raw) req.input(name, raw.type, raw.value);
    else req.input(name, raw);
  }
  const result = await req.query(text);
  return result.recordset;
}

async function ping() {
  const rows = await query('SELECT @@VERSION AS version, DB_NAME() AS db, SUSER_NAME() AS login');
  return rows[0];
}

async function close() {
  if (poolPromise) {
    const pool = await poolPromise;
    await pool.close();
    poolPromise = null;
  }
}

module.exports = { sql, getPool, query, ping, close };
