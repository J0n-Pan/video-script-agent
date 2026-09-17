// 阿里云百炼适配器（PRD 10.5 已确认三模型）。
// 说明：本文件的实现按官方文档的接口形态编写，尚未用真实素材与真实凭证做端到端验证（PRD 14.1 待验证项）。
// 供应商上传、异步轮询、错误码与原始返回结构全部收敛在此处，业务层只消费统一结构。

import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../../config';
import { MISSING, TAG, TAG_ORDER, normalizeTag, unclearAt } from '../../constants';
import type {
  AudioRecognitionAdapter,
  AudioRecognitionInput,
  AudioRecognitionOutput,
  AudioUtterance,
  OrganizeAdapter,
  OrganizeInput,
  OrganizeOutput,
  OrganizeSegmentInput,
  VisionAdapter,
  VisionFrameResult,
  VisionInput,
  VisionOutput,
} from '../types';

/** 服务地址由 DASHSCOPE_REGION 决定：beijing=中国站，singapore=国际站 */
function host(): string {
  return cfg.dashscope.host;
}

function apiKey(): string {
  const k = cfg.dashscope.apiKey;
  if (!k) {
    throw new Error('未配置 DASHSCOPE_API_KEY：无法调用真实模型。请在 .env 中填写，或将 AI_MODE 设为 mock。');
  }
  return k;
}

/** 密钥/区域不匹配时给出的可操作提示，避免只看到「InvalidApiKey」无从下手 */
function hintRegionMismatch(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/InvalidApiKey|invalid_api_key|Model\.NotExist|model not exist|Access denied|Unauthorized/i.test(msg)) {
    return new Error(
      `${msg}\n排查建议：当前 DASHSCOPE_REGION=${cfg.dashscope.region}（${cfg.dashscope.host}）。` +
        '请确认 ①密钥与该区域一致（中国站/新加坡站密钥不通用）；' +
        `②业务空间中已开通 ${cfg.dashscope.asrModel} / ${cfg.dashscope.visionModel} / ${cfg.dashscope.organizeModel} 的调用权限。`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

async function jsonFetch(url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Error(`无法连接百炼服务（${cfg.dashscope.host}）：${(e as Error).message}`);
  }
  const text = await res.text();
  let body: any = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const msg = body?.message ?? body?.error?.message ?? body?.raw ?? res.statusText;
    const code = body?.code ?? body?.error?.code ?? res.status;
    throw hintRegionMismatch(new Error(`百炼接口失败 [${code}] ${msg}`));
  }
  return body;
}

/**
 * 上传本地音频，取得供应商可读取的临时地址。
 * 本机绝对路径与 localhost 不能作为外部服务可读取的音频地址（PRD 10.5）；
 * 不使用普通聊天兼容接口替代专用录音文件接口。
 */
async function uploadAudioTemporary(filePath: string): Promise<string> {
  const policy = await jsonFetch(`${host()}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(cfg.dashscope.asrModel)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey()}` },
  });

  // 真实返回结构（2026-09 实测）：
  // data.policy / data.signature / data.upload_dir / data.upload_host /
  // data.oss_access_key_id / data.x_oss_object_acl / data.x_oss_forbid_overwrite
  const d = policy?.data ?? {};
  const accessKeyId = d.oss_access_key_id ?? d.ossAccessKeyId;
  const policyDoc = d.policy;
  const signature = d.signature;
  const uploadDir = d.upload_dir ?? d.uploadDir ?? '';
  const uploadHost = d.upload_host ?? d.uploadHost;

  if (!accessKeyId || !policyDoc || !signature) {
    throw new Error(
      '上传凭证缺少必需字段（oss_access_key_id / policy / signature），' +
        `实际返回字段：${Object.keys(d).join(', ') || '(空)'}`,
    );
  }
  if (!uploadHost) throw new Error('上传凭证返回缺少 upload_host，无法上传音频');

  const name = path.basename(filePath);
  // policy 的 conditions 用 starts-with 约束了 upload_dir 前缀，因此 key 必须带文件名
  const key = `${uploadDir.replace(/\/$/, '')}/${name}`;

  const form = new globalThis.FormData();
  form.append('OSSAccessKeyId', String(accessKeyId));
  form.append('policy', String(policyDoc));
  form.append('Signature', String(signature));
  form.append('key', key);
  // 这两项是 policy 里声明的 conditions，缺失会被 OSS 拒绝（403/400）
  form.append('x-oss-object-acl', String(d.x_oss_object_acl ?? 'private'));
  if (d.x_oss_forbid_overwrite !== undefined) {
    form.append('x-oss-forbid-overwrite', String(d.x_oss_forbid_overwrite));
  }
  form.append('success_action_status', '200');

  const buf = fs.readFileSync(filePath);
  form.append('file', new Blob([new Uint8Array(buf)]), name);

  const res = await fetch(uploadHost, { method: 'POST', body: form });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `音频上传失败：HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`,
    );
  }

  return `oss://${key}`;
}

