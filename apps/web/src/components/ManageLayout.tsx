import { BrandMark, Icon, type IconName } from '@ats/ui';
import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import type { Me } from '../lib/api.ts';
import '../routes/manage.css';

export type ManageSection =
  | 'people'
  | 'settings'
  | 'assistants'
  | 'activity'
  | 'server'
  | 'account';

const GROUP: { key: ManageSection; to: string; label: string; icon: IconName }[] = [
  { key: 'people', to: '/group/people', label: 'People', icon: 'people' },
  { key: 'settings', to: '/group/settings', label: 'Group settings', icon: 'settings' },
  { key: 'assistants', to: '/studio/assistants', label: 'AI assistants', icon: 'sparkles' },
  { key: 'activity', to: '/group/activity', label: 'Activity', icon: 'activity' },
  { key: 'server', to: '/group/server', label: 'Server', icon: 'server' },
];

/**
 * Running the group (for its Architects) and your own account: one place, with the sections
 * beside the page on wide screens and in a row above it on phones.
 */
export function ManageLayout({
  me,
  title,
  intro,
  children,
}: {
  me: Me;
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  const group = me.groups[0];
  const isArchitect = group?.role === 'architect';
  return (
    <main className="ats-screen">
      <div className="manage">
        <header className="manage-header">
          <Link to="/" className="manage-home">
            <BrandMark size={28} />
            <span>
              <span className="manage-group">{group?.groupName ?? 'All the Spaces'}</span>
              <span className="manage-back">
                <Icon name="back" size={14} />
                Your spaces
              </span>
            </span>
          </Link>
        </header>
        <div className="manage-grid">
          <nav className="manage-nav" aria-label="Manage">
            {isArchitect && (
              <>
                <span className="manage-nav-heading">Your group</span>
                {GROUP.map((s) => (
                  <NavLink key={s.key} to={s.to}>
                    <Icon name={s.icon} size={16} />
                    {s.label}
                  </NavLink>
                ))}
              </>
            )}
            <span className="manage-nav-heading">You</span>
            <NavLink to="/account">
              <Icon name="account" size={16} />
              Your account
            </NavLink>
          </nav>
          <div className="manage-page">
            <div className="manage-title">
              <h1>{title}</h1>
              {intro && <p className="ats-muted">{intro}</p>}
            </div>
            {children}
          </div>
        </div>
      </div>
    </main>
  );
}
