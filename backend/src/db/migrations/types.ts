import type { ClientSession, mongo } from 'mongoose';

export interface MigrationContext {
  db: mongo.Db;
  session?: ClientSession;
}

export interface Migration {
  name: string;
  up(context: MigrationContext): Promise<void>;
  down(context: MigrationContext): Promise<void>;
}

export interface VersionedMigration extends Migration {
  checksum: string;
}