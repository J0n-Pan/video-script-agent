import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import AppHeader from '@/components/AppHeader';
import MuseSessionClient from '@/components/MuseSessionClient';

export const dynamic = 'force-dynamic';

export default async function MuseSessionPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.mustChangePassword) redirect('/change-password');
  return (
    <>
      <AppHeader />
      <div className="wrap">
        <MuseSessionClient />
      </div>
    </>
  );
}
