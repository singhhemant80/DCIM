import { Link } from 'react-router-dom';
import type { NavSection } from '@crapplet/shared';
import { PageHeader, Panel } from '../components/ui';

/**
 * Shown for sections that are not built yet. It says so plainly instead of
 * rendering an empty or fake screen.
 */
export function PlannedPage({ section }: { section: NavSection }) {
  return (
    <>
      <PageHeader title={section.label} description={section.summary} />
      <Panel>
        <div className="flex items-start gap-3">
          <span className="led mt-1.5" aria-hidden />
          <div className="max-w-[64ch]">
            <p className="font-semibold">Not built yet, scheduled for Phase {section.phase}</p>
            <p className="mt-1 text-ink-2">
              This section has no working features in this release, so it shows no data rather than placeholder figures. It goes live once its backend, database tables, access rules and tests are complete.
            </p>
            <p className="mt-3">
              <Link to="/" className="text-accent hover:underline">
                See build progress on the overview
              </Link>
            </p>
          </div>
        </div>
      </Panel>
    </>
  );
}

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" description="The address may be mistyped, or the page may have moved." />
      <Link to="/" className="text-accent hover:underline">
        Go to the overview
      </Link>
    </>
  );
}
