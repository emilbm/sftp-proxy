import fs from 'node:fs';
import path from 'node:path';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;
const { STATUS_CODE } = utils.sftp;

// ssh2 now and then generates an ed25519 key its own parser rejects
// ("Malformed OpenSSH private key"), so check before use, and make one per
// test process rather than one per server.
let cachedHostKey = null;
function hostKeyPair() {
  for (let i = 0; !cachedHostKey && i < 20; i += 1) {
    const pair = utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(pair.private) instanceof Error)) cachedHostKey = pair;
  }
  if (!cachedHostKey) throw new Error('could not generate a usable host key');
  return cachedHostKey;
}

/**
 * A tiny read-only SFTP server over a local directory, enough to exercise the
 * real client end to end: REALPATH, STAT/LSTAT, OPENDIR/READDIR, OPEN/READ.
 * The directory is exposed as `/`, and the login directory is `/`.
 */
export async function startSftpServer({ dir, username = 'test', password = 'secret' }) {
  const hostKey = hostKeyPair();
  const sockets = new Set();
  const stats = { connections: 0 };

  const toLocal = (virtual) => path.join(dir, ...virtual.split('/').filter(Boolean));
  const normalise = (p) => {
    const parts = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return `/${parts.join('/')}`;
  };
  const attrsOf = (st) => ({
    mode: st.mode, uid: 0, gid: 0, size: st.size,
    atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000),
  });

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    stats.connections += 1;
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === username && ctx.password === password) ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('error', () => {});
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map();
          let next = 0;
          const newHandle = (value) => {
            const id = Buffer.alloc(4);
            id.writeUInt32BE(next++);
            handles.set(id.toString('hex'), value);
            return id;
          };
          const fail = (reqid, err) => sftp.status(
            reqid, err?.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE,
          );

          sftp.on('REALPATH', (reqid, p) => {
            // Resolve symlinks like a real server would, against the virtual root.
            let virtual = normalise(p.startsWith('/') ? p : `/${p}`);
            try {
              const real = fs.realpathSync(toLocal(virtual));
              const base = fs.realpathSync(dir);
              const relative = path.relative(base, real).split(path.sep).join('/');
              virtual = relative.startsWith('..') ? `/../outside/${relative}` : normalise(`/${relative}`);
              sftp.name(reqid, [{ filename: virtual, longname: virtual, attrs: {} }]);
            } catch (err) {
              fail(reqid, err);
            }
          });
          for (const op of ['STAT', 'LSTAT']) {
            sftp.on(op, (reqid, p) => {
              try {
                const st = op === 'STAT' ? fs.statSync(toLocal(p)) : fs.lstatSync(toLocal(p));
                sftp.attrs(reqid, attrsOf(st));
              } catch (err) {
                fail(reqid, err);
              }
            });
          }
          sftp.on('OPENDIR', (reqid, p) => {
            try {
              const names = fs.readdirSync(toLocal(p));
              sftp.handle(reqid, newHandle({ dir: p, names, done: false }));
            } catch (err) {
              fail(reqid, err);
            }
          });
          sftp.on('READDIR', (reqid, handle) => {
            const h = handles.get(handle.toString('hex'));
            if (!h || h.done) return sftp.status(reqid, STATUS_CODE.EOF);
            h.done = true;
            sftp.name(reqid, ['.', '..', ...h.names].map((name) => {
              const st = fs.lstatSync(toLocal(`${h.dir}/${name}`));
              return { filename: name, longname: name, attrs: attrsOf(st) };
            }));
          });
          sftp.on('OPEN', (reqid, p, flags) => {
            try {
              const mode = utils.sftp.flagsToString(flags) ?? 'r';
              sftp.handle(reqid, newHandle({ fd: fs.openSync(toLocal(p), mode) }));
            } catch (err) {
              fail(reqid, err);
            }
          });
          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const h = handles.get(handle.toString('hex'));
            fs.writeSync(h.fd, data, 0, data.length, Number(offset));
            sftp.status(reqid, STATUS_CODE.OK);
          });
          for (const op of ['SETSTAT', 'FSETSTAT']) {
            sftp.on(op, (reqid) => sftp.status(reqid, STATUS_CODE.OK));
          }
          // Mirror OpenSSH: creating or renaming onto an existing name is a
          // generic FAILURE, never an overwrite.
          sftp.on('MKDIR', (reqid, p) => {
            try {
              fs.mkdirSync(toLocal(p));
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (err) {
              fail(reqid, err);
            }
          });
          sftp.on('RENAME', (reqid, from, to) => {
            try {
              if (fs.existsSync(toLocal(to))) return sftp.status(reqid, STATUS_CODE.FAILURE);
              fs.renameSync(toLocal(from), toLocal(to));
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (err) {
              fail(reqid, err);
            }
          });
          sftp.on('REMOVE', (reqid, p) => {
            try {
              if (fs.lstatSync(toLocal(p)).isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE);
              fs.unlinkSync(toLocal(p));
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (err) {
              fail(reqid, err);
            }
          });
          sftp.on('RMDIR', (reqid, p) => {
            try {
              fs.rmdirSync(toLocal(p));
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (err) {
              fail(reqid, err);
            }
          });
          sftp.on('READ', (reqid, handle, offset, length) => {
            const h = handles.get(handle.toString('hex'));
            const buf = Buffer.alloc(length);
            const n = fs.readSync(h.fd, buf, 0, length, Number(offset));
            if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF);
            sftp.data(reqid, buf.subarray(0, n));
          });
          sftp.on('FSTAT', (reqid, handle) => {
            const h = handles.get(handle.toString('hex'));
            sftp.attrs(reqid, attrsOf(fs.fstatSync(h.fd)));
          });
          sftp.on('CLOSE', (reqid, handle) => {
            const key = handle.toString('hex');
            const h = handles.get(key);
            if (h?.fd !== undefined) fs.closeSync(h.fd);
            handles.delete(key);
            sftp.status(reqid, STATUS_CODE.OK);
          });
        });
      });
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // ssh2 does not expose its sockets; track them on the inner net.Server.
  server._srv.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  const publicKey = utils.parseKey(hostKey.public).getPublicSSH();

  return {
    port: server.address().port,
    username,
    password,
    publicKey,
    stats,
    /** Cut every live connection, as a server restart would. */
    dropAll() {
      for (const s of sockets) s.destroy();
    },
    close: () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}
