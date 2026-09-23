import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import AppHeader from '@/components/AppHeader';
import ReviewClient from '@/components/ReviewClient';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.mustChangePassword) redirect('/change-password');
  return (
    <>
      <AppHeader />
      <div className="wrap">
        <ReviewClient videoId={params.id} />
      </div>
    </>
  );
}
