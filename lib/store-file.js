// Local persistence for the store: data/journal.json with atomic writes,
// plus a backup copy taken every time the server starts.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import * as store from './store.js';

export function init(dir) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'journal.json');
  let obj = {};
  if (existsSync(file)) {
    obj = JSON.parse(readFileSync(file, 'utf8'));
    copyFileSync(file, path.join(dir, 'journal.backup.json'));
  }
  const write = (state) => {
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, file);
  };
  store.setSaver(write);
  write(store.load(obj)); // persist any migrations
}