/** 音频识别：qwen3-asr-flash-filetrans 录音文件异步接口，句/词级时间戳统一为毫秒 */
export class DashscopeAudioAdapter implements AudioRecognitionAdapter {
  readonly modelId = cfg.dashscope.asrModel;

  async recognize(input: AudioRecognitionInput): Promise<AudioRecognitionOutput> {
    if (!input.hasAudio) {
      return {
        utterances: [],
        hasSpeech: false,
        issues: [{ code: 'NO_SPEECH', message: '视频无音轨，文案与旁白填“无”', severity: 'info' }],
        usage: {},
      };
    }
    const fileUrl = await uploadAudioTemporary(input.audioPath);
    const submit = await jsonFetch(`${host()}/api/v1/services/audio/asr/transcription`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
      body: JSON.stringify({
        model: cfg.dashscope.asrModel,
        input: { file_urls: [fileUrl] },
        parameters: { channel_id: [0], enable_words: true, language: 'zh' },
      }),
    });
    const taskId = submit?.output?.task_id;
    if (!taskId) throw new Error('录音文件接口未返回 task_id');

    // 异步轮询：有限等待，不无限等待（PRD 8 实现约定）
    const deadline = Date.now() + cfg.stageTimeoutMs;
    let payload: any = null;
    while (Date.now() < deadline) {
      await sleep(2000);
      const poll = await jsonFetch(`${host()}/api/v1/tasks/${taskId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey()}` },
      });
      const st = poll?.output?.task_status;
      if (st === 'SUCCEEDED') {
        payload = poll.output;
        break;
      }
      if (st === 'FAILED') {
        throw new Error(`录音文件识别失败：${poll?.output?.message ?? '未知原因'}`);
      }
    }
    if (!payload) throw new Error('录音文件识别超时');

    const results: any[] = payload.results ?? [];
    const utterances: AudioUtterance[] = [];
    const issues: AudioRecognitionOutput['issues'] = [];
    let idx = 0;
    for (const r of results) {
      if (r?.subtask_status && r.subtask_status !== 'SUCCEEDED') {
        issues.push({ code: 'ASR_SUBTASK_FAILED', message: `子任务失败：${r?.message ?? ''}`, severity: 'error' });
        continue;
      }
      const transcriptionUrl = r?.transcription_url;
      if (!transcriptionUrl) continue;
      const tj = await jsonFetch(transcriptionUrl, { method: 'GET' });
      const list: any[] = tj?.transcripts ?? [];
      for (const t of list) {
        const sentences: any[] = t?.sentences ?? [];
        if (sentences.length === 0 && t?.text) {
          utterances.push({ id: `u${++idx}`, text: String(t.text), startMs: 0, endMs: input.durationMs });
        }
        for (const s of sentences) {
          utterances.push({
            id: `u${++idx}`,
            text: String(s.text ?? ''),
            startMs: Math.round(Number(s.begin_time ?? 0)),
            endMs: Math.round(Number(s.end_time ?? 0)),
          });
        }
      }
    }
    return {
      utterances,
      hasSpeech: utterances.length > 0,
      issues,
      usage: { audioSeconds: input.durationMs / 1000, vendorRequestId: taskId },
    };
  }
}

/** 画面理解：qwen3-vl-plus，输入程序提取的真实取样画面与时间 */
export class DashscopeVisionAdapter implements VisionAdapter {
  readonly modelId = cfg.dashscope.visionModel;

