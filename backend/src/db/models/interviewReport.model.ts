import { Schema, model } from 'mongoose';
import { evaluationInputSchema, validStoredReport, type EvaluationInput, type RubricReport } from '../../modules/interview/rubricEvaluator.service.js';

interface ReportRecord {
  sessionId: string;
  userId: string;
  sourceHash: string;
  report: RubricReport;
  createdAt: Date;
}
const reportSchema = new Schema<ReportRecord>({
  sessionId: { type: String, required: true, immutable: true },
  userId: { type: String, required: true, immutable: true },
  sourceHash: { type: String, required: true, immutable: true },
  report: { type: Schema.Types.Mixed, required: true, immutable: true, validate: { validator: validStoredReport } },
  createdAt: { type: Date, default: Date.now, immutable: true },
}, { versionKey: false });
reportSchema.index({ sessionId: 1 }, { unique: true });
reportSchema.index({ userId: 1, createdAt: -1 });
reportSchema.pre('validate', function () {
  if (!this.isNew) throw new Error('InterviewReport is immutable');
});
reportSchema.pre('save', function () {
  if (!this.isNew) throw new Error('InterviewReport is immutable');
});
// Reports are inserted once; notification state belongs to the separate request.
reportSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'], function () {
  throw new Error('InterviewReport is immutable');
});
reportSchema.pre('bulkWrite', function () { throw new Error('InterviewReport does not permit bulk writes'); });
export const InterviewReport = model<ReportRecord>('InterviewReport', reportSchema);

interface EvaluationRequest {
  sessionId: string;
  userId: string;
  sourceHash: string;
  input: EvaluationInput;
  deliveredAt: Date | null;
  leaseUntil: Date;
  leaseToken: string | null;
  createdAt: Date;
}
const requestSchema = new Schema<EvaluationRequest>({
  sessionId: { type: String, required: true, immutable: true },
  userId: { type: String, required: true, immutable: true },
  sourceHash: { type: String, required: true, immutable: true },
  input: {
    type: Schema.Types.Mixed, required: true, immutable: true,
    validate: { validator: (value: unknown) => evaluationInputSchema.safeParse(value).success },
  },
  deliveredAt: { type: Date, default: null },
  leaseUntil: { type: Date, default: () => new Date(0) },
  leaseToken: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, immutable: true },
}, { versionKey: false });
requestSchema.index({ sessionId: 1 }, { unique: true });
requestSchema.index({ deliveredAt: 1, leaseUntil: 1, _id: 1 });
export const InterviewEvaluationRequest = model<EvaluationRequest>('InterviewEvaluationRequest', requestSchema);
