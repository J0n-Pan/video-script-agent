import { destroySession } from '@/lib/auth';
import { handleError, ok } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    await destroySession();
    return ok({ loggedOut: true });
  } catch (e) {
    return handleError(e);
  }
}
