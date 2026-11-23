import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import {
  zkpVerifierService,
  ZkpVerifierService,
  VERIFICATION_KEY_ID,
} from '../../../modules/readiness/zkpVerifier.service.js';
import { zkpRoutes } from '../../../modules/readiness/zkp.routes.js';

// Mock DB models
const findOneMock = vi.fn();
const findMock = vi.fn();
const createMock = vi.fn();
const findOneAndUpdateMock = vi.fn();

vi.mock('../../../db/models/verifiedClaimProof.model.js', () => ({
  VerifiedClaimProof: {
    create: (...args: any[]) => createMock(...args),
    findOne: (...args: any[]) => ({
      select: () => ({
        lean: () => ({
          exec: () => findOneMock(...args),
        }),
      }),
    }),
    findOneAndUpdate: (...args: any[]) => ({
      exec: () => findOneAndUpdateMock(...args),
    }),
  },
}));

vi.mock('../../../db/models/readinessCore.model.js', () => ({
  ReadinessCore: {
    findOne: (...args: any[]) => ({
      lean: () => ({
        exec: () => findOneMock(...args),
      }),
    }),
  },
}));

vi.mock('../../../db/models/dsaProfile.model.js', () => ({
  DSAProfile: {
    find: (...args: any[]) => ({
      lean: () => ({
        exec: () => findMock(...args),
      }),
    }),
  },
  DsaProfile: {
    find: (...args: any[]) => ({
      lean: () => ({
        exec: () => findMock(...args),
      }),
    }),
  },
}));

vi.mock('../../../db/models/platformStats.model.js', () => ({
  PlatformStats: {
    find: (...args: any[]) => ({
      lean: () => ({
        exec: () => findMock(...args),
      }),
    }),
  },
}));

// Mock auth middleware to inject test candidate
vi.mock('../../../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 'test-cand-user-id', clerkId: 'clerk_test_123', email: 'candidate@test.com' };
    next();
  },
}));

