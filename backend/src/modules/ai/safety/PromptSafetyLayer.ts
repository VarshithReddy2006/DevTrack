import { logger } from '../../../shared/logger.js';

export interface SafetyCheckResult {
  safe: boolean;
  violations: string[];
  warnings: string[];
  filteredContent?: string;
}

export interface SafetyPolicy {
  id: string;
  description: string;
  patterns: RegExp[];
  severity: 'critical' | 'warning' | 'info';
  action: 'block' | 'filter' | 'warn';
}

class PromptSafetyLayerClass {
  private policies: SafetyPolicy[] = [
    {
      id: 'no-hiring-guarantees',
      description: 'Prohibit hiring/placement guarantees',
      patterns: [
        /will definitely get/gi,
        /guaranteed to get/gi,
        /guarantee you (will|get)/gi,
        /definitely (get|land|secure)/gi,
        /certain to (get|land|secure)/gi,
        /you will (definitely|surely|certainly) (get|land|secure)/gi,
      ],
      severity: 'critical',
      action: 'block',
    },
    {
      id: 'no-salary-guarantees',
      description: 'Prohibit salary guarantees',
      patterns: [
        /guaranteed \d+ LPA/gi,
        /guarantee \d+ LPA/gi,
        /will (definitely|surely) get \d+ LPA/gi,
        /certain to get \d+ LPA/gi,
        /guaranteed (salary|package)/gi,
      ],
      severity: 'critical',
      action: 'block',
    },
    {
      id: 'no-company-specific-promises',
      description: 'Prohibit company-specific placement promises',
      patterns: [
        /will definitely get (Google|Amazon|Microsoft|Meta|Apple|Netflix)/gi,
        /guaranteed (Google|Amazon|Microsoft|Meta|Apple|Netflix)/gi,
        /definitely (land|get into) (Google|Amazon|Microsoft|Meta|Apple|Netflix)/gi,
      ],
      severity: 'critical',
      action: 'block',
    },
    {
      id: 'no-personality-analysis',
      description: 'Prohibit personality analysis claims',
      patterns: [
        /personality (type|trait|analysis)/gi,
        /you (are|have) (a|an) (extrovert|introvert|ambivert)/gi,
        /personality (score|assessment|test)/gi,
      ],
      severity: 'critical',
      action: 'block',
    },
    {
      id: 'no-emotional-manipulation',
      description: 'Prohibit emotional manipulation',
      patterns: [
        /you (must|should) feel (proud|confident|excited)/gi,
        /don't worry about/gi,
        /everything will be (fine|great|perfect)/gi,
        /believe in yourself and you'll (succeed|get)/gi,
      ],
      severity: 'warning',
      action: 'filter',
    },
    {
      id: 'no-hallucinated-claims',
      description: 'Prohibit hallucinated engineering claims without evidence',
      patterns: [
        /you (are|have) (expert|master|guru) at/gi,
        /you (know|understand) (everything|all) about/gi,
        /you (are|have) the (best|top|greatest) at/gi,
      ],
      severity: 'warning',
      action: 'filter',
    },
    {
      id: 'no-fake-confidence',
      description: 'Prohibit fake confidence claims',
      patterns: [
        /100% (certain|sure|confident)/gi,
        /absolutely (certain|sure|confident)/gi,
        /completely (certain|sure|confident)/gi,
      ],
      severity: 'warning',
      action: 'filter',
    },
    {
      id: 'no-recruiter-summaries',
      description: 'Prohibit unsupported recruiter summaries',
      patterns: [
        /recruiters (will|definitely) (love|want)/gi,
        /recruiters (are|will be) (impressed|amazed)/gi,
        /stand out to recruiters/gi,
      ],
      severity: 'warning',
      action: 'filter',
    },
  ];

  /**
   * Check prompt for safety violations
   */
  checkPrompt(prompt: string): SafetyCheckResult {
    const violations: string[] = [];
    const warnings: string[] = [];
    
    for (const policy of this.policies) {
      for (const pattern of policy.patterns) {
        if (prompt.search(pattern) !== -1) {
          if (policy.severity === 'critical') {
            violations.push(`${policy.description}: Matched pattern "${pattern}"`);
          } else if (policy.severity === 'warning') {
            warnings.push(`${policy.description}: Matched pattern "${pattern}"`);
          }
        }
      }
    }
    
    const safe = violations.length === 0;
    
    if (!safe) {
      logger.warn('[PromptSafetyLayer] Prompt safety violation detected', { violations });
    }
    
    return {
      safe,
      violations,
      warnings,
    };
  }

  /**
   * Check AI response for safety violations
   */
  checkResponse(response: string): SafetyCheckResult {
    const violations: string[] = [];
    const warnings: string[] = [];
    let filteredContent = response;
    
    for (const policy of this.policies) {
      for (const pattern of policy.patterns) {
        if (response.search(pattern) !== -1) {
          if (policy.severity === 'critical') {
            violations.push(`${policy.description}: Matched pattern "${pattern}"`);
          } else if (policy.severity === 'warning') {
            warnings.push(`${policy.description}: Matched pattern "${pattern}"`);
            
            if (policy.action === 'filter') {
              filteredContent = filteredContent.replace(pattern, '[FILTERED]');
            }
          }
        }
      }
    }
    
    const safe = violations.length === 0;
    
    if (!safe) {
      logger.warn('[PromptSafetyLayer] Response safety violation detected', { violations });
    }
    
    if (warnings.length > 0) {
      logger.info('[PromptSafetyLayer] Response safety warnings', { warnings });
    }
    
    return {
      safe,
      violations,
      warnings,
      filteredContent: warnings.length > 0 ? filteredContent : undefined,
    };
  }

