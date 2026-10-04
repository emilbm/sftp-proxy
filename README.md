# sftp-proxy

A small website that lists the files in an SFTP server's `public` folder and
lets people download them, behind a shared password. An optional second
password lets you manage the files from the browser too.

```
 browser ──HTTP──▶ sftp-proxy ──SFTP──▶ SFTP server (~/public)
```

For when the SFTP server itself should stay on the LAN: this is the one thing
you expose (for example through a Cloudflare tunnel).

- **Two passwords, no accounts.** The download password lets people browse and
  download, for 30 days per sign-in. The optional admin password also lets you
  upload, create folders, rename and delete, for 12 hours per sign-in.
  Repeated wrong guesses lock that visitor out for a while.
- **Folders are browsable**, files download with their real names, and
  interrupted downloads can resume (HTTP range requests).
- **Uploads of any size.** Files go up in 16 MB chunks, so proxy request limits
  (Cloudflare's is 100 MB) don't apply, and a dropped connection resumes from
  the last chunk. A name that already exists gets a postfix, `photo (1).jpg`,
  and is never overwritten.
- **A storage bar**, in the style of macOS's, shows what the share holds by kind
  of file, and how full the disk is.
- **Nothing is stored.** Files stream straight from SFTP to the browser; the
  container has a read-only filesystem and no volumes.
- **Stays inside the folder.** Paths are resolved by the SFTP server and checked
  against the public folder, so `..` tricks and symlinks pointing elsewhere
  lead nowhere.
- **Errors go to GlitchTip** (or Sentry) when `SENTRY_DSN` is set.

---

## Deploying

Published images live at `ghcr.io/emilbm/sftp-proxy`, built and tested by CI
on every push to `main`. The target host needs Docker, `compose.yaml` and a
`.env`. It can be any machine that can reach the SFTP server.

```bash
mkdir -p ~/sftp-proxy && cd ~/sftp-proxy
```

```bash
curl -fsSLO https://raw.githubusercontent.com/emilbm/sftp-proxy/main/compose.yaml
```

```bash
curl -fsSL https://raw.githubusercontent.com/emilbm/sftp-proxy/main/.env.example -o .env
```

Fill in `.env`. Four settings are required:

| Setting | |
|---|---|
| `SFTP_HOST` | the SFTP server's address |
| `SFTP_USERNAME` | an account that can read the public folder |
| `SFTP_PASSWORD` *or* `SFTP_PRIVATE_KEY_PATH` | how to log in as it |
| `SITE_PASSWORD` | the password visitors type |

It is also worth setting `SESSION_SECRET` (`openssl rand -hex 32`) so a restart
does not sign everyone out, and `SENTRY_DSN` for error reporting. Every
option is described in [`.env.example`](.env.example).

```bash
docker compose up -d && docker compose logs -f
```

The log says whether the public folder could be read. The site is on port
8080.

### Pin the host key

On first start the log prints a warning along these lines:

```
WARN  [sftp] SFTP host key is not pinned - set SFTP_HOST_KEY_SHA256 to this value {"fingerprint":"SHA256:k2B7..."}
```

Check it against the server (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
on the SFTP host, or wherever your SFTP container keeps its keys), put it in
`.env` as `SFTP_HOST_KEY_SHA256`, and `docker compose up -d`. From then on
the proxy refuses to talk to anything presenting a different key.

### Exposing it to the internet

The container speaks plain HTTP. Put HTTPS in front of it before it leaves the
LAN, so the password is not sent in the clear. A Cloudflare tunnel pointed at
`http://<host>:8080` does that. When a proxy is in front, also set
`TRUST_PROXY=true` so the wrong-password lockout applies per visitor instead
of to the proxy as a whole.

The session cookie is marked `Secure` automatically when the proxy reports
HTTPS (`X-Forwarded-Proto`).

### The SFTP account

The proxy can do anything its SFTP account can, so give it an account that is
chrooted to, or only has permissions on, the public folder.

- **Download-only** (no `ADMIN_PASSWORD`): the account only needs to read.
- **With `ADMIN_PASSWORD`**: the account needs write access to the public folder,
  and to nothing else. Uploads are staged in a hidden `.uploads` folder inside
  it and moved into place when complete. Abandoned ones are removed after a day.

### Admin: managing files from the browser

Set `ADMIN_PASSWORD` (at least 16 characters, different from `SITE_PASSWORD`).
Signing in with it shows **Upload files** and **New folder** buttons, a rename
and delete button on each row, and you can drop files anywhere on the page.
Deleting a folder deletes everything in it, after a confirmation.

Every write goes through `/admin/...` and is checked on the server for an admin
session and a per-page token, so neither a viewer nor another website can make
one. Names starting with a dot are refused.

If the site is reachable from the internet, the admin password is the only
thing between a stranger and your files. For a second lock, put a
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
application on `your.domain/admin` that only lets your own email through. Viewers
are unaffected, and a leaked admin password alone is then useless.

### The storage bar

The bar shows what the share holds by kind of file (photos, videos, music,
documents, archives, other), plus how big and how full the disk is. The disk
figures come from OpenSSH's `statvfs` extension, which OpenSSH enables by
default. Other servers just show the share's own total. The count is cached for
five minutes and redone straight after any admin change.

### Verifying error reporting

With `SENTRY_DSN` set, sign in and open `/throw`. It raises a deliberate
exception, and the error page shows the event id that should appear in
GlitchTip. Only signed-in visitors can reach it.

What gets reported: an unreachable SFTP server, a missing public folder, a
download that fails partway through, an admin change the SFTP account is not
allowed to make, and anything unexpected. A missing file, a wrong password or a
cancelled download is not reported.

### Updating

```bash
docker compose pull && docker compose up -d
```

---

## Developing

Needs Node 24.

```bash
npm install
```

```bash
npm test
```

The tests run the real SFTP client against an in-process SFTP server, so no
external server is needed.

```bash
npm run dev
```

This starts the site on http://localhost:8080 (password `development`, or
`development-admin` for the admin tools) against
a local stand-in SFTP server with a sample folder. Use
`npm run dev -- <dir>` to serve `<dir>/public` instead.

To build the image locally:

```bash
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```
