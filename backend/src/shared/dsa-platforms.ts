// Platforms accepted for manually tracked DSA problems (not sync providers).
export const DSA_PROBLEM_PLATFORMS = ['leetcode', 'codeforces', 'codechef', 'hackerrank', 'other'] as const;
export type DsaProblemPlatform = typeof DSA_PROBLEM_PLATFORMS[number];
