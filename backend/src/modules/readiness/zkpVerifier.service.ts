import crypto from 'node:crypto';
import {
  VerifiedClaimProof,
  type IVerifiedClaimProof,
  type IZkpProofPayload,
  type IZkpPublicSignals,
} from '../../db/models/verifiedClaimProof.model.js';
import { ReadinessCore } from '../../db/models/readinessCore.model.js';
import { DSAProfile } from '../../db/models/dsaProfile.model.js';
import { PlatformStats } from '../../db/models/platformStats.model.js';
import { logger } from '../../shared/logger.js';

export const VERIFICATION_KEY_ID = 'devtrack-zkp-v1-secp256k1';

// Cryptographic parameters: secp256k1 field prime
// p = 2^256 - 2^32 - 977
const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const ORDER = P - 1n; // Multiplicative group order of Z_p^*

// Standard generator g = 2
const G = 2n;

// Second generator h via Nothing-Up-My-Sleeve (NUMS) hash-to-field
const H_HASH = crypto.createHash('sha256').update('DevTrack-ZKP-Pedersen-NUMS-Generator-H-v1').digest('hex');
const H = BigInt('0x' + H_HASH) % P;

// Number of bits for the range proof excess: 2^14 = 16,384 covers all competitive thresholds & scores
const RANGE_BITS = 14;

export function mod(n: bigint, m: bigint): bigint {
  const res = n % m;
  return res >= 0n ? res : res + m;
}

export function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let res = 1n;
  base = mod(base, m);
  exp = mod(exp, m - 1n);
  while (exp > 0n) {
    if (exp % 2n === 1n) res = (res * base) % m;
    base = (base * base) % m;
    exp /= 2n;
  }
  return res;
}

export function modInv(n: bigint, m: bigint): bigint {
  let t = 0n;
  let newT = 1n;
  let r = m;
  let newR = mod(n, m);
  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  if (r > 1n) throw new Error(`Number ${n} is not invertible modulo ${m}`);
  return mod(t, m);
}

export function randomScalar(): bigint {
  const buf = crypto.randomBytes(32);
  return mod(BigInt('0x' + buf.toString('hex')), ORDER - 1n) + 1n;
}

export interface ZkpGenerateOptions {
  claimType: string;
  threshold: number;
  operator?: string;
  sessionNonce?: string;
  customMetricValue?: number;
}

export interface ZkpProofSubmission {
  proof: IZkpProofPayload;
  publicSignals: IZkpPublicSignals;
  verificationKeyId: string;
  proofId?: string;
}

export interface ZkpVerificationResult {
  valid: boolean;
  verified: boolean;
  claim?: {
    claimType: string;
    operator: string;
    threshold: number;
    verified: boolean;
  };
  verificationTimeMs: number;
  message?: string;
  error?: string;
  proofRecord?: IVerifiedClaimProof | null;
}

export class ZkpVerifierService {
  /**
   * Retrieves verified competitive statistics for the user without disclosing them publicly.
   */
  async getUserMetric(userId: string, claimType: string): Promise<number> {
    const normalizedType = claimType.toLowerCase().trim();

    if (normalizedType === 'readinessscore' || normalizedType === 'readiness') {
      try {
        const core = await ReadinessCore.findOne({ userId }).lean().exec();
        if (core && typeof core.overallScore === 'number') {
          return core.overallScore;
        }
      } catch (err) {
        logger.warn('Failed to query ReadinessCore for ZKP:', { error: err instanceof Error ? err.message : String(err) });
      }
      return 0;
    }

    if (normalizedType === 'problemssolved' || normalizedType === 'totalsolved') {
      try {
        const dsaProfiles = await DSAProfile.find({ userId }).lean().exec();
        if (dsaProfiles && dsaProfiles.length > 0) {
          const maxSolved = Math.max(...dsaProfiles.map((p: any) => p.totalSolved || 0));
          if (maxSolved > 0) return maxSolved;
        }

        const stats = await PlatformStats.find({ userId }).lean().exec();
        if (stats && stats.length > 0) {
          return stats.reduce((sum: number, s: any) => sum + (s.totalSolved || 0), 0);
        }
      } catch (err) {
        logger.warn('Failed to query solved problems for ZKP:', { error: err instanceof Error ? err.message : String(err) });
      }
      return 0;
    }

    if (normalizedType === 'hardproblemssolved' || normalizedType === 'hardsolved') {
      try {
        const dsaProfiles = await DSAProfile.find({ userId }).lean().exec();
        if (dsaProfiles && dsaProfiles.length > 0) {
          return dsaProfiles.reduce((sum: number, p: any) => sum + (p.hardSolved || 0), 0);
        }

        const stats = await PlatformStats.find({ userId }).lean().exec();
        if (stats && stats.length > 0) {
          return stats.reduce((sum: number, s: any) => sum + (s.hardSolved || 0), 0);
        }
      } catch (err) {
        logger.warn('Failed to query hard solved problems for ZKP:', { error: err instanceof Error ? err.message : String(err) });
      }
      return 0;
    }

    return 0;
  }

