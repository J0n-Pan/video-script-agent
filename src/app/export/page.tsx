import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import AppHeader from '@/components/AppHeader';
import ExportClient from '@/components/ExportClient';

export const dynamic = 'force-dynamic';

export default async function ExportPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.mustChangePassword) redirect('/change-password');
  return (
    <>
      <AppHeader />
      <div className="wrap">
        <Suspense fallback={<div className="muted">加载中…</div>}>
          <ExportClient />
        </Suspense>
      </div>
    </>
  );
}
