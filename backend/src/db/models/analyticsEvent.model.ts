import mongoose, { Schema, Document } from 'mongoose';

export interface IAnalyticsEvent extends Document {
  userId?: string; // Optional for anonymous events
  eventName: string;
  properties: Record<string, any>;
  createdAt: Date;
}

const analyticsEventSchema = new Schema<IAnalyticsEvent>({
  userId: { type: String, index: true },
  eventName: { type: String, required: true, index: true },
  properties: { type: Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now, index: true }
});

// Supports the date-windowed funnel aggregation in getDashboardMetrics
analyticsEventSchema.index({ eventName: 1, createdAt: -1 });

export const AnalyticsEvent = mongoose.model<IAnalyticsEvent>('AnalyticsEvent', analyticsEventSchema);
