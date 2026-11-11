import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

export interface ArtifactStorage {
  store(temporaryPath: string, name: string): Promise<string>;
  readPath(reference: string): Promise<string>;
  remove(reference: string): Promise<void>;
  move(reference: string, destination: 'failed' | 'processed'): Promise<void>;
}

/** API and worker must see the same directory at the same absolute mount path. */
export class DirectoryArtifactStorage implements ArtifactStorage {
  readonly root: string;
  private readonly raw: string;

  constructor(root = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads')) {
    this.root = path.resolve(root);
    this.raw = path.join(this.root, 'raw');
  }

  async store(temporaryPath: string, name: string): Promise<string> {
    if (!name || name !== path.basename(name) || name.includes('\\') || name === '.' || name === '..') {
      throw new Error('Invalid resume artifact filename');
    }
    const destination = path.join(this.raw, name);
    await fs.mkdir(this.raw, { recursive: true, mode: 0o700 });

    try {
      await fs.rename(temporaryPath, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;

      await fs.copyFile(temporaryPath, destination, constants.COPYFILE_EXCL);
      try {
        await fs.unlink(temporaryPath);
      } catch (unlinkError) {
        await this.remove(destination);
        throw unlinkError;
      }
    }
    return destination;
  }

  async readPath(reference: string): Promise<string> {
    // Persisted sessions already contain filesystem paths. Keep them readable
    // during upgrades even if a deployment used a different legacy directory.
    const info = await fs.stat(reference);
    if (!info.isFile()) throw new Error('Resume artifact is not a file');
    return reference;
  }

  async remove(reference: string): Promise<void> {
    if (!this.manages(reference)) return;
    try {
      await fs.unlink(reference);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async move(reference: string, destination: 'failed' | 'processed'): Promise<void> {
    if (!this.manages(reference)) return;
    const directory = path.join(this.root, destination);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await fs.rename(reference, path.join(directory, path.basename(reference)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private manages(reference: string): boolean {
    return path.dirname(path.resolve(reference)) === this.raw;
  }
}

export const artifactStorage = new DirectoryArtifactStorage();
