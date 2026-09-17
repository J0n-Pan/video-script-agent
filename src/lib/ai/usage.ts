import { prisma } from '../db';
import { cfg } from '../config';
import type { Usage } from './types';

export type Capability = 'ASR' | 'VISION' | 'ORGANIZE';

/** 按 11.4 节口径估算单次调用费用；保留计算依据，历史价格不被新配置覆盖 */
export function estimateCost(capability: Capability, usage: Usage): { cost: number | null; basis: string } {
  const p = cfg.pricing;
  if (usage.usageMissing) {
    return { cost: null, basis: '供应商未返回用量 → 费用待核对（不计为零成本）' };
  }
  if (capability === 'ASR') {
    const sec = usage.audioSeconds ?? 0;
    return { cost: sec * p.asrPerSecond, basis: `${sec}s × ${p.asrPerSecond}元/秒（转写输出不另计费）` };
  }
  if (capability === 'VISION') {
    const i = usage.inputTokens ?? 0;
    const o = usage.outputTokens ?? 0;
    // 输入越长单价越高：按单次请求的输入 tokens 落入的档位取价，避免长输入被低估
    const tier = p.visionTiers.find((t) => i <= t.maxInputTokens) ?? p.visionTiers[p.visionTiers.length - 1];
    return {
      cost: (i * tier.inputPerMillion) / 1_000_000 + (o * tier.outputPerMillion) / 1_000_000,
      basis: `输入${i}×${tier.inputPerMillion}/百万 + 输出${o}×${tier.outputPerMillion}/百万（档位 ≤${tier.maxInputTokens} 输入tokens）`,
    };
  }
  const i = usage.inputTokens ?? 0;
  const o = usage.outputTokens ?? 0;
  return {
    cost: (i * p.organizeInputPerMillion) / 1_000_000 + (o * p.organizeOutputPerMillion) / 1_000_000,
    basis: `输入${i}×${p.organizeInputPerMillion}/百万 + 输出${o}×${p.organizeOutputPerMillion}/百万`,
  };
}

/**
 * 记录每次模型调用（PRD 11.5）：任务、执行尝试、能力类型、地域、模型及版本、
 * 起止时间、状态、音频秒数、输入输出及思考 Token、重试序号、币种、单价版本、估算费用、供应商请求号。
 * 失败调用也可能计费，因此同样落库。
 */
export async function recordUsage(params: {
  attemptId: string;
  capability: Capability;
  modelId: string;
  usage: Usage;
  status: 'SUCCEEDED' | 'FAILED';
  retryIndex: number;
  startedAt: Date;
  finishedAt: Date;
  errorMessage?: string;
}) {
  const { cost, basis } = estimateCost(params.capability, params.usage);
  const count = await prisma.modelUsage.count({ where: { attemptId: params.attemptId } });
  await prisma.modelUsage.create({
    data: {
      attemptId: params.attemptId,
      callNo: count + 1,
      capability: params.capability,
      vendor: cfg.aiMode === 'mock' ? 'mock' : 'aliyun-bailian',
      region: cfg.dashscope.region,
      modelId: params.modelId,
      modelVersion: null,
      status: params.status,
      audioSeconds: params.usage.audioSeconds ?? null,
      inputTokens: params.usage.inputTokens ?? null,
      outputTokens: params.usage.outputTokens ?? null,
      thinkingTokens: params.usage.thinkingTokens ?? null,
      retryIndex: params.retryIndex,
      currency: 'CNY',
      priceVersion: cfg.pricing.priceVersion,
      estimatedCost: cost,
      usageMissing: Boolean(params.usage.usageMissing),
      vendorRequestId: params.usage.vendorRequestId ?? null,
      startedAt: params.startedAt,
      finishedAt: params.finishedAt,
      errorMessage: params.errorMessage ? `${params.errorMessage}｜计价依据：${basis}` : `计价依据：${basis}`,
    },
  });
}

export function summarize(rows: Array<{ estimatedCost: number | null; usageMissing: boolean; capability: string }>) {
  const total = rows.reduce((s, r) => s + (r.estimatedCost ?? 0), 0);
  const pending = rows.filter((r) => r.usageMissing || r.estimatedCost === null).length;
  return { total: Number(total.toFixed(4)), pending };
}
