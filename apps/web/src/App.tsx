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
import { DatacentersPage, RoomsPage } from './pages/Sites';
import { FloorPlansPage } from './pages/FloorPlans';
import { RackDetailPage, RacksPage } from './pages/Racks';
import { HardwarePage } from './pages/Hardware';
import { DeviceDetailPage, DeviceLabelPage } from './pages/DeviceDetail';
import { NetworkPage } from './pages/Network';
import { NetworkDevicePage } from './pages/NetworkDevice';
import { IpamPage, PrefixDetailPage } from './pages/Ipam';
import { NetworkMonitoringPage } from './pages/NetworkMonitoring';
import { AlertsPage } from './pages/Alerts';

/** Implemented sections. Every key here must be `available` in NAV_SECTIONS (checked by a test). */
export const IMPLEMENTED: Record<string, ComponentType> = {
  overview: OverviewPage,
  customers: CustomersPage,
  users: UsersPage,
  audit: AuditPage,
  settings: SettingsPage,
  datacenters: DatacentersPage,
  rooms: RoomsPage,
  'floor-plans': FloorPlansPage,
  racks: RacksPage,
  hardware: HardwarePage,
  network: NetworkPage,
  ipam: IpamPage,
  'network-monitoring': NetworkMonitoringPage,
  alerts: AlertsPage,
};

function AppRoutes() {
  const { can, me } = useAuth();
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
        {visible.has('racks') && <Route path="/racks/:id" element={<RackDetailPage />} />}
        {visible.has('hardware') && <Route path="/hardware/:id" element={<DeviceDetailPage />} />}
        {visible.has('hardware') && me?.user.userType === 'staff' && <Route path="/hardware/:id/label" element={<DeviceLabelPage />} />}
        {visible.has('network') && <Route path="/network/devices/:id" element={<NetworkDevicePage />} />}
        {visible.has('ipam') && <Route path="/ipam/prefixes/:id" element={<PrefixDetailPage />} />}
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
