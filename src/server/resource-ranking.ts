import type { Resource } from '../../types/domain.ts';

export function rankResources(resources: Resource[]): Resource[] {
  const seen = new Set<string>();
  const candidates = resources.filter((resource) => {
    const identity = JSON.stringify([resource.contentType, resource.contentId]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    try {
      const url = new URL(resource.url);
      if (url.protocol !== 'https:' || url.username || url.password ||
          !(url.hostname === 'zhihu.com' || url.hostname.endsWith('.zhihu.com'))) return false;
    } catch { return false; }
    return !/(?:广告|推广|书单|资源汇总|资料合集)/u.test(resource.title);
  });
  const ranking = candidates.map((r, i) =>
    Number.isFinite(r.rankingScore) ? r.rankingScore! : candidates.length - i);
  const engagement = candidates.map((r) =>
    Math.log1p(Math.max(0, r.voteUpCount)) + 0.5 * Math.log1p(Math.max(0, r.commentCount)));
  const normalize = (values: number[]) => {
    const min = Math.min(...values);
    const max = Math.max(...values);
    return values.map((v) => max === min ? 1 : (v - min) / (max - min));
  };
  const relevance = normalize(ranking);
  const interaction = normalize(engagement);
  return candidates.map((r, i) => ({
    ...r, score: 0.6 * relevance[i] + 0.4 * interaction[i],
  })).sort((a, b) => b.score - a.score).slice(0, 3);
}
