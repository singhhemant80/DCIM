import type { ComponentType } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { NAV_SECTIONS } from '@crapplet/shared';
import { useAuth } from './lib/auth';
import { Shell, useVisibleSections } from './components/Shell';
import { Loading } from './components/ui';
import { LoginPage } from './pages/Login';
import { EnrollMfaPage } from './pages/EnrollMfa';
import { OverviewPage } from './pages/Overview';
import { CustomersPage } from './pages/Customers';
import { UsersPage } from './pages/Users';
import { RolesPage } from './pages/Roles';
import { AuditPage } from './pages/Audit';
import { SettingsPage } from './pages/Settings';
import { AccountPage } from './pages/Account';
import { NotFoundPage, PlannedPage } from './pages/Planned';

/** Implemented sections. Every key here must be `available` in NAV_SECTIONS (checked by a test). */
export const IMPLEMENTED: Record<string, ComponentType> = {
  overview: OverviewPage,
  customers: CustomersPage,
  users: UsersPage,
  audit: AuditPage,
  settings: SettingsPage,
};

function AppRoutes() {
  const { can } = useAuth();
  const visible = new Set(useVisibleSections().map((s) => s.key));
  return (
    <Shell>
      <Routes>
        {NAV_SECTIONS.map((s) => {
          if (!visible.has(s.key)) return null;
          const Page = IMPLEMENTED[s.key];
          return <Route key={s.key} path={s.path} element={Page && s.status === 'available' ? <Page /> : <PlannedPage section={s} />} />;
        })}
        {can('roles.read') && <Route path="/roles" element={<RolesPage />} />}
        <Route path="/account" element={<AccountPage />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Shell>
  );
}

export function App() {
  const { me, loading } = useAuth();
  if (loading) return <Loading label="Starting Crapplet DCIM" />;
  if (!me) return <LoginPage />;
  if (me.mfaEnrollmentRequired) return <EnrollMfaPage />;
  return <AppRoutes />;
}