  async analyze(input: VisionInput): Promise<VisionOutput> {
    const content: any[] = [
      {
        type: 'text',
        text: [
          '你是短视频脚本还原的辅助模块。输入是按时间顺序排列的原视频真实取样画面。',
          '请只描述画面中可观察的事实，不得推断人物心理、人格或未表达的意图。',
          '',
          '严格按下面的 JSON 结构输出，**键名必须完全一致**，不要增删键、不要改键名、不要输出多余文本：',
          '{',
          '  "frames": [',
          '    { "timeMs": 1234, "makeup": "服装颜色款式/发型/配饰/明显妆容", "scene": "室内外、背景物品、人物位置",',
          '      "emotion": "仅可观察的表情/语气/语速线索", "isAiGenerated": true, "uncertain": false, "notes": "" }',
          '  ],',
          '  "form": {',
          '    "mixedCut": false, "mixedCutEvidence": "",',
          '    "aiIntervals": [{ "startMs": 0, "endMs": 0 }],',
          '    "aiRatioEstimated": true, "uncertain": false, "evidence": ""',
          '  }',
          '}',
          '',
          '判定口径（必须遵守）：',
          `- 妆造看不出时写“${MISSING.UNRECOGNIZABLE}”，不要留空字符串。`,
          '- isAiGenerated 只在该帧**画面本身由 AI 生成**时为 true；真人实拍即使有字幕、贴纸、分屏排版、商品特写叠加，也必须为 false。',
          '- 只有确实无法判断该帧是否为 AI 画面时才置 null，并把该帧 uncertain 置 true。',
          '- 若整段素材都是真实拍摄、不存在 AI 画面，aiIntervals 输出空数组，且 aiRatioEstimated 必须为 true —— 这是明确结论，不是“无法估计”。',
          '- 仅在确实无法判断区间时才把 aiRatioEstimated 置 false 且 uncertain 置 true，不要编造精确比例。',
          '- mixedCut 仅在“无连贯主体、由多个独立素材拼接”时为 true；同一场景内的分屏/画中画属排版，不是混剪。',
        ].join('\n'),
      },
    ];
    for (const f of input.frames) {
      const b64 = fs.readFileSync(f.path).toString('base64');
      content.push({ type: 'text', text: `取样时间 ${f.timeMs}ms` });
      content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } });
    }

    const body = await jsonFetch(`${host()}/compatible-mode/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.dashscope.visionModel,
        messages: [{ role: 'user', content }],
        response_format: { type: 'json_object' },
        // PRD 10.5 要求非思考模式：Qwen3.8 等新系列默认可能开启思考，
        // 实测思考会显著推高输出 tokens（9 帧从 843 → 8500）与耗时，必须显式关闭。
        enable_thinking: false,
      }),
    });
    const txt: string = body?.choices?.[0]?.message?.content ?? '{}';
    const parsed = safeJson(txt);
    dumpRaw('vision', { model: cfg.dashscope.visionModel, content: txt, parsed, usage: body?.usage });
    /** 不同模型族返回的字段名不一致：Qwen3-VL 用 frames/timeMs/妆造，Qwen3.8 用 frame_details/time/is_ai_generated；
     *  另有模型直接返回顶层数组。三者都要兼容，否则会静默得到 0 帧。 */
    const rawFrames: any[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.frames)
        ? parsed.frames
        : Array.isArray(parsed?.frame_details)
          ? parsed.frame_details
          : Array.isArray(parsed?.frameDetails)
            ? parsed.frameDetails
            : [];
    const frames: VisionFrameResult[] = rawFrames.map((r: any) => ({
      timeMs: Number(r.timeMs ?? r.time_ms ?? r.time ?? r.timestamp ?? 0),
      makeup: String(r.makeup ?? r['妆造'] ?? MISSING.UNRECOGNIZABLE),
      scene: String(r.scene ?? r['场景'] ?? MISSING.UNRECOGNIZABLE),
      emotion: String(r.emotion ?? r['情绪'] ?? MISSING.PENDING_REVIEW),
      // 实测真实返回用过 isAIGenerated（大写 AI），只认 isAiGenerated 会静默判成「不确定」
      isAiGenerated: pickBool(r.isAiGenerated, r.isAIGenerated, r.is_ai_generated, r['是否为AI生成画面']),
      uncertain: r.uncertain === true,
      notes: r.notes ? String(r.notes) : undefined,
    }));

    /**
     * 形式建议的字段名以真实返回为准做兼容：
     * 实测 qwen3-vl-plus 会返回 videoFormSuggestion/{isMontage,aiGeneratedIntervals}，
     * 与提示词约定的 form/{mixedCut,aiIntervals} 不同。只认一种会**静默**退化为「待复核」，
     * 因此这里同时接受两套命名，并在都取不到时显式报出 warning。
     */
    const fsug: any = parsed?.form ?? parsed?.formSuggestion ?? parsed?.videoFormSuggestion ?? {};
    const formKeyFound = Boolean(parsed?.form ?? parsed?.formSuggestion ?? parsed?.videoFormSuggestion);
    const rawIntervals: any[] = Array.isArray(fsug.aiIntervals)
      ? fsug.aiIntervals
      : Array.isArray(fsug.aiGeneratedIntervals)
        ? fsug.aiGeneratedIntervals
        : [];
    const ratioFlag = pickBool(fsug.aiRatioEstimated);
    const formEvidence = firstString(fsug.evidence, fsug.mixedCutEvidence, fsug.montageEvidence);

    return {
      frames,
      formSuggestion: {
        mixedCut: pickBool(fsug.mixedCut, fsug.isMontage, fsug.isMixedCut) === true,
        mixedCutEvidence: firstString(fsug.mixedCutEvidence, fsug.montageEvidence),
        aiIntervals: rawIntervals
          .map((i: any) => ({
            startMs: Number(i.startMs ?? i.start_ms ?? 0),
            endMs: Number(i.endMs ?? i.end_ms ?? 0),
          }))
          .filter((i: any) => Number.isFinite(i.startMs) && Number.isFinite(i.endMs) && i.endMs > i.startMs),
        // 缺省为 true（沿用原语义）；显式 false 才算「无法估计」
        aiRatioEstimated: ratioFlag === undefined ? true : ratioFlag,
        uncertain: fsug.uncertain === true || frames.some((f) => f.uncertain),
        evidence: formEvidence ?? '',
      },
      issues: [
        ...(frames.length === 0
          ? [
              {
                code: 'VISION_EMPTY',
                message:
                  '画面理解未返回任何帧结果：当前模型未按约定的 JSON 契约输出（实测 qwen3.8 系列在非思考模式下会返回空数组）。' +
                  '本视频的妆造/场景/情绪将标记为无法辨认，形式判断转人工复核。',
                severity: 'error' as const,
              },
            ]
          : []),
        // 键名全不匹配时必须显式告警：此前这种情况会「静默」退化成待复核，
        // 表面上流程照常结束，实际上形式判定整段丢失（PRD 8 实现约定：不得静默降级）。
        ...(formKeyFound
          ? []
          : [
              {
                code: 'VISION_FORM_CONTRACT_MISSING',
                message:
                  '画面理解未返回形式建议字段（form / formSuggestion / videoFormSuggestion 均不存在）：' +
                  `实际顶层键为 [${Object.keys(parsed ?? {}).join(', ') || '(空)'}]。` +
                  '形式判定已降级为「待复核」，请核对模型返回结构与适配器字段映射。',
                severity: 'warn' as const,
              },
            ]),
      ],
      usage: { ...readUsage(body?.usage), vendorRequestId: requestIdOf(body) },
    };
  }
}

/** 脚本整理：qwen3.8-flash 非思考模式，引用原始语音片段组织固定字段 */
export class DashscopeOrganizeAdapter implements OrganizeAdapter {
  readonly modelId = cfg.dashscope.organizeModel;

  async organize(input: OrganizeInput): Promise<OrganizeOutput> {
    const transcript = input.utterances
      .map((u) => `[${u.id}] ${u.startMs}-${u.endMs}ms ${u.unclear ? '(听不清)' : u.text}`)
      .join('\n');
    const vision = input.visionFrames
      .map((f) => `${f.timeMs}ms 妆造:${f.makeup} 情绪:${f.emotion}${f.isAiGenerated ? ' [AI画面]' : ''}`)
      .join('\n');

    const body = await jsonFetch(`${host()}/compatible-mode/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.dashscope.organizeModel,
        messages: [
          { role: 'system', content: input.rules },
          {
            role: 'user',
            content: [
              `视频总时长：${input.durationMs}ms`,
              `形式：${input.form.categoryLabel}（依据：${input.form.evidence}）`,
              '原始语音片段（ISO：id 起止毫秒 文本；标(听不清)的片段不得补写内容）：',
              transcript,
              '画面理解结果：',
              vision,
              '请输出 JSON：{"segments":[{"startMs":0,"endMs":0,"copyText":"","tag":"","makeup":"","emotion":"","sourceUtteranceIds":[]}]}',
              `tag 必须是这六个之一：${TAG_ORDER.join(' / ')}；每段只能有一个 tag，不要输出场景字段。`,
              '再次强调：copyText 必须是与 sourceUtteranceIds 对应的原始片段文本的原样拼接（逐字一致，只可补标点）；不要改写、不要润色、不要合并句子。每个原始片段只能出现在一段里。',
            ].join('\n'),
          },
        ],
        response_format: { type: 'json_object' },
        enable_thinking: false,
      }),
    });
    const txt: string = body?.choices?.[0]?.message?.content ?? '{}';
    const parsed = safeJson(txt);
    dumpRaw('organize', { model: cfg.dashscope.organizeModel, content: txt, parsed, usage: body?.usage });
    const segments: OrganizeSegmentInput[] = Array.isArray(parsed?.segments)
      ? parsed.segments.map((s: any) => ({
          startMs: Math.round(Number(s.startMs ?? 0)),
          endMs: Math.round(Number(s.endMs ?? 0)),
          copyText: String(s.copyText ?? s.text ?? ''),
          // 标签：兼容 tag / label / 标签 三种写法，落到六类之一（归不了的进「其他」，不丢段）
          tag: normalizeTag(s.tag ?? s.label ?? s['标签']),
          voiceover: '',
          makeup: String(s.makeup ?? MISSING.UNRECOGNIZABLE),
          emotion: String(s.emotion ?? MISSING.PENDING_REVIEW),
          sourceUtteranceIds: Array.isArray(s.sourceUtteranceIds) ? s.sourceUtteranceIds.map(String) : [],
        }))
      : [];

    // 听不清片段由程序补齐，不交给模型补写（PRD 5.1 / 10.5）
    for (const u of input.utterances.filter((x) => x.unclear)) {
      if (!segments.some((s) => s.sourceUtteranceIds.includes(u.id))) {
        segments.push({
          startMs: u.startMs,
          endMs: u.endMs,
          copyText: unclearAt(u.startMs, u.endMs),
          tag: TAG.OTHER,
          voiceover: '',
          makeup: MISSING.PENDING_REVIEW,
          emotion: MISSING.PENDING_REVIEW,
          sourceUtteranceIds: [u.id],
          timeUncertain: true,
        });
      }
    }
    segments.sort((a, b) => a.startMs - b.startMs);

    return {
      segments,
      issues: [],
      usage: { ...readUsage(body?.usage), vendorRequestId: requestIdOf(body) },
    };
  }
}

