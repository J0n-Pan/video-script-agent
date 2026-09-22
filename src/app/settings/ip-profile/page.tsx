import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import AppHeader from '@/components/AppHeader';
import ProfilePackClient from '@/components/ProfilePackClient';

export const dynamic = 'force-dynamic';

/**
 * 资料包管理页（原「IP 资料包」，2026-09-22 第七轮扩为两类）。
 *
 * 路由保持 `/settings/ip-profile` 不变：改名只动界面文案，
 * 动 URL 会让编导收藏的入口失效，换不来任何好处。
 */
export default async function ProfilePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return (
    <>
      <AppHeader />
      <div className="wrap">
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>资料包</h2>
        </div>

        <div style={{ marginBottom: 12 }}>
          <ProfilePackClient
            kind="IP"
            heading="IP 资料包"
            intro={
              <>
                资料包是改写稿<strong>唯一的事实来源</strong>：资料里没有的经历、资质、案例、课程权益、价格、赠品，生成时一律不得编造。
                换文档会新增一个版本（不覆盖旧版），已生成的历史稿件仍按当时锁定的版本取事实。
              </>
            }
          />
        </div>

        <ProfilePackClient
          kind="BANNED"
          heading="违禁词资料包"
          intro={
            <>
              这里上传的资料用来告诉改写模型：<strong>哪些词 / 表达绝对不能出现在改写文案里</strong>
              （例如广告法绝对化用语、医疗功效承诺、平台敏感词）。它不是事实来源，也不参与「可以说什么」；
              只在生成时作为<strong>红线约束</strong>渲染进提示词，并在生成后由程序逐段扫描命中，
              命中处会在改写页标出（<strong>只提示、不阻断</strong>，误报可由编导判断）。
              与 IP 资料包一样按版本管理，两者各自独立生效、互不影响。
            </>
          }
          hint={
            <>
              {' '}
              文档里建议按 <span className="mono">分类标题</span> 分段、每行一条词，或用顿号分隔多个词；
              上传前可先点「解析预览」核对程序读出的分类与词条对不对。
            </>
          }
        />
      </div>
    </>
  );
}