describe('ZkpVerifierService & ZKP HTTP Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Mathematical Zero-Knowledge Range Proof Generation & Verification', () => {
    it('generates a mathematically valid zero-knowledge range proof for readinessScore >= 800', async () => {
      const secretScore = 850;
      const threshold = 800;
      const claimType = 'readinessScore';
      const sessionNonce = 'test-session-nonce-12345';

      const generated = zkpVerifierService.createMathematicalRangeProof(
        secretScore,
        threshold,
        claimType,
        sessionNonce
      );

      expect(generated).toBeDefined();
      expect(generated.verificationKeyId).toBe(VERIFICATION_KEY_ID);
      expect(generated.proof).toBeDefined();
      expect(generated.proof.commitment).toBeDefined();
      expect(generated.proof.bitCommitments).toHaveLength(14);
      expect(generated.proof.announcements).toHaveLength(14);
      expect(generated.proof.responses).toHaveLength(14);

      expect(generated.publicSignals).toMatchObject({
        claimType: 'readinessScore',
        operator: '>=',
        threshold: 800,
        sessionNonce: 'test-session-nonce-12345',
        commitment: generated.proof.commitment,
      });

      // Verify the generated proof
      const result = await zkpVerifierService.verifyProof(generated);
      expect(result.valid).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.claim).toEqual({
        claimType: 'readinessScore',
        operator: '>=',
        threshold: 800,
        verified: true,
      });
      // Verifier must validate proof authenticity in < 150ms
      expect(result.verificationTimeMs).toBeLessThan(150);
    });

    it('generates a mathematically valid zero-knowledge range proof for problemsSolved >= 300', async () => {
      const secretSolved = 450;
      const threshold = 300;
      const claimType = 'problemsSolved';
      const sessionNonce = 'verifier-session-xyz-987';

      const generated = zkpVerifierService.createMathematicalRangeProof(
        secretSolved,
        threshold,
        claimType,
        sessionNonce
      );

      const result = await zkpVerifierService.verifyProof(generated);
      expect(result.valid).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.claim?.threshold).toBe(300);
      expect(result.verificationTimeMs).toBeLessThan(50);
    });

    it('handles exact boundary condition where secretValue === threshold', async () => {
      const generated = zkpVerifierService.createMathematicalRangeProof(
        800,
        800,
        'readinessScore',
        'boundary-nonce'
      );

      const result = await zkpVerifierService.verifyProof(generated);
      expect(result.valid).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.verificationTimeMs).toBeLessThan(50);
    });

    it('rejects generation when candidate metric is below requested threshold', () => {
      expect(() => {
        zkpVerifierService.createMathematicalRangeProof(
          750,
          800,
          'readinessScore',
          'nonce-fail'
        );
      }).toThrow(/Claim threshold not met/);
    });
  });

  describe('Cryptographic Tamper Resistance & Mathematical Certainty', () => {
    it('rejects with 100% mathematical certainty when the public threshold is tampered with', async () => {
      const generated = zkpVerifierService.createMathematicalRangeProof(
        850,
        800,
        'readinessScore',
        'tamper-test-nonce'
      );

      // Malicious actor tampers with threshold (claiming 900 instead of 800)
      const tampered = JSON.parse(JSON.stringify(generated));
      tampered.publicSignals.threshold = 900;

      const result = await zkpVerifierService.verifyProof(tampered);
      expect(result.valid).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/mismatch|failed/i);
    });

    it('rejects with 100% mathematical certainty when claimType is tampered with', async () => {
      const generated = zkpVerifierService.createMathematicalRangeProof(
        850,
        800,
        'readinessScore',
        'tamper-claim-nonce'
      );

      const tampered = JSON.parse(JSON.stringify(generated));
      tampered.publicSignals.claimType = 'problemsSolved';

      const result = await zkpVerifierService.verifyProof(tampered);
      expect(result.valid).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/challenge verification failed/i);
    });

    it('rejects with 100% mathematical certainty when sessionNonce is tampered (anti-replay)', async () => {
      const generated = zkpVerifierService.createMathematicalRangeProof(
        850,
        800,
        'readinessScore',
        'original-session-nonce'
      );

      const replayed = JSON.parse(JSON.stringify(generated));
      replayed.publicSignals.sessionNonce = 'stolen-replay-nonce-attacker';

      const result = await zkpVerifierService.verifyProof(replayed);
      expect(result.valid).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/challenge verification failed/i);
    });

    it('rejects when the commitment is tampered with', async () => {
      const generated = zkpVerifierService.createMathematicalRangeProof(
        850,
        800,
        'readinessScore',
        'tamper-commitment-nonce'
      );

      const tampered = JSON.parse(JSON.stringify(generated));
      tampered.proof.commitment = '123456789abcdef';

      const result = await zkpVerifierService.verifyProof(tampered);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Commitment mismatch/i);
    });

    it('rejects when cryptographic responses in proof are modified', async () => {
      const generated = zkpVerifierService.createMathematicalRangeProof(
        850,
        800,
        'readinessScore',
        'tamper-responses-nonce'
      );

      const tampered = JSON.parse(JSON.stringify(generated));
      tampered.proof.responses[0].s0 = 'badbeef12345';

      const result = await zkpVerifierService.verifyProof(tampered);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/verification failed/i);
    });

    it('rejects unsupported operators other than ">="', async () => {
      const generated = zkpVerifierService.createMathematicalRangeProof(
        850,
        800,
        'readinessScore',
        'operator-nonce'
      );

      const tampered = JSON.parse(JSON.stringify(generated));
      tampered.publicSignals.operator = '==';

      const result = await zkpVerifierService.verifyProof(tampered);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Unsupported operator/i);
    });

    it('rejects unrecognized verificationKeyId', async () => {
      const generated = zkpVerifierService.createMathematicalRangeProof(
        850,
        800,
        'readinessScore',
        'key-nonce'
      );

      const tampered = JSON.parse(JSON.stringify(generated));
      tampered.verificationKeyId = 'malicious-custom-zkp-key';

      const result = await zkpVerifierService.verifyProof(tampered);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Unrecognized verificationKeyId/i);
    });
  });

  describe('Candidate User Integration & Persistence', () => {
    it('queries readinessScore and generates persistent proof record for eligible candidate', async () => {
      findOneMock.mockReturnValue({ overallScore: 840 });
      createMock.mockResolvedValue({ proofId: 'zkp_123' });

      const proofObj = await zkpVerifierService.generateProofForUser('cand-user-1', {
        claimType: 'readinessScore',
        threshold: 800,
      });

      expect(proofObj).toBeDefined();
      expect(proofObj.proofId).toMatch(/^zkp_/);
      expect(proofObj.publicSignals.threshold).toBe(800);
      expect(createMock).toHaveBeenCalled();
    });

    it('throws error when candidate readinessScore in DB does not qualify', async () => {
      findOneMock.mockReturnValue({ overallScore: 710 });

      await expect(
        zkpVerifierService.generateProofForUser('cand-user-2', {
          claimType: 'readinessScore',
          threshold: 800,
        })
      ).rejects.toThrow(/Claim threshold not met/);
    });

    it('queries problemsSolved from DsaProfile for eligible candidate', async () => {
      findMock.mockReturnValue([{ totalSolved: 320, hardSolved: 45 }]);
      createMock.mockResolvedValue({ proofId: 'zkp_456' });

      const proofObj = await zkpVerifierService.generateProofForUser('cand-user-3', {
        claimType: 'problemsSolved',
        threshold: 300,
      });

      expect(proofObj).toBeDefined();
      expect(proofObj.publicSignals.threshold).toBe(300);
      expect(createMock).toHaveBeenCalled();
    });

    it('increments verification count when registered proof is verified', async () => {
      const generated = zkpVerifierService.createMathematicalRangeProof(
        900,
        800,
        'readinessScore',
        'registered-nonce-1'
      );

      findOneAndUpdateMock.mockResolvedValue({
        proofId: 'zkp_registered',
        verifiedCount: 1,
        lastVerifiedAt: new Date(),
      });

      const result = await zkpVerifierService.verifyProof({
        ...generated,
        proofId: 'zkp_registered',
      });

      expect(result.valid).toBe(true);
      expect(findOneAndUpdateMock).toHaveBeenCalledWith(
        { proofId: 'zkp_registered' },
        expect.objectContaining({
          $inc: { verifiedCount: 1 },
        }),
        expect.any(Object)
      );
    });

    it('supports continuous floating-point scores and verifies without throwing RangeError', async () => {
      findOneMock.mockReturnValue({ overallScore: 78.4 });
      createMock.mockResolvedValue({ proofId: 'zkp_float_123' });

      const proofObj = await zkpVerifierService.generateProofForUser('cand-float-user', {
        claimType: 'readinessScore',
        threshold: 75.2,
      });

      expect(proofObj).toBeDefined();
      expect(proofObj.publicSignals.threshold).toBe(75.2);

      const verification = await zkpVerifierService.verifyProof(proofObj);
      expect(verification.valid).toBe(true);
      expect(verification.verified).toBe(true);
      expect(verification.claim?.threshold).toBe(75.2);
    });

    it('allows generating multiple proofs with the same sessionNonce across different claim types', async () => {
      findOneMock.mockReturnValue({ overallScore: 88.0 });
      findMock.mockReturnValue([{ totalSolved: 420, hardSolved: 60 }]);
      createMock.mockResolvedValue({ proofId: 'zkp_multi_1' });

      const sharedSessionNonce = 'shared-session-nonce-xyz';

      // Proof 1: readinessScore
      const proof1 = await zkpVerifierService.generateProofForUser('user-session-shared', {
        claimType: 'readinessScore',
        threshold: 80,
        sessionNonce: sharedSessionNonce,
      });

      // Proof 2: problemsSolved
      const proof2 = await zkpVerifierService.generateProofForUser('user-session-shared', {
        claimType: 'problemsSolved',
        threshold: 300,
        sessionNonce: sharedSessionNonce,
      });

      expect(proof1.publicSignals.sessionNonce).toBe(sharedSessionNonce);
      expect(proof2.publicSignals.sessionNonce).toBe(sharedSessionNonce);
      expect(createMock).toHaveBeenCalledTimes(2);
      expect(createMock.mock.calls[0][0].sessionNonce).toBe(sharedSessionNonce);
      expect(createMock.mock.calls[0][0].claimType).toBe('readinessScore');
      expect(createMock.mock.calls[1][0].sessionNonce).toBe(sharedSessionNonce);
      expect(createMock.mock.calls[1][0].claimType).toBe('problemsSolved');
    });
  });

  describe('HTTP Endpoints (/api/v2/readiness/zkp)', () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v2/readiness/zkp', zkpRoutes);

    function createMockRes(onDone: () => void) {
      return {
        statusCode: 200,
        headers: {} as Record<string, any>,
        data: null as any,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        setHeader(name: string, value: any) {
          this.headers[name] = value;
          return this;
        },
        getHeader(name: string) {
          return this.headers[name];
        },
        json(payload: any) {
          this.data = payload;
          onDone();
          return this;
        },
        send(payload: any) {
          this.data = payload;
          onDone();
          return this;
        },
        end() {
          onDone();
          return this;
        },
      };
    }

    it('POST /generate creates a verifiable proof object for an authorized candidate', async () => {
      findOneMock.mockReturnValue({ overallScore: 880 });
      createMock.mockResolvedValue({ proofId: 'zkp_api_test' });

      const req = {
        method: 'POST',
        url: '/api/v2/readiness/zkp/generate',
        body: { claimType: 'readinessScore', threshold: 800 },
        headers: { 'content-type': 'application/json' },
      };

      await new Promise<void>((resolve) => {
        const res = createMockRes(resolve);
        (app as any).handle(req, res, () => resolve());
      });

      expect(findOneMock).toHaveBeenCalled();
    });

    it('POST /verify allows external verifier/recruiter to cryptographically verify a proof in < 50ms', async () => {
      const generated = zkpVerifierService.createMathematicalRangeProof(
        880,
        800,
        'readinessScore',
        'api-verify-nonce'
      );

      const req = {
        method: 'POST',
        url: '/api/v2/readiness/zkp/verify',
        body: generated,
        headers: { 'content-type': 'application/json' },
      };

      let resData: any;
      let resStatus = 200;
      await new Promise<void>((resolve) => {
        const res = createMockRes(resolve);
        (app as any).handle(req, res, () => resolve());
        // capture response
        res.json = (p: any) => {
          resData = p;
          resStatus = res.statusCode;
          resolve();
          return res;
        };
      });

      expect(resStatus).toBe(200);
      expect(resData.valid).toBe(true);
      expect(resData.verified).toBe(true);
      expect(resData.verificationTimeMs).toBeLessThan(50);
    });

    it('POST /verify rejects tampered public signals with valid: false', async () => {
      const generated = zkpVerifierService.createMathematicalRangeProof(
        880,
        800,
        'readinessScore',
        'api-tamper-nonce'
      );

      const tampered = JSON.parse(JSON.stringify(generated));
      tampered.publicSignals.threshold = 950;

      const req = {
        method: 'POST',
        url: '/api/v2/readiness/zkp/verify',
        body: tampered,
        headers: { 'content-type': 'application/json' },
      };

      let resData: any;
      let resStatus = 200;
      await new Promise<void>((resolve) => {
        const res = createMockRes(resolve);
        (app as any).handle(req, res, () => resolve());
        res.json = (p: any) => {
          resData = p;
          resStatus = res.statusCode;
          resolve();
          return res;
        };
      });

      expect(resStatus).toBe(200);
      expect(resData.valid).toBe(false);
      expect(resData.verified).toBe(false);
      expect(resData.error).toBeDefined();
    });
  });
});
