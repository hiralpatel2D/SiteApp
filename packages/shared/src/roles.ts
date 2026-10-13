import {
  CAPABILITIES,
  CORE_CAPABILITIES,
  type Capability,
  type CoreCapability,
  type ModuleCapability,
  type ModuleId,
  MODULE_IDS,
} from './capabilities';

export type SystemRoleKey =
  | 'super_admin'
  | 'admin'
  | 'coordinator'
  | 'project_manager'
  | 'site_engineer'
  | 'supervisor'
  | 'store_keeper'
  | 'purchase'
  | 'client';

export const SYSTEM_ROLES: readonly { key: SystemRoleKey; name: string }[] = [
  { key: 'super_admin', name: 'Super Admin' },
  { key: 'admin', name: 'Admin' },
  { key: 'coordinator', name: 'Co-ordinator' },
  { key: 'project_manager', name: 'Project Manager' },
  { key: 'site_engineer', name: 'Site Engineer' },
  { key: 'supervisor', name: 'Supervisor' },
  { key: 'store_keeper', name: 'Store Keeper' },
  { key: 'purchase', name: 'Purchase Team' },
  { key: 'client', name: 'Client (read-only)' },
];

const views = (mods: readonly ModuleId[]): ModuleCapability[] =>
  mods.map((m): ModuleCapability => `${m}.view`);
const ALL_CORE: readonly CoreCapability[] = CORE_CAPABILITIES;
const BASIC: Capability[] = ['company.view', 'projects.view'];

const TABLE: Record<SystemRoleKey, Capability[]> = {
  super_admin: [...CAPABILITIES],
  admin: [...ALL_CORE, ...views(MODULE_IDS)],
  coordinator: [
    'company.view',
    'users.view',
    'roles.view',
    'projects.view',
    ...views(MODULE_IDS.filter((m) => m !== 'insights')),
  ],
  project_manager: [
    'company.view',
    'users.view',
    'roles.view',
    'projects.view',
    'projects.manage',
    'audit.view',
    ...views(MODULE_IDS),
  ],
  site_engineer: [
    ...BASIC,
    ...views([
      'attendance',
      'manpower',
      'hindrance',
      'indent',
      'inward',
      'outward',
      'drawings',
      'equipment',
      'safety',
      'report',
    ]),
  ],
  supervisor: [...BASIC, ...views(['attendance', 'manpower', 'hindrance', 'safety', 'report'])],
  store_keeper: [...BASIC, ...views(['attendance', 'indent', 'stock', 'inward', 'outward'])],
  purchase: [...BASIC, ...views(['indent', 'stock', 'inward'])],
  client: [...BASIC, ...views(['drawings', 'safety', 'report', 'insights'])],
};

export function defaultCapabilities(role: SystemRoleKey): Capability[] {
  return [...TABLE[role]];
}
