import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import AppHeader from '@/components/AppHeader';
import RewriteClient from '@/components/RewriteClient';

export const dynamic = 'force-dynamic';

export default async function RewritePage({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.mustChangePassword) redirect('/change-password');
  return (
    <>
      <AppHeader />
      <div className="wrap">
        <RewriteClient videoId={params.id} />
      </div>
    </>
  );
}
