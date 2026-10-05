import crypto from 'node:crypto';

export const SHARE_DAYS = [1, 7, 30, 90, 365];
export const DEFAULT_SHARE_DAYS = 30;

/**
 * Share links: anyone holding one can download one file until it expires,
 * without a password.
 *
 * A link carries everything it needs - the file's path and the expiry -
 * sealed with AES-256-GCM. Nothing is stored, so there is no database to
 * keep; the seal means a link cannot be forged or edited, and encrypting
 * rather than just signing keeps the folder path out of view of whoever the
 * link is sent to.
 *
 * The key is derived from SESSION_SECRET, so changing that secret cancels
 * every outstanding link (and signs everyone out). Individual links cannot
 * be cancelled; that is the price of not storing them.
 */
export function createShareLinks({ secret, now = Date.now }) {
  const key = crypto.createHmac('sha256', secret).update('share-links\0v1').digest();

  return {
    /** @returns {string} the token for /s/<token> */
    create(rel, expiresAt) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([
        cipher.update(JSON.stringify({ p: rel, e: Math.floor(expiresAt / 1000) })),
        cipher.final(),
      ]);
      return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
    },

    /**
     * @returns {{rel: string, expiresAt: number, expired: boolean}|null}
     *   null when the token is not one of ours (or has been tampered with)
     */
    open(token) {
      if (typeof token !== 'string' || token.length > 4096 || !/^[\w-]+$/.test(token)) return null;
      const raw = Buffer.from(token, 'base64url');
      if (raw.length < 12 + 16 + 2) return null;
      // Base64's last character carries unused bits, so several spellings
      // decode alike; accept only the exact one we handed out.
      if (raw.toString('base64url') !== token) return null;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(raw.length - 16));
        const json = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
        const { p, e } = JSON.parse(json.toString('utf8'));
        if (typeof p !== 'string' || !Number.isInteger(e)) return null;
        const expiresAt = e * 1000;
        return { rel: p, expiresAt, expired: expiresAt <= now() };
      } catch {
        return null;
      }
    },
  };
}
