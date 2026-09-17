/**
 * 阿里云百炼「实时语音识别」适配器（WebSocket 全双工）。
 *
 * 为什么不用 PRD 原定的 qwen3-asr-flash-filetrans：
 *  该模型走 DashScope 异步任务，`file_urls` 只接受**公网可访问**的 HTTP(S) 地址。
 *  本机部署（127.0.0.1）无法提供公网地址，DashScope 临时上传桶返回的 oss:// 与私有桶
 *  https:// 地址都会被判为 InvalidParameter.MalformedURL（2026-09 实测）。
 *  实时接口允许直接推送**本地音频二进制帧**，无需公网地址，且返回句级时间戳，
 *  因此作为本机部署的默认通道。filetrans 通道保留（见 dashscope/index.ts），
 *  在具备公网存储能力时可切回。
 *
 * 实测记录（paraformer-realtime-v2，19.7 秒四句中文）：
 *  句级时间戳 [180-4620] [5060-9840] [10240-15220] [15660-19640]，与真实停顿边界吻合；
 *  推流速率 1x 与 4x 结果完全一致，故默认 4x 以缩短处理耗时。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { cfg } from '../../config';
import { ffmpegPath } from '../../ffmpeg';
import type {
  AudioRecognitionAdapter,
  AudioRecognitionInput,
  AudioRecognitionOutput,
  AudioUtterance,
  Usage,
} from '../types';

const execFileAsync = promisify(execFile);

/** 实时接口的 WebSocket 地址按区域区分，与 HTTP 域名同区域 */
function wsUrl(): string {
  return cfg.dashscope.wsHost;
}

/** 单个音频帧：100ms @ 16kHz 单声道 s16le = 3200 字节 */
const FRAME_BYTES = 16_000 * 2 * 0.1;

type RealtimeSentence = {
  beginMs: number;
  endMs: number;
  text: string;
  speakerId?: string;
  /** 词级时间戳（word_timestamp_enabled）；缺失时无法细分 */
  words?: RawWord[];
};

type RawWord = {
  begin_time?: number;
  end_time?: number;
  text?: string;
  punctuation?: string;
};

type RealtimeResult = {
  sentences: RealtimeSentence[];
  billedSeconds?: number;
  taskId: string;
  requestUuid?: string;
};

/** 语块粒度上限：超过则继续切。下游整理模型只能「整块引用」，片段过粗会让分段无法进行。 */
const MAX_UNIT_MS = 12_000;
const MAX_UNIT_CHARS = 60;

/** 句末标点：语块在这里切开 */
const SENTENCE_END_RE = /[。！？；…!?;]/;
/** 可退让的切点：长句被迫在中途切开时优先落在逗号处 */
const CLAUSE_END_RE = /[，、,:：]/;

/** 词 + 词标点拼成文本。实测（2026-09-16）该拼法与识别原文逐字一致（425 字完全一致）。 */
function wordText(w: RawWord): string {
  return `${w.text ?? ''}${w.punctuation ?? ''}`;
}

function buildText(words: RawWord[], from: number, to: number): string {
  return words.slice(from, to).map(wordText).join('');
}

/**
 * 把一条识别句子细分为「语块」。
 *
 * 为什么必须做（2026-09-16 定位）：带 BGM 的连续口播会被服务端并成一条长句，
 * 实测两条素材各出现一条 60 秒 / 37 秒的巨型片段。下游整理模型只能按「引用片段」
 * 分段，片段内部无法再切，于是第一段吞掉整段文案、后续段落又与之大量重合，
 * 回填阶段还会因为这些引用已被占用而保留模型改写的文案。
 *
 * 切法：在**词边界**上按句末标点切；文本由词文本 + 词标点拼成，因此
 * 所有语块按顺序拼接后与识别原文逐字一致（不增删、不改写，符合原文保真红线）。
 * 拼不回原文时**不切**，宁可粒度粗也不用错误的切点破坏原文。
 */
export function splitSentenceIntoUnits(s: RealtimeSentence): Array<{ text: string; startMs: number; endMs: number }> {
  const whole = [{ text: s.text, startMs: s.beginMs, endMs: s.endMs }];
  const words = (s.words ?? []).filter((w) => w && Number.isFinite(Number(w.begin_time)) && Number.isFinite(Number(w.end_time)));
  if (words.length < 2) return whole;
  if (buildText(words, 0, words.length) !== s.text) return whole;

  const out: Array<{ text: string; startMs: number; endMs: number }> = [];
  const begin = (i: number) => Math.round(Number(words[i].begin_time));
  const end = (i: number) => Math.round(Number(words[i].end_time));
  let from = 0;
  let chars = 0;
  let lastClauseCut = -1;

  const cut = (to: number) => {
    out.push({ text: buildText(words, from, to), startMs: begin(from), endMs: end(to - 1) });
    from = to;
    chars = 0;
    lastClauseCut = -1;
  };

  for (let i = 0; i < words.length; i += 1) {
    chars += wordText(words[i]).length;
    const punct = String(words[i].punctuation ?? '');
    if (CLAUSE_END_RE.test(punct)) lastClauseCut = i + 1;

    const overLong = end(i) - begin(from) >= MAX_UNIT_MS || chars >= MAX_UNIT_CHARS;
    const sentenceEnd = SENTENCE_END_RE.test(punct);
    if (!overLong && !sentenceEnd) continue;
    if (sentenceEnd) {
      cut(i + 1);
      continue;
    }
    // 过长且不是句末：优先退让到最近的逗号，避免把词切两半；没有逗号就只能在此处切
    const to = lastClauseCut > from ? lastClauseCut : i + 1;
    cut(to);
    i = to - 1; // 退让后重新走一遍未消费的词
  }
  if (from < words.length) cut(words.length);
  return out;
}

