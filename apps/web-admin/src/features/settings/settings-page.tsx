import { useCallback, useState } from 'react';
import { vi } from '@mihato/i18n';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadError } from '@/features/org/shared';
import { useApiQuery } from '@/lib/query';
import { ASSISTANT_ID, AssistantSection } from './section-assistant';
import { EMAIL_ID, EmailSection } from './section-email';
import { NUDGE_ID, NudgeSection } from './section-nudge';
import { AppVersionSection, CONTACT_ID, DataContactSection, OFFICE_ID, OfficeSection, RETENTION_ID, RetentionSection, VERSION_ID } from './sections-misc';
import { CALENDAR_ID, CalendarSection, QUIET_ID, QuietHoursSection, REMINDERS_ID, RemindersSection } from './sections-schedule';

const t = vi.admin.org.settings;

/** Mục lục bên trái, đúng thứ tự các nhóm trên trang. */
const SECTIONS = [
  { id: CALENDAR_ID, title: t.calendar.title },
  { id: QUIET_ID, title: t.quiet.title },
  { id: REMINDERS_ID, title: t.reminders.title },
  { id: NUDGE_ID, title: t.nudge.title },
  { id: OFFICE_ID, title: t.office.title },
  { id: EMAIL_ID, title: t.email.title },
  { id: ASSISTANT_ID, title: t.assistant.title },
  { id: VERSION_ID, title: t.appVersion.title },
  { id: RETENTION_ID, title: t.retention.title },
  { id: CONTACT_ID, title: t.dataContact.title },
] as const;

/**
 * Cài đặt tổ chức (SPEC 9.2, 10.3): `org.settingsGet` → biểu mẫu theo nhóm → `org.settingsPatch` chỉ gửi khoá đã đổi.
 * Mỗi nhóm lưu riêng và báo rõ đã lưu; mục lục bên trái đánh dấu nhóm còn thay đổi chưa lưu.
 */
export function SettingsPage() {
  const settings = useApiQuery('org.settingsGet', {});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const onDirtyChange = useCallback((id: string, isDirty: boolean) => {
    setDirty((prev) => (Boolean(prev[id]) === isDirty ? prev : { ...prev, [id]: isDirty }));
  }, []);
  const data = settings.data;

  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-x-8 gap-y-4 lg:grid-cols-[12.5rem_minmax(0,1fr)]">
        <nav aria-label={t.navLabel} className="lg:sticky lg:top-20">
          <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:gap-0.5 lg:overflow-visible">
            {SECTIONS.map((s) => (
              <li key={s.id} className="shrink-0">
                <a
                  href={`#${s.id}`}
                  className="flex min-h-9 items-center justify-between gap-2 rounded-lg px-3 py-1.5 font-medium text-ink-sub transition-colors -outline-offset-2 hover:bg-surface-alt hover:text-ink"
                >
                  {s.title}
                  {dirty[s.id] ? (
                    <>
                      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-gold" />
                      <span className="sr-only">({t.unsavedMark})</span>
                    </>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex max-w-4xl min-w-0 flex-col gap-5">
          {settings.isError ? (
            <LoadError error={settings.error} onRetry={() => void settings.refetch()} />
          ) : !data ? (
            <div aria-busy="true" className="flex flex-col gap-5">
              <Skeleton className="h-56 rounded-xl" />
              <Skeleton className="h-40 rounded-xl" />
              <Skeleton className="h-72 rounded-xl" />
            </div>
          ) : (
            <>
              <CalendarSection settings={data} onDirtyChange={onDirtyChange} />
              <QuietHoursSection settings={data} onDirtyChange={onDirtyChange} />
              <RemindersSection settings={data} onDirtyChange={onDirtyChange} />
              <NudgeSection settings={data} onDirtyChange={onDirtyChange} />
              <OfficeSection settings={data} onDirtyChange={onDirtyChange} />
              <EmailSection onDirtyChange={onDirtyChange} />
              <AssistantSection settings={data} onDirtyChange={onDirtyChange} />
              <AppVersionSection settings={data} onDirtyChange={onDirtyChange} />
              <RetentionSection settings={data} onDirtyChange={onDirtyChange} />
              <DataContactSection settings={data} onDirtyChange={onDirtyChange} />
            </>
          )}
        </div>
      </div>
    </>
  );
}
