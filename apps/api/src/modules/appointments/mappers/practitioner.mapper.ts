import type { Practitioner } from '../../../generated/prisma/client';

export type PractitionerRow = Practitioner;

export interface PractitionerView {
  readonly id: string;
  readonly userId: string | null;
  readonly fullName: string;
  readonly specialty: string | null;
  readonly departmentId: string | null;
  readonly primarySiteId: string | null;
  readonly licenseNumber: string | null;
  readonly defaultConsultMinutes: number;
  readonly isBookable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly rowVersion: number;
}

export function toPractitionerView(row: PractitionerRow): PractitionerView {
  return {
    id: row.id,
    userId: row.userId,
    fullName: row.fullName,
    specialty: row.specialty,
    departmentId: row.departmentId,
    primarySiteId: row.primarySiteId,
    licenseNumber: row.licenseNumber,
    defaultConsultMinutes: row.defaultConsultMinutes,
    isBookable: row.isBookable,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    rowVersion: row.rowVersion,
  };
}
