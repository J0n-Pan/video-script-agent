import { LocalSourceAdapter } from './local';
import { TencentMuseSourceAdapter } from './tencent-muse';
import type { SourceAdapter } from './types';

export function getSourceAdapter(sourceType: string): SourceAdapter {
  return sourceType === 'TENCENT_MUSE' ? new TencentMuseSourceAdapter() : new LocalSourceAdapter();
}

export * from './types';
