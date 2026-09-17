import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import AppHeader from '@/components/AppHeader';
import TaskListClient from '@/components/TaskListClient';

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return (
    <>
      <AppHeader />
      <div className="wrap">
        <TaskListClient />
      </div>
    </>
  );
}
