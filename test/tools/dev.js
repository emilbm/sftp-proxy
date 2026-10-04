// Runs the site against a local stand-in SFTP server, for working on it
// without the real one:
//
//   npm run dev                 # serves a generated sample folder
//   npm run dev -- C:\some\dir  # serves <dir>/public instead
//
// The site is at http://localhost:8080: password "development" to browse,
// "development-admin" to upload and manage files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSftpServer } from '../helpers/sftp-server.js';

let dir = process.argv[2];
if (!dir) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-proxy-dev-'));
  const pub = path.join(dir, 'public');
  fs.mkdirSync(path.join(pub, 'Photos 2026', 'Summer'), { recursive: true });
  fs.mkdirSync(path.join(pub, 'Documents'));
  fs.writeFileSync(path.join(pub, 'README.txt'), 'Welcome to the share.\n');
  fs.writeFileSync(path.join(pub, 'big-download.bin'), Buffer.alloc(25 * 1024 * 1024, 1));
  fs.writeFileSync(path.join(pub, '.hidden'), 'not listed by default');
  fs.writeFileSync(path.join(pub, 'Documents', 'Invoice 2026-09.pdf'), Buffer.alloc(180_000));
  fs.writeFileSync(path.join(pub, 'Documents', 'Notes & ideas.md'), '# notes\n');
  fs.writeFileSync(path.join(pub, 'Photos 2026', 'Summer', 'Ærø ferry.jpg'), Buffer.alloc(2_400_000));
  for (let i = 1; i <= 12; i += 1) {
    fs.writeFileSync(path.join(pub, 'Photos 2026', `IMG_${String(i).padStart(4, '0')}.jpg`), Buffer.alloc(i * 310_000));
  }
}

const srv = await startSftpServer({ dir });
process.stdout.write(`stand-in SFTP server for ${dir} on port ${srv.port}\n`);

Object.assign(process.env, {
  SFTP_HOST: '127.0.0.1',
  SFTP_PORT: String(srv.port),
  SFTP_USERNAME: srv.username,
  SFTP_PASSWORD: srv.password,
  SITE_PASSWORD: process.env.SITE_PASSWORD || 'development',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'development-admin',
  SESSION_SECRET: process.env.SESSION_SECRET || 'development',
  SITE_TITLE: process.env.SITE_TITLE || 'Files (dev)',
  LOG_LEVEL: process.env.LOG_LEVEL || 'debug',
});

await import('../../src/index.js');