/**
 * 从任意音频/视频文件提取 16kHz 单声道 PCM（s16le）。
 * 实时接口只吃裸 PCM 帧，不接受容器格式。
 */
async function extractPcm16k(src: string, dest: string): Promise<string> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await execFileAsync(
    ffmpegPath(),
    ['-y', '-v', 'error', '-i', src, '-vn', '-f', 's16le', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', dest],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (!fs.existsSync(dest)) throw new Error('PCM 提取失败');
  return dest;
}

/**
 * 走一次完整的 WebSocket 识别：run-task → 推流 → finish-task → 收句。
 * 不使用 SDK，直接用 Node 内置 WebSocket，避免新增依赖。
 */
function runRecognition(pcmPath: string, onProgress?: (frames: number) => void): Promise<RealtimeResult> {
  return new Promise((resolve, reject) => {
    const model = cfg.dashscope.asrModel;
    const taskId = globalThis.crypto.randomUUID();
    const sentences: RealtimeResult['sentences'] = [];
    let billedSeconds: number | undefined;
    let requestUuid: string | undefined;
    let settled = false;
    let ws: WebSocket;

    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(progressTimer);
      try {
        ws?.close();
      } catch {
        /* 已关闭 */
      }
    };
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ sentences, billedSeconds, taskId, requestUuid });
    };

    const timer = setTimeout(
      () => fail(new Error(`实时语音识别超时（${Math.round(cfg.stageTimeoutMs / 1000)} 秒内未完成）`)),
      cfg.stageTimeoutMs,
    );

    let frameCount = 0;
    const progressTimer = setInterval(() => onProgress?.(frameCount), 3000);

    try {
      // Node 内置 WebSocket（undici）支持通过第二个参数传 headers；
      // 这是标准之外的扩展，但 DashScope 只接受 header 传密钥。
      ws = new WebSocket(wsUrl(), {
        headers: { Authorization: `bearer ${cfg.dashscope.apiKey}` },
      } as unknown as string[]);
    } catch (e) {
      return fail(new Error(`无法建立实时识别连接：${(e as Error).message}`));
    }

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            model,
            parameters: {
              format: 'pcm',
              sample_rate: 16000,
              language_hints: cfg.dashscope.asrLanguageHints,
              // 句切分的静音阈值（毫秒）。过小会把一句话切碎，过大会合并多句。
              max_sentence_silence: cfg.dashscope.asrMaxSentenceSilence,
              punctuation_prediction_enabled: true,
              // 词级时间戳：长句只能靠词边界细分（见 splitSentenceIntoUnits），
              // 顺带提供「词文本 + 词标点可逐字重建原文」的保真依据
              word_timestamp_enabled: true,
              inverse_text_normalization_enabled: true,
              disfluency_removal_enabled: false,
              ...(cfg.dashscope.asrDiarization ? { diarization_enabled: true } : {}),
            },
            input: {},
          },
        }),
      );
    });

    ws.addEventListener('message', async (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const event = msg?.header?.event;

      if (event === 'task-started') {
        requestUuid = msg?.header?.attributes?.request_uuid ?? requestUuid;
        // 推流：按 cfg.dashscope.asrPushSpeed 倍速发送，帧间隔 = 100ms / 倍速
        const delayMs = Math.max(1, Math.round(100 / cfg.dashscope.asrPushSpeed));
        let pcm: Buffer;
        try {
          pcm = fs.readFileSync(pcmPath);
        } catch (e) {
          return fail(new Error(`读取 PCM 失败：${(e as Error).message}`));
        }
        for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
          if (settled) return;
          ws.send(new Uint8Array(pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.length))));
          frameCount++;
          await new Promise((r) => setTimeout(r, delayMs));
        }
        ws.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId }, payload: { input: {} } }));
        return;
      }

      if (event === 'result-generated') {
        const sentence = msg?.payload?.output?.sentence;
        const usage = msg?.payload?.usage;
        if (usage?.duration !== undefined && usage.duration !== null) billedSeconds = Number(usage.duration);
        requestUuid = msg?.header?.attributes?.request_uuid ?? requestUuid;

        // 只要最终句：中间结果 sentence_end=false，心跳包需跳过
        if (!sentence || sentence.heartbeat === true || sentence.sentence_end !== true) return;
        const text = String(sentence.text ?? '').trim();
        if (!text) return;
        const beginMs = Math.round(Number(sentence.begin_time ?? 0));
        const endMs = Math.round(Number(sentence.end_time ?? 0));
        // 同一句可能被重复推送，按「起点+文本」去重
        if (sentences.some((s) => s.beginMs === beginMs && s.text === text)) return;
        sentences.push({
          beginMs,
          endMs: endMs > beginMs ? endMs : beginMs,
          text,
          speakerId: sentence.speaker_id !== undefined ? String(sentence.speaker_id) : undefined,
          words: Array.isArray(sentence.words) ? (sentence.words as RawWord[]) : undefined,
        });
        return;
      }

      if (event === 'task-failed') {
        const code = msg?.header?.error_code ?? 'TaskFailed';
        const message = msg?.header?.error_message ?? '实时语音识别任务失败';
        const hint = /ModelNotFound|Unsupported|Access denied|InvalidApiKey/i.test(`${code}${message}`)
          ? `\n排查：当前 ASR_MODEL=${model}，区域内需已开通该模型；或改用 DASHSCOPE_REGION 对应的密钥。`
          : '';
        return fail(new Error(`实时语音识别失败 [${code}] ${message}${hint}`));
      }

      if (event === 'task-finished') {
        requestUuid = msg?.header?.attributes?.request_uuid ?? requestUuid;
        done();
      }
    });

    ws.addEventListener('error', (e: any) => {
      const detail = e?.error?.message ?? e?.message ?? '未知错误';
      fail(new Error(`实时识别连接异常：${detail}（地址 ${wsUrl()}）`));
    });

    ws.addEventListener('close', () => {
      // 服务端可能不发 task-finished 就断开；此时若有结果则按成功处理
      if (!settled && sentences.length > 0) done();
    });
  });
}

