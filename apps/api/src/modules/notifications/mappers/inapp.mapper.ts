import type { InAppMessageView, NotificationPreferenceView } from '@ghmt/shared';
import type { InAppMessage } from '../../../generated/prisma/client';

export function toInAppView(row: InAppMessage): InAppMessageView {
  return {
    id: row.id,
    typeCode: row.typeCode,
    title: row.title,
    body: row.body,
    link: row.link,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}

const EMAIL_NOTE = 'Les relances de facturation restent envoyées aux administrateurs, quel que soit ce réglage.';

/** Les deux préférences du MVP : l'e-mail administratif (modifiable) et l'in-app (verrouillé, toujours actif). */
export function toPreferenceViews(emailEnabled: boolean): NotificationPreferenceView[] {
  return [
    { category: 'administrative', channel: 'email', enabled: emailEnabled, locked: false, note: EMAIL_NOTE },
    { category: 'administrative', channel: 'inapp', enabled: true, locked: true, note: null },
  ];
}
