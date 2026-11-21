import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { getObjectBytes } from '../../lib/s3';
import { db } from '../../lib/mysql';
import { AppError } from '../../middleware/errorHandler.middleware';
import type { SignFieldType } from '../../../../shared/signing';

export interface DetectedField {
  id: string;
  type: SignFieldType;
  label: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  source: 'acroform' | 'heuristic';
}

const NAME_HINTS = /sign|signature|initial|date|name|email|company|title/i;

function mapAcroType(name: string, pdfType: string): SignFieldType {
  const n = name.toLowerCase();
  if (n.includes('sign') || n.includes('signature')) return 'SIGNATURE';
  if (n.includes('initial')) return 'INITIALS';
  if (n.includes('date')) return 'DATE';
  if (n.includes('email')) return 'EMAIL';
  if (n.includes('company') || n.includes('org')) return 'COMPANY';
  if (n.includes('name')) return 'NAME';
  if (pdfType.includes('Check') || pdfType.includes('Radio')) return 'CHECKBOX';
  if (pdfType.includes('Dropdown') || pdfType.includes('Option')) return 'DROPDOWN';
  return 'TEXT';
}

/**
 * Suggests fields from an uploaded PDF's AcroForm widgets (when present).
 * Heuristic keyword matching on field names only — never auto-sends; the
 * designer must confirm placement.
 */
export const fieldDetectService = {
  async detectForDocument(documentId: string, userId: string): Promise<DetectedField[]> {
    const doc = await db.select(
      'tbl_sign_document',
      'id, ownerId, fileKey, storageBindingId, pageCount, status',
      'id = ? AND ownerId = ?',
      [documentId, userId]
    );
    if (!doc) throw new AppError('Document not found', 404);
    if (!doc.fileKey) throw new AppError('Document file is not ready yet.', 409);

    const bytes = await getObjectBytes(doc.fileKey, doc.storageBindingId ?? null);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = pdf.getPages();
    const out: DetectedField[] = [];

    try {
      const form = pdf.getForm();
      const fields = form.getFields();
      for (const field of fields) {
        const name = field.getName();
        if (!NAME_HINTS.test(name) && !field.constructor.name.includes('Check')) continue;

        const widgets = (field as any).acroField?.getWidgets?.() ?? [];
        for (const widget of widgets) {
          const rect = widget.getRectangle?.();
          const pageRef = widget.P?.();
          let pageIndex = 0;
          if (pageRef) {
            const idx = pages.findIndex((p) => (p as any).ref === pageRef || (p as any).node === pageRef);
            if (idx >= 0) pageIndex = idx;
          }
          const page = pages[pageIndex] ?? pages[0];
          if (!page || !rect) continue;
          const { width: pw, height: ph } = page.getSize();
          if (pw <= 0 || ph <= 0) continue;

          const x = Math.min(Math.max(rect.x / pw, 0), 1);
          const width = Math.min(Math.max(rect.width / pw, 0.04), 1 - x);
          const height = Math.min(Math.max(rect.height / ph, 0.02), 0.2);
          const yFromBottom = rect.y / ph;
          const y = Math.min(Math.max(1 - yFromBottom - height, 0), 1 - height);
          const type = mapAcroType(name, field.constructor.name);

          out.push({
            id: crypto.randomUUID(),
            type,
            label: name.replace(/[_]+/g, ' ').trim() || type,
            page: pageIndex + 1,
            x,
            y,
            width,
            height,
            required: type === 'SIGNATURE' || type === 'DATE',
            source: 'acroform',
          });
        }
      }
    } catch {
      // No form or unreadable widgets — fall through to empty / heuristics.
    }

    // Light heuristic: if no AcroForm hits, suggest a signature block near the
    // bottom of the last page (common contract layout). User can move it.
    if (out.length === 0 && pages.length > 0) {
      const last = pages.length;
      out.push({
        id: crypto.randomUUID(),
        type: 'SIGNATURE',
        label: 'Signature',
        page: last,
        x: 0.12,
        y: 0.78,
        width: 0.32,
        height: 0.06,
        required: true,
        source: 'heuristic',
      });
      out.push({
        id: crypto.randomUUID(),
        type: 'DATE',
        label: 'Date',
        page: last,
        x: 0.55,
        y: 0.78,
        width: 0.22,
        height: 0.04,
        required: true,
        source: 'heuristic',
      });
      out.push({
        id: crypto.randomUUID(),
        type: 'NAME',
        label: 'Full name',
        page: last,
        x: 0.12,
        y: 0.7,
        width: 0.32,
        height: 0.035,
        required: false,
        source: 'heuristic',
      });
    }

    return out.slice(0, 40);
  },
};