export class DashscopeRealtimeAudioAdapter implements AudioRecognitionAdapter {
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

    const pcmPath = path.join(cfg.tmpDir, `asr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pcm`);
    try {
      await extractPcm16k(input.audioPath, pcmPath);

      const result = await runRecognition(pcmPath);

      // 时间戳裁剪到视频时长内，避免容器时长与音轨时长存在毫秒级偏差时越界
      const clamp = (v: number) => Math.max(0, Math.min(Math.round(v), input.durationMs));

      // 句子 → 语块：长句按词边界细分，使下游「分段 + 打标签」有可切的材料
      let coarseCount = 0;
      const units: AudioUtterance[] = [];
      for (const s of result.sentences) {
        if (s.endMs <= 0) continue;
        if (s.endMs - s.beginMs >= MAX_UNIT_MS && !(s.words?.length)) coarseCount += 1;
        for (const u of splitSentenceIntoUnits(s)) {
          units.push({
            id: '',
            text: u.text,
            startMs: clamp(u.startMs),
            endMs: clamp(u.endMs),
            speakerId: s.speakerId,
          });
        }
      }
      const utterances: AudioUtterance[] = units
        .filter((u) => u.text.trim() !== '' && u.endMs > u.startMs)
        .map((u, i) => ({ ...u, id: `u${i + 1}` }));

      const usage: Usage = {
        // 计费以服务端返回的时长为准；未返回时用本地音频时长估算并标记待核对
        audioSeconds: result.billedSeconds ?? Math.round(input.durationMs / 1000),
        vendorRequestId: result.requestUuid ?? result.taskId,
        usageMissing: result.billedSeconds === undefined,
      };

      const issues: AudioRecognitionOutput['issues'] = [];
      if (utterances.length === 0) {
        issues.push({
          code: 'NO_SPEECH_DETECTED',
          message: '音频中未识别到有效语音',
          severity: 'warn',
        });
      }
      // 粗片段必须显式告警：它是「首段吞掉整段文案、后续段落重复」的源头，
      // 静默通过会让下游看起来正常、实际分段结果不可用
      if (coarseCount > 0) {
        issues.push({
          code: 'ASR_COARSE_SENTENCE',
          message:
            `有 ${coarseCount} 条识别结果超过 ${MAX_UNIT_MS / 1000} 秒且未返回词级时间戳，无法细分：` +
            '下游只能整块引用，可能出现首段过长、段落内容重复，请人工核对分段结果',
          severity: 'warn',
        });
      }

      return { utterances, hasSpeech: utterances.length > 0, issues, usage };
    } finally {
      try {
        fs.rmSync(pcmPath, { force: true });
      } catch {
        /* 忽略清理失败 */
      }
    }
  }
}