/**
 * 统一用量字段。
 * compatible-mode 实测返回 `prompt_tokens` / `completion_tokens`（OpenAI 风格），
 * 而部分 DashScope 原生接口用 `input_tokens` / `output_tokens`。
 * 两者都取不到时必须标记 usageMissing，让费用记成「待核对」，而不是静默按 0 计。
 */
function readUsage(u: any): {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  usageMissing: boolean;
} {
  if (!u || typeof u !== 'object') return { usageMissing: true };
  const input = u.input_tokens ?? u.prompt_tokens;
  const output = u.output_tokens ?? u.completion_tokens;
  const thinking =
    u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens;
  const hasInput = typeof input === 'number';
  const hasOutput = typeof output === 'number';
  return {
    inputTokens: hasInput ? input : undefined,
    outputTokens: hasOutput ? output : undefined,
    thinkingTokens: typeof thinking === 'number' ? thinking : undefined,
    usageMissing: !hasInput && !hasOutput,
  };
}

/** 调用标识：compatible-mode 用 id，原生接口用 request_id */
function requestIdOf(body: any): string | undefined {
  const v = body?.request_id ?? body?.id;
  return v === undefined ? undefined : String(v);
}

function safeJson(txt: string): any {
  const cleaned = txt.replace(/```json/g, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(cleaned.slice(s, e + 1));
      } catch {
        return {};
      }
    }
    return {};
  }
}

/**
 * 原始返回留档：仅在 DASHSCOPE_DUMP_RAW=1 时写盘，默认不产生任何文件。
 * 用途：换模型 / 调提示词后需要核对「模型实际按什么键名返回」，
 * 而字段名错配过去是**静默**发生的（形式判定直接退化成待复核，日志里看不出来）。
 */
function dumpRaw(kind: string, payload: unknown) {
  if (process.env.DASHSCOPE_DUMP_RAW !== '1') return;
  try {
    const dir = path.join(cfg.tmpDir, 'dashscope-raw');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, `${kind}-${ts}.json`), JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // 留档失败不能影响主链路
  }
}

/**
 * 多套字段命名里取第一个**显式布尔**值。
 * 返回 undefined 表示「模型未表态」——必须与 false 区分开：
 * false 是「模型明确否掉」，undefined 是「该键不存在」，两者对判定口径的影响完全不同。
 */
function pickBool(...vals: unknown[]): boolean | undefined {
  for (const v of vals) if (v === true || v === false) return v;
  return undefined;
}

/** 多套字段命名里取第一个非空字符串（自动去首尾空白） */
function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
