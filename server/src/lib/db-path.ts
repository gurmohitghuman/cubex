import path from 'path';

// Where Cubex keeps its data: the SQLite database, plus the instance secrets
// generated on first boot (lib/instance-secret.ts). Side-effect free, so CLI
// scripts can resolve the path without opening the database.
//
// Default is server/data/cubex.db, anchored to this file rather than
// process.cwd(): __dirname is server/src/lib under tsx and server/dist/lib when
// compiled, and '../../data' resolves to server/data either way.
export const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(__dirname, '..', '..', 'data', 'cubex.db');

export const DATA_DIR = path.dirname(DB_PATH);
