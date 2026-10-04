export const SITE_SELECT = {
  id: true,
  code: true,
  name: true,
  city: true,
  countryCode: true,
  timezone: true,
  isMain: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const DEPARTMENT_SELECT = {
  id: true,
  siteId: true,
  parentId: true,
  code: true,
  name: true,
  kind: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface SiteRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly city: string | null;
  readonly countryCode: string | null;
  readonly timezone: string | null;
  readonly isMain: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface DepartmentRow {
  readonly id: string;
  readonly siteId: string;
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toSiteDto(row: SiteRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    city: row.city,
    countryCode: row.countryCode,
    timezone: row.timezone,
    isMain: row.isMain,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toDepartmentDto(row: DepartmentRow) {
  return {
    id: row.id,
    siteId: row.siteId,
    parentId: row.parentId,
    code: row.code,
    name: row.name,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
