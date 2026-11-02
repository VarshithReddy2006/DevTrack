import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Mission } from '../store/missionStore';

export interface RIEState {
  executionStabilityScore: number;
  operationalMomentum: number;
  burnoutProbability: number;
  activeInsights: string[];
  primaryRecommendation: {
    action: string;
    description: string;
    type: 'critical' | 'strategic' | 'recovery';
  };
  lastSyncTimestamp: string;
  
  // Action
  syncTelemetry: (missions: Mission[]) => void;
}

// Analyzers & Helpers
const analyzeMomentum = (missions: Mission[]): number => {
  // Momentum is a factor of recent high-velocity tasks and confidence
  const totalVelocity = missions.reduce((acc, m) => acc + (m.velocity || 0), 0);
  const activeCount = missions.filter(m => m.status === 'active').length || 1;
  return Math.min(100, Math.round((totalVelocity / activeCount) * 0.8));
};

const analyzeStability = (missions: Mission[]): number => {
  // Stability is inversely proportional to the number of critical/at-risk missions
  const riskCount = missions.filter(m => m.health === 'critical' || m.health === 'at-risk').length;
  const base = 100 - (riskCount * 15);
  return Math.max(0, base);
};

const analyzeBurnout = (missions: Mission[]): number => {
  // Burnout is predicted by high actual hours compared to estimated, plus extreme deep work without breaks
  let burnoutRisk = 0;
  let totalDeepWork = 0;
  
  missions.forEach(m => {
    totalDeepWork += m.deepWorkHours || 0;
    if (m.actualHours > (m.estimatedHours || 1) * 1.5) burnoutRisk += 15;
  });

  if (totalDeepWork > 20) burnoutRisk += 20; // High cumulative deep work across active tracked state
  
  return Math.min(100, burnoutRisk);
};

const generateInsightsAndRecommendations = (
  stability: number, 
  momentum: number, 
  burnout: number, 
  missions: Mission[]
) => {
  const insights: string[] = [];
  let rec: {
    action: string;
    description: string;
    type: 'critical' | 'strategic' | 'recovery';
  } = {
    action: 'Maintain Execution',
    description: 'Current operational pacing is stable. Continue active missions.',
    type: 'strategic'
  };

  const criticalMission = missions.find(m => m.health === 'critical' || m.priority === 'critical');

  if (burnout > 70) {
    insights.push('Severe cognitive load detected. Deep work efficiency is likely declining.');
    rec = {
      action: 'Enter Recovery Mode',
      description: 'Mandatory cooldown recommended. High probability of execution burnout.',
      type: 'recovery'
    };
  } else if (criticalMission) {
    insights.push(`Mission [${criticalMission.title}] requires immediate operational attention.`);
    rec = {
      action: 'Swarm Critical Mission',
      description: 'Reallocate focus bandwidth to resolve critical at-risk targets.',
      type: 'critical'
    };
  } else if (momentum > 75) {
    insights.push('Operational velocity is accelerating. High correlation between deep work and delivery.');
    rec = {
      action: 'Push Delivery',
      description: 'Capitalize on current momentum to close out near-complete missions.',
      type: 'strategic'
    };
  } else if (stability < 50) {
    insights.push('Execution drift detected. Multiple missions are stagnating.');
    rec = {
      action: 'Reduce Context Switching',
      description: 'Pause secondary operations. Focus on a single primary target to regain stability.',
      type: 'strategic'
    };
  } else {
    insights.push('Execution environment is nominal.');
  }

  return { insights, rec };
};

export const useRIEStore = create<RIEState>()(
  persist(
    (set) => ({
      executionStabilityScore: 100,
      operationalMomentum: 0,
      burnoutProbability: 0,
      activeInsights: ['Engine initialized. Analyzing baseline telemetry...'],
      primaryRecommendation: {
        action: 'Execute',
        description: 'Initialize focus session to begin telemetry tracking.',
        type: 'strategic'
      },
      lastSyncTimestamp: new Date().toISOString(),

      syncTelemetry: (missions) => set((state) => {
        if (!missions || missions.length === 0) return state;

        const momentum = analyzeMomentum(missions);
        const stability = analyzeStability(missions);
        const burnout = analyzeBurnout(missions);
        
        const { insights, rec } = generateInsightsAndRecommendations(stability, momentum, burnout, missions);

        return {
          executionStabilityScore: stability,
          operationalMomentum: momentum,
          burnoutProbability: burnout,
          activeInsights: insights,
          primaryRecommendation: rec,
          lastSyncTimestamp: new Date().toISOString(),
        };
      })
    }),
    {
      name: 'rie-storage',
      skipHydration: true,
    }
  )
);
