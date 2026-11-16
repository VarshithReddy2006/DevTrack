import type { mongo } from 'mongoose';
import { PUBLIC_PROFILE_SECTIONS } from '../models/publicProfile.model.js';
import { RESERVED_SLUGS, USERNAME_RESERVATION_INDEXES } from '../models/usernameReservation.model.js';

const profilesCollection = 'publicprofiles';
const reservationsCollection = 'usernamereservations';

/**
 * Profiles used to be public by default. Every profile that predates the opt-in fields is
 * unpublished: its owner has to run the publish flow before it is served again. Reserved
 * application paths are seeded so the database refuses them too.
 */
export async function migratePublicProfileOptIn(db: mongo.Db): Promise<void> {
  await db.collection(profilesCollection).updateMany(
    { published: { $exists: false } },
    {
      $set: {
        published: false,
        visibility: 'private',
        isIndexable: false,
        sections: Object.fromEntries(PUBLIC_PROFILE_SECTIONS.map(section => [section, false])),
        publicationVersion: 0,
        publication: { consentVersion: null, publishedAt: null },
      },
    },
  );

  const reservations = db.collection(reservationsCollection);
  for (const { key, options } of Object.values(USERNAME_RESERVATION_INDEXES)) {
    await reservations.createIndex(key, options);
  }
  await reservations.bulkWrite(RESERVED_SLUGS.map(slug => ({
    updateOne: {
      filter: { slug },
      update: { $setOnInsert: { slug, userId: null, status: 'reserved_system', createdAt: new Date() } },
      upsert: true,
    },
  })));
}

/**
 * Removes the opt-in fields, the reservation indexes and the seeded system reservations.
 * It does not make anything public again: profiles stay private until the old model is
 * back and someone sets their visibility on purpose.
 */
export async function rollbackPublicProfileOptIn(db: mongo.Db): Promise<void> {
  await db.collection(profilesCollection).updateMany(
    { published: { $exists: true } },
    { $unset: { published: '', sections: '', publicationVersion: '', publication: '' } },
  );

  const reservations = db.collection(reservationsCollection);
  await reservations.deleteMany({ status: 'reserved_system' });
  for (const { options } of Object.values(USERNAME_RESERVATION_INDEXES)) {
    try {
      await reservations.dropIndex(options.name);
    } catch (error) {
      const code = (error as { code?: number }).code;
      // 26: collection missing, 27: index missing. Both mean there is nothing to drop.
      if (code !== 26 && code !== 27) throw error;
    }
  }
}