  /**
   * Generates a zero-knowledge range proof proving that secretValue >= threshold.
   */
  createMathematicalRangeProof(
    secretValue: number,
    threshold: number,
    claimType: string,
    sessionNonce: string
  ): { proof: IZkpProofPayload; publicSignals: IZkpPublicSignals; verificationKeyId: string } {
    if (secretValue < threshold) {
      throw new Error(
        `Claim threshold not met: candidate's verified ${claimType} (${secretValue}) is less than requested threshold (${threshold})`
      );
    }

    const intSecret = Math.round(secretValue);
    const intThreshold = Math.round(threshold);

    const delta = BigInt(intSecret - intThreshold);
    if (delta < 0n) {
      throw new Error(
        `Claim threshold not met: candidate's verified ${claimType} (${secretValue}) is less than requested threshold (${threshold})`
      );
    }
    if (delta >= (1n << BigInt(RANGE_BITS))) {
      throw new Error(`Excess value ${delta} exceeds maximum supported range limit (2^${RANGE_BITS})`);
    }

    // Binary bit decomposition of delta
    const bits: bigint[] = [];
    for (let j = 0; j < RANGE_BITS; j++) {
      bits.push((delta >> BigInt(j)) & 1n);
    }

    // Generate blinding factors r_j for each bit
    const rBits: bigint[] = [];
    let r = 0n;
    for (let j = 0; j < RANGE_BITS; j++) {
      const rj = randomScalar();
      rBits.push(rj);
      r = mod(r + rj * (1n << BigInt(j)), ORDER);
    }

    // Overall Pedersen commitment C = g^v * h^r mod p
    const C = (modPow(G, BigInt(intSecret), P) * modPow(H, r, P)) % P;

    // Bit commitments C_j = g^b_j * h^r_j mod p
    const cBits: bigint[] = [];
    for (let j = 0; j < RANGE_BITS; j++) {
      const cj = (modPow(G, bits[j], P) * modPow(H, rBits[j], P)) % P;
      cBits.push(cj);
    }

    // Chaum-Pedersen / CDS 1-out-of-2 Sigma Protocol for each bit b_j in {0, 1}
    const announcements: Array<{ a0: bigint; a1: bigint }> = [];
    const simulated: Array<{ k?: bigint; eSim: bigint; sSim: bigint; trueBranch: 0 | 1 }> = [];

    for (let j = 0; j < RANGE_BITS; j++) {
      const bj = bits[j];
      const cj = cBits[j];

      if (bj === 0n) {
        // Branch 0 is real
        const k0 = randomScalar();
        const a0 = modPow(H, k0, P);
        // Branch 1 is simulated
        const e1 = randomScalar();
        const s1 = randomScalar();
        const cjDivG = (cj * modInv(G, P)) % P;
        const a1 = (modPow(H, s1, P) * modInv(modPow(cjDivG, e1, P), P)) % P;

        announcements.push({ a0, a1 });
        simulated.push({ k: k0, eSim: e1, sSim: s1, trueBranch: 0 });
      } else {
        // Branch 0 is simulated
        const e0 = randomScalar();
        const s0 = randomScalar();
        const a0 = (modPow(H, s0, P) * modInv(modPow(cj, e0, P), P)) % P;
        // Branch 1 is real
        const k1 = randomScalar();
        const a1 = modPow(H, k1, P);

        announcements.push({ a0, a1 });
        simulated.push({ k: k1, eSim: e0, sSim: s0, trueBranch: 1 });
      }
    }

    // Fiat-Shamir master challenge derivation
    const hash = crypto.createHash('sha256');
    hash.update(VERIFICATION_KEY_ID);
    hash.update(claimType);
    hash.update('>=');
    hash.update(threshold.toString());
    hash.update(sessionNonce);
    hash.update(C.toString(16));
    for (const a of announcements) {
      hash.update(a.a0.toString(16));
      hash.update(a.a1.toString(16));
    }
    const masterChallenge = mod(BigInt('0x' + hash.digest('hex')), ORDER);

    // Compute responses
    const bitResponses: Array<{ e0: string; e1: string; s0: string; s1: string }> = [];
    for (let j = 0; j < RANGE_BITS; j++) {
      const sim = simulated[j];
      const rj = rBits[j];

      if (sim.trueBranch === 0) {
        const e0 = mod(masterChallenge - sim.eSim, ORDER);
        const s0 = mod(sim.k! + e0 * rj, ORDER);
        bitResponses.push({
          e0: e0.toString(16),
          e1: sim.eSim.toString(16),
          s0: s0.toString(16),
          s1: sim.sSim.toString(16),
        });
      } else {
        const e1 = mod(masterChallenge - sim.eSim, ORDER);
        const s1 = mod(sim.k! + e1 * rj, ORDER);
        bitResponses.push({
          e0: sim.eSim.toString(16),
          e1: e1.toString(16),
          s0: sim.sSim.toString(16),
          s1: s1.toString(16),
        });
      }
    }

    const proofPayload: IZkpProofPayload = {
      commitment: C.toString(16),
      bitCommitments: cBits.map((b) => b.toString(16)),
      announcements: announcements.map((a) => ({
        a0: a.a0.toString(16),
        a1: a.a1.toString(16),
      })),
      responses: bitResponses,
    };

    const publicSignals: IZkpPublicSignals = {
      claimType,
      operator: '>=',
      threshold,
      sessionNonce,
      issuedAt: new Date().toISOString(),
      commitment: C.toString(16),
    };

    return {
      proof: proofPayload,
      publicSignals,
      verificationKeyId: VERIFICATION_KEY_ID,
    };
  }

