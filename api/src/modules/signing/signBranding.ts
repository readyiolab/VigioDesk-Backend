import { db } from '../../lib/mysql';

export interface SignBranding {
  brandName: string;
  brandColor: string;
  brandLogoUrl: string | null;
  emailFromName: string | null;
}

const DEFAULT: SignBranding = {
  brandName: 'PDFProduct',
  brandColor: '#2563eb',
  brandLogoUrl: null,
  emailFromName: null,
};

function normalizeColor(value: string | null | undefined): string {
  const raw = String(value || '').trim();
  if (/^#([0-9a-f]{6})$/i.test(raw)) return raw.toLowerCase();
  return DEFAULT.brandColor;
}

/** Owner branding for eSign emails and the public signer chrome. */
export async function loadSignBranding(ownerId: string | null | undefined): Promise<SignBranding> {
  if (!ownerId) return { ...DEFAULT };

  const [user, profile] = await Promise.all([
    db.select('tbl_user', 'name, email', 'id = ?', [ownerId]),
    db.select(
      'tbl_user_profile',
      'company, brandName, brandColor, brandLogoUrl, emailFromName',
      'userId = ?',
      [ownerId]
    ),
  ]);

  const brandName =
    (profile?.brandName && String(profile.brandName).trim()) ||
    (profile?.company && String(profile.company).trim()) ||
    (user?.name && String(user.name).trim()) ||
    DEFAULT.brandName;

  return {
    brandName,
    brandColor: normalizeColor(profile?.brandColor),
    brandLogoUrl: profile?.brandLogoUrl ? String(profile.brandLogoUrl).trim() : null,
    emailFromName: profile?.emailFromName ? String(profile.emailFromName).trim() : null,
  };
}