  /**
   * Sanitize prompt by removing unsafe content
   */
  sanitizePrompt(prompt: string): string {
    let sanitized = prompt;
    
    for (const policy of this.policies) {
      if (policy.action === 'filter' || policy.action === 'block') {
        for (const pattern of policy.patterns) {
          sanitized = sanitized.replace(pattern, '[FILTERED]');
        }
      }
    }
    
    return sanitized;
  }

  /**
   * Add safety guardrails to system prompt
   */
  addGuardrails(systemPrompt: string): string {
    let guardrails = `\n\nSTRICT SAFETY GUARDRAILS:\n`;
    guardrails += `- You MUST NOT make hiring, placement, or salary guarantees\n`;
    guardrails += `- You MUST NOT promise specific company placements\n`;
    guardrails += `- You MUST NOT analyze personality traits\n`;
    guardrails += `- You MUST NOT use emotional manipulation or motivational fluff\n`;
    guardrails += `- You MUST NOT make engineering claims without evidence\n`;
    guardrails += `- You MUST NOT express 100% certainty or absolute confidence\n`;
    guardrails += `- You MUST NOT make unsupported recruiter summaries\n`;
    guardrails += `- You MUST remain technical, factual, and evidence-aware\n`;
    guardrails += `- You MUST acknowledge uncertainty honestly\n`;
    guardrails += `- You MUST focus on engineering progression, not motivation\n`;
    
    return systemPrompt + guardrails;
  }

  /**
   * Check if content contains prohibited patterns
   */
  containsProhibitedPatterns(content: string): boolean {
    for (const policy of this.policies) {
      if (policy.severity === 'critical') {
        for (const pattern of policy.patterns) {
          if (pattern.test(content)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Get all safety policies
   */
  getPolicies(): SafetyPolicy[] {
    return this.policies;
  }

  /**
   * Add custom safety policy
   */
  addPolicy(policy: SafetyPolicy): void {
    this.policies.push(policy);
    logger.info('[PromptSafetyLayer] Custom safety policy added', { policyId: policy.id });
  }

  /**
   * Remove safety policy by ID
   */
  removePolicy(policyId: string): void {
    this.policies = this.policies.filter(p => p.id !== policyId);
    logger.info('[PromptSafetyLayer] Safety policy removed', { policyId });
  }

  /**
   * Clear all custom policies (reset to defaults)
   */
  resetPolicies(): void {
    this.policies = [
      {
        id: 'no-hiring-guarantees',
        description: 'Prohibit hiring/placement guarantees',
        patterns: [
          /will definitely get/gi,
          /guaranteed to get/gi,
          /guarantee you (will|get)/gi,
          /definitely (get|land|secure)/gi,
          /certain to (get|land|secure)/gi,
          /you will (definitely|surely|certainly) (get|land|secure)/gi,
        ],
        severity: 'critical',
        action: 'block',
      },
      {
        id: 'no-salary-guarantees',
        description: 'Prohibit salary guarantees',
        patterns: [
          /guaranteed \d+ LPA/gi,
          /guarantee \d+ LPA/gi,
          /will (definitely|surely) get \d+ LPA/gi,
          /certain to get \d+ LPA/gi,
          /guaranteed (salary|package)/gi,
        ],
        severity: 'critical',
        action: 'block',
      },
      {
        id: 'no-company-specific-promises',
        description: 'Prohibit company-specific placement promises',
        patterns: [
          /will definitely get (Google|Amazon|Microsoft|Meta|Apple|Netflix)/gi,
          /guaranteed (Google|Amazon|Microsoft|Meta|Apple|Netflix)/gi,
          /definitely (land|get into) (Google|Amazon|Microsoft|Meta|Apple|Netflix)/gi,
        ],
        severity: 'critical',
        action: 'block',
      },
      {
        id: 'no-personality-analysis',
        description: 'Prohibit personality analysis claims',
        patterns: [
          /personality (type|trait|analysis)/gi,
          /you (are|have) (a|an) (extrovert|introvert|ambivert)/gi,
          /personality (score|assessment|test)/gi,
        ],
        severity: 'critical',
        action: 'block',
      },
      {
        id: 'no-emotional-manipulation',
        description: 'Prohibit emotional manipulation',
        patterns: [
          /you (must|should) feel (proud|confident|excited)/gi,
          /don't worry about/gi,
          /everything will be (fine|great|perfect)/gi,
          /believe in yourself and you'll (succeed|get)/gi,
        ],
        severity: 'warning',
        action: 'filter',
      },
      {
        id: 'no-hallucinated-claims',
        description: 'Prohibit hallucinated engineering claims without evidence',
        patterns: [
          /you (are|have) (expert|master|guru) at/gi,
          /you (know|understand) (everything|all) about/gi,
          /you (are|have) the (best|top|greatest) at/gi,
        ],
        severity: 'warning',
        action: 'filter',
      },
      {
        id: 'no-fake-confidence',
        description: 'Prohibit fake confidence claims',
        patterns: [
          /100% (certain|sure|confident)/gi,
          /absolutely (certain|sure|confident)/gi,
          /completely (certain|sure|confident)/gi,
        ],
        severity: 'warning',
        action: 'filter',
      },
      {
        id: 'no-recruiter-summaries',
        description: 'Prohibit unsupported recruiter summaries',
        patterns: [
          /recruiters (will|definitely) (love|want)/gi,
          /recruiters (are|will be) (impressed|amazed)/gi,
          /stand out to recruiters/gi,
        ],
        severity: 'warning',
        action: 'filter',
      },
    ];
    
    logger.info('[PromptSafetyLayer] Policies reset to defaults');
  }
}

export const PromptSafetyLayer = new PromptSafetyLayerClass();
