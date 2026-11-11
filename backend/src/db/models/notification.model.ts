import { Schema, model } from 'mongoose';

const notificationSchema = new Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  type: { type: String, required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  data: Schema.Types.Mixed,
  read: { type: Boolean, default: false },
  tone: String,
  createdAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
notificationSchema.index({ userId: 1, read: 1, createdAt: -1, id: -1 });
notificationSchema.index({ userId: 1, createdAt: -1, id: -1 });

export const NotificationRecord = model('Notification', notificationSchema);
export const NotificationPreference = model('NotificationPreference', new Schema({
  userId: { type: String, required: true, unique: true },
  preferences: { type: Schema.Types.Mixed, default: {} },
}));
