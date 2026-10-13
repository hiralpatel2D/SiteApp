export const MODULE_IDS = [
  'attendance',
  'manpower',
  'hindrance',
  'indent',
  'stock',
  'inward',
  'outward',
  'drawings',
  'equipment',
  'safety',
  'report',
  'insights',
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export const CORE_CAPABILITIES = [
  'company.view',
  'company.manage',
  'users.view',
  'users.manage',
  'roles.view',
  'roles.manage',
  'projects.view',
  'projects.manage',
  'audit.view',
] as const;
export type CoreCapability = (typeof CORE_CAPABILITIES)[number];

export type ModuleCapability = `${ModuleId}.view`;
export type Capability = CoreCapability | ModuleCapability;

export const CAPABILITIES: readonly Capability[] = [
  ...CORE_CAPABILITIES,
  ...MODULE_IDS.map((m): ModuleCapability => `${m}.view`),
];
