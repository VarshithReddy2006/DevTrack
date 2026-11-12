import type { PipelineStage } from 'mongoose';

export function numberOrZero(field: string) {
  return { $ifNull: [field, 0] };
}

export function topDropOffs(field: '$dropOffStep' | '$dropOffReason'): PipelineStage.FacetPipelineStage[] {
  return [
    { $match: { [field.slice(1)]: { $type: 'string', $ne: '' } } },
    { $group: { _id: field, count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: 10 },
  ];
}

export type DropOffCount = { _id: string; count: number };
