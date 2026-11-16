// src/shared/storage/objectStorage.ts — Object storage with time-limited signed download URLs.
// The only driver today is the local disk. Like the resume upload directory, the API and the
// render worker must see the same directory (a shared volume) for a file written by one to be
// served by the other.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Signed links stop working 15 minutes after they are issued. */
export const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const MAX_KEY_LENGTH = 200;

export interface SignedUrl {
  /** Site-relative URL; the caller prefixes the API origin when it needs an absolute link. */
  url: string;
  expiresAt: Date;
}

export interface SignedUrlParams {
  key: string;
  expires: string;
  signature: string;
}

export interface ObjectStorage {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Delete every object under `prefix` except `keep`. Returns how many were removed. */
  deleteExcept(prefix: string, keep: string): Promise<number>;
  signUrl(key: string, now?: number): SignedUrl;
  /** True only for a link this storage signed that has not expired. */
  verifySignedUrl(params: SignedUrlParams, now?: number): boolean;
}

export function isValidStorageKey(key: unknown): key is string {
  return typeof key === 'string'
    && key.length <= MAX_KEY_LENGTH
    && KEY_PATTERN.test(key)
    && !key.split('/').some(segment => segment === '.' || segment === '..' || segment.startsWith('.'));
}

export interface LocalDiskStorageOptions {
  /** Directory the objects live in. */
  root: string;
  /** HMAC key for signed URLs. */
  secret: string;
  /** Site-relative path of the route that serves verified downloads. */
  downloadPath: string;
}

export class LocalDiskObjectStorage implements ObjectStorage {
  private readonly root: string;
  private readonly secret: string;
  private readonly downloadPath: string;

  constructor(options: LocalDiskStorageOptions) {
    if (options.secret.length < 16) throw new Error('Object storage signing secret must be at least 16 characters');
    this.root = path.resolve(options.root);
    this.secret = options.secret;
    this.downloadPath = options.downloadPath;
  }

  private resolve(key: string): string {
    if (!isValidStorageKey(key)) throw new Error('Invalid object storage key');
    const file = path.resolve(this.root, key);
    if (!file.startsWith(this.root + path.sep)) throw new Error('Invalid object storage key');
    return file;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const file = this.resolve(key);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // Write beside the target and rename, so a reader never sees half a file.
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temporary, body, { mode: 0o600 });
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await fs.stat(this.resolve(key))).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async deleteExcept(prefix: string, keep: string): Promise<number> {
    const directory = this.resolve(prefix.replace(/\/$/, ''));
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    const kept = this.resolve(keep);
    let removed = 0;
    for (const name of names) {
      const file = path.join(directory, name);
      if (file === kept) continue;
      await fs.rm(file, { force: true });
      removed++;
    }
    return removed;
  }

  signUrl(key: string, now = Date.now()): SignedUrl {
    if (!isValidStorageKey(key)) throw new Error('Invalid object storage key');
    const expires = now + SIGNED_URL_TTL_MS;
    const query = new URLSearchParams({ key, expires: String(expires), sig: this.sign(key, String(expires)) });
    return { url: `${this.downloadPath}?${query}`, expiresAt: new Date(expires) };
  }

  verifySignedUrl({ key, expires, signature }: SignedUrlParams, now = Date.now()): boolean {
    if (!isValidStorageKey(key) || !/^\d{1,16}$/.test(expires) || typeof signature !== 'string') return false;
    const expected = Buffer.from(this.sign(key, expires));
    const actual = Buffer.from(signature);
    // The signature is checked first and in constant time; expiry only matters for a genuine link.
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    return Number(expires) > now;
  }

  private sign(key: string, expires: string): string {
    return createHmac('sha256', this.secret).update(`${key}\n${expires}`).digest('base64url');
  }
}

export const DOWNLOAD_PATH = '/api/v1/profile/dossier/download';

let instance: ObjectStorage | undefined;

/** Process-wide storage configured from the environment. */
export function getObjectStorage(): ObjectStorage {
  if (instance) return instance;
  const secret = process.env.OBJECT_STORAGE_SIGNING_SECRET
    ?? (process.env.NODE_ENV === 'production' ? undefined : 'devtrack-local-dev-signing-secret');
  if (!secret) throw new Error('OBJECT_STORAGE_SIGNING_SECRET is required in production');
  instance = new LocalDiskObjectStorage({
    root: path.join(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'), 'render'),
    secret,
    downloadPath: DOWNLOAD_PATH,
  });
  return instance;
}
