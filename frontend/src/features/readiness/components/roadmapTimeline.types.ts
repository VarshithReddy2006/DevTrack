/** UI view model. Map the roadmap API to this shape when its contract is available. */
export interface RoadmapTask {
  id: string;
  title: string;
  completed: boolean;
  href?: string;
}

export interface RoadmapMilestone {
  id: string;
  title: string;
  objective: string;
  weekStart: number;
  weekEnd: number;
  estimatedHours: number;
  status: 'completed' | 'active' | 'locked';
  tasks: readonly RoadmapTask[];
}

export interface RoadmapTaskToggle {
  milestoneId: string;
  taskId: string;
  completed: boolean;
}

export interface RoadmapTaskState {
  completed: boolean;
  pending: boolean;
  error?: string;
}

export const roadmapTaskKey = (milestoneId: string, taskId: string) => JSON.stringify([milestoneId, taskId]);
