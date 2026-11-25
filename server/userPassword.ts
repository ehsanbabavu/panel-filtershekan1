import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function encryptionKey() {
  const value = process.env.USER_PASSWORD_ENCRYPTION_KEY?.trim();
  if (!value) return null;
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('USER_PASSWORD_ENCRYPTION_KEY باید یک کلید تصادفی ۳۲ بایتی با فرمت hex باشد.');
  return Buffer.from(value, 'hex');
}

// Authentication still uses bcrypt. This separate copy is only for the linked user's private bot report.
export function encryptUserPassword(password: string, passwordHash: string) {
  const key = encryptionKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(passwordHash));
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptUserPassword(value: string | null, passwordHash: string | null) {
  if (!value || !passwordHash) return null;
  try {
    const key = encryptionKey();
    if (!key) return null;
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const iv = Buffer.from(parts[1], 'base64url'), tag = Buffer.from(parts[2], 'base64url');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(passwordHash));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch { return null; }
}
