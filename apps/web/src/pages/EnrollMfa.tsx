import { useAuth } from '../lib/auth';
import { Button, Panel } from '../components/ui';
import { MfaSetup } from './Account';

/** Full-screen gate shown when the organization requires MFA and this staff user hasn't enrolled. */
export function EnrollMfaPage() {
  const { me, signOut } = useAuth();
  return (
    <main className="mx-auto flex min-h-full max-w-xl flex-col justify-center px-4 py-12">
      <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Set up two-step sign-in</h1>
      <p className="mt-1 text-ink-2">{me?.organization.name} requires staff to confirm sign-ins with an authenticator app. You can continue once it’s set up.</p>
      <Panel className="mt-5">
        <MfaSetup />
      </Panel>
      <div className="mt-4">
        <Button variant="ghost" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    </main>
  );
}
