import { cfg } from '../config';
import { MockAudioAdapter, MockOrganizeAdapter, MockRewriteAdapter, MockVisionAdapter } from './mock';
import {
  DashscopeAudioAdapter,
  DashscopeOrganizeAdapter,
  DashscopeRewriteAdapter,
  DashscopeVisionAdapter,
} from './dashscope';
import { DashscopeRealtimeAudioAdapter } from './dashscope/realtime-asr';
import type { AiAdapters } from './types';

let cached: AiAdapters | null = null;

/** 三类能力分别配置，由服务端调用；页面与导出不依赖供应商原始返回结构（PRD 10.5） */
export function getAdapters(): AiAdapters {
  if (cached) return cached;
  if (cfg.aiMode === 'dashscope') {
    cached = {
      mode: 'dashscope',
      // 本机无公网地址，默认走实时通道直推本地音频；具备公网存储时可切回 filetrans
      audio:
        cfg.dashscope.asrTransport === 'filetrans'
          ? new DashscopeAudioAdapter()
          : new DashscopeRealtimeAudioAdapter(),
      vision: new DashscopeVisionAdapter(),
      organize: new DashscopeOrganizeAdapter(),
      rewrite: new DashscopeRewriteAdapter(),
    };
  } else {
    cached = {
      mode: 'mock',
      audio: new MockAudioAdapter(),
      vision: new MockVisionAdapter(),
      organize: new MockOrganizeAdapter(),
      rewrite: new MockRewriteAdapter(),
    };
  }
  return cached;
}

export function adapterSummary() {
  const a = getAdapters();
  return {
    mode: a.mode,
    audio: a.audio.modelId,
    vision: a.vision.modelId,
    organize: a.organize.modelId,
    rewrite: a.rewrite.modelId,
  };
}

export * from './types';
