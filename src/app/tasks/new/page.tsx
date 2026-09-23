import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import AppHeader from '@/components/AppHeader';
import NewTaskClient from '@/components/NewTaskClient';

export const dynamic = 'force-dynamic';

export default async function NewTaskPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.mustChangePassword) redirect('/change-password');
  return (
    <>
      <AppHeader />
      <div className="wrap">
        <NewTaskClient />
      </div>
    </>
  );
}