  /**
   * Generates and registers an anonymous verified range proof for a candidate.
   */
  async generateProofForUser(
    userId: string,
    options: ZkpGenerateOptions
  ): Promise<{
    proofId: string;
    proof: IZkpProofPayload;
    publicSignals: IZkpPublicSignals;
    verificationKeyId: string;
  }> {
    const { claimType, threshold, operator = '>=' } = options;

    if (operator !== '>=') {
      throw new Error(`Operator '${operator}' is not supported. Only '>=' is supported for range proofs.`);
    }

    if (typeof threshold !== 'number' || isNaN(threshold) || threshold < 0) {
      throw new Error('Threshold must be a valid non-negative number.');
    }

    // Session nonce: prevents replay attacks across candidates and verification sessions
    const sessionNonce = options.sessionNonce?.trim() || crypto.randomBytes(16).toString('hex');

    // Retrieve verified metric value
    const verifiedValue =
      options.customMetricValue !== undefined
        ? options.customMetricValue
        : await this.getUserMetric(userId, claimType);

    if (verifiedValue < threshold) {
      throw new Error(
        `Claim threshold not met: candidate's verified ${claimType} (${verifiedValue}) is below requested threshold (${threshold}).`
      );
    }

    const { proof, publicSignals, verificationKeyId } = this.createMathematicalRangeProof(
      verifiedValue,
      threshold,
      claimType,
      sessionNonce
    );

    const proofId = `zkp_${crypto.randomBytes(16).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30-day proof validity

    try {
      await VerifiedClaimProof.create({
        proofId,
        userId,
        claimType,
        operator,
        threshold,
        commitment: proof.commitment,
        sessionNonce,
        verificationKeyId,
        proof,
        publicSignals,
        verifiedCount: 0,
        lastVerifiedAt: null,
        expiresAt,
        status: 'active',
      });
    } catch (dbErr) {
      logger.warn('Could not persist verifiedClaimProof record to database:', { error: dbErr instanceof Error ? dbErr.message : String(dbErr) });
    }

    return {
      proofId,
      proof,
      publicSignals,
      verificationKeyId,
    };
  }

  /**
   * Cryptographically verifies a submitted zero-knowledge proof in < 50ms without learning candidate identity.
   */
  async verifyProof(submission: ZkpProofSubmission): Promise<ZkpVerificationResult> {
    const startTime = performance.now();

    try {
      const { proof, publicSignals, verificationKeyId, proofId } = submission;

      if (!proof || !publicSignals) {
        return {
          valid: false,
          verified: false,
          verificationTimeMs: performance.now() - startTime,
          error: 'Missing required proof or publicSignals in submission.',
        };
      }

      if (verificationKeyId !== VERIFICATION_KEY_ID) {
        return {
          valid: false,
          verified: false,
          verificationTimeMs: performance.now() - startTime,
          error: `Unrecognized verificationKeyId '${verificationKeyId}'. Expected '${VERIFICATION_KEY_ID}'.`,
        };
      }

      if (publicSignals.operator !== '>=') {
        return {
          valid: false,
          verified: false,
          verificationTimeMs: performance.now() - startTime,
          error: `Unsupported operator '${publicSignals.operator}'. Expected '>='.`,
        };
      }

      const thresholdNum = Number(publicSignals.threshold);
      if (isNaN(thresholdNum) || thresholdNum < 0) {
        return {
          valid: false,
          verified: false,
          verificationTimeMs: performance.now() - startTime,
          error: 'Invalid negative threshold in publicSignals.',
        };
      }

      const threshold = BigInt(Math.round(thresholdNum));

      const C = BigInt('0x' + proof.commitment);
      const publicC = BigInt('0x' + publicSignals.commitment);
      if (C !== publicC) {
        return {
          valid: false,
          verified: false,
          verificationTimeMs: performance.now() - startTime,
          error: 'Commitment mismatch between proof and publicSignals.',
        };
      }

      const bitCommitments = proof.bitCommitments.map((s) => BigInt('0x' + s));
      const announcements = proof.announcements.map((a) => ({
        a0: BigInt('0x' + a.a0),
        a1: BigInt('0x' + a.a1),
      }));
      const responses = proof.responses.map((r) => ({
        e0: BigInt('0x' + r.e0),
        e1: BigInt('0x' + r.e1),
        s0: BigInt('0x' + r.s0),
        s1: BigInt('0x' + r.s1),
      }));

      const bitsCount = bitCommitments.length;
      if (bitsCount !== RANGE_BITS || announcements.length !== RANGE_BITS || responses.length !== RANGE_BITS) {
        return {
          valid: false,
          verified: false,
          verificationTimeMs: performance.now() - startTime,
          error: `Invalid range proof structure: expected ${RANGE_BITS} bits, received ${bitsCount}.`,
        };
      }

      // Step 1: Recompute shifted commitment C' = C * g^(-T) mod p
      const gInvT = modInv(modPow(G, threshold, P), P);
      const expectedCPrime = (C * gInvT) % P;

      // Step 2: Check homomorphic bit product prod(C_j^(2^j)) == C' mod p
      let actualCPrime = 1n;
      for (let j = 0; j < bitsCount; j++) {
        const weight = 1n << BigInt(j);
        actualCPrime = (actualCPrime * modPow(bitCommitments[j], weight, P)) % P;
      }

      if (actualCPrime !== expectedCPrime) {
        return {
          valid: false,
          verified: false,
          verificationTimeMs: performance.now() - startTime,
          error: 'Cryptographic proof verification failed: homomorphic range commitment mismatch.',
        };
      }

      // Step 3: Recompute Fiat-Shamir master challenge
      const vHash = crypto.createHash('sha256');
      vHash.update(verificationKeyId);
      vHash.update(publicSignals.claimType);
      vHash.update(publicSignals.operator);
      vHash.update(publicSignals.threshold.toString());
      vHash.update(publicSignals.sessionNonce);
      vHash.update(C.toString(16));
      for (const a of announcements) {
        vHash.update(a.a0.toString(16));
        vHash.update(a.a1.toString(16));
      }
      const masterChallenge = mod(BigInt('0x' + vHash.digest('hex')), ORDER);

      // Step 4: Verify each bit 1-out-of-2 proof
      for (let j = 0; j < bitsCount; j++) {
        const resp = responses[j];
        const a = announcements[j];
        const cj = bitCommitments[j];

        // e0 + e1 == c mod ORDER
        if (mod(resp.e0 + resp.e1, ORDER) !== masterChallenge) {
          return {
            valid: false,
            verified: false,
            verificationTimeMs: performance.now() - startTime,
            error: `Cryptographic challenge verification failed at bit ${j}.`,
          };
        }

        // Branch 0 verification: h^s0 == a0 * C_j^e0 mod p
        const lhs0 = modPow(H, resp.s0, P);
        const rhs0 = (a.a0 * modPow(cj, resp.e0, P)) % P;
        if (lhs0 !== rhs0) {
          return {
            valid: false,
            verified: false,
            verificationTimeMs: performance.now() - startTime,
            error: `Bit statement verification failed on branch 0 at bit ${j}.`,
          };
        }

        // Branch 1 verification: h^s1 == a1 * (C_j / g)^e1 mod p
        const lhs1 = modPow(H, resp.s1, P);
        const cjDivG = (cj * modInv(G, P)) % P;
        const rhs1 = (a.a1 * modPow(cjDivG, resp.e1, P)) % P;
        if (lhs1 !== rhs1) {
          return {
            valid: false,
            verified: false,
            verificationTimeMs: performance.now() - startTime,
            error: `Bit statement verification failed on branch 1 at bit ${j}.`,
          };
        }
      }

      // Step 5: Update persistence record if registered
      let record: IVerifiedClaimProof | null = null;
      try {
        const query: Record<string, unknown> = {};
        if (proofId) query.proofId = proofId;
        else if (publicSignals.sessionNonce) query.sessionNonce = publicSignals.sessionNonce;

        if (Object.keys(query).length > 0) {
          record = await VerifiedClaimProof.findOneAndUpdate(
            query,
            {
              $inc: { verifiedCount: 1 },
              $set: { lastVerifiedAt: new Date() },
            },
            { new: true }
          ).exec();
        }
      } catch (dbErr) {
        logger.warn('Could not update verified claim record:', { error: dbErr instanceof Error ? dbErr.message : String(dbErr) });
      }

      const elapsedMs = Math.round((performance.now() - startTime) * 100) / 100;

      return {
        valid: true,
        verified: true,
        claim: {
          claimType: publicSignals.claimType,
          operator: publicSignals.operator,
          threshold: publicSignals.threshold,
          verified: true,
        },
        verificationTimeMs: elapsedMs,
        message:
          'Cryptographic zero-knowledge range proof verified successfully. Statement holds true without revealing private metrics or candidate identity.',
        proofRecord: record,
      };
    } catch (err: any) {
      return {
        valid: false,
        verified: false,
        verificationTimeMs: performance.now() - startTime,
        error: `Proof verification execution error: ${err.message}`,
      };
    }
  }
}

export const zkpVerifierService = new ZkpVerifierService();
