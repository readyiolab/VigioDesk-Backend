import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { db } from '../../lib/mysql';
import { AppError } from '../../middleware/errorHandler.middleware';

const PAGE_W = 595.28; // A4 portrait, points
const PAGE_H = 841.89;
const MARGIN = 48;
const BRAND = rgb(0.145, 0.388, 0.922); // #2563eb
const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.89, 0.91, 0.94);
const FILL = rgb(0.965, 0.973, 0.984); // slate-50
const OK = rgb(0.02, 0.59, 0.41); // emerald-600
const BAD = rgb(0.86, 0.15, 0.15);
const LABEL_W = 110;

const ACTION_LABEL: Record<string, string> = {
  DOCUMENT_UPLOADED: 'Document uploaded',
  DOCUMENT_CONVERTED: 'Converted to PDF',
  DOCUMENT_UPDATED: 'Document updated',
  FIELDS_UPDATED: 'Fields updated',
  RECIPIENT_ADDED: 'Recipient added',
  DOCUMENT_SENT: 'Sent for signature',
  DOCUMENT_OPENED: 'Opened',
  DOCUMENT_VIEWED: 'Opened',
  RECIPIENT_VIEWED: 'Opened',
  FIELD_COMPLETED: 'Field completed',
  DOCUMENT_SIGNED: 'Signed',
  RECIPIENT_SIGNED: 'Signed',
  RECIPIENT_COMPLETED: 'Signed',
  DOCUMENT_COMPLETED: 'All parties signed',
  DOCUMENT_DECLINED: 'Declined',
  RECIPIENT_DECLINED: 'Declined',
  REMINDER_SENT: 'Reminder sent',
  DOCUMENT_VOIDED: 'Cancelled',
};

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
}

/**
 * A cursor that lays out top-down in PDF's bottom-up coordinate space and
 * starts a new page when it runs out of room.
 *
 * Worth the small abstraction: a certificate has an unbounded number of signers
 * and audit rows, so anything that assumes a single page will silently drop
 * evidence off the bottom of the paper on a document with six signers.
 */
class Layout {
  page: PDFPage;
  y: number;
  private pages: PDFPage[] = [];

  constructor(private pdf: PDFDocument, private fonts: Fonts) {
    this.page = pdf.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN;
  }

  /** Ensures `needed` points remain; otherwise breaks to a fresh page. */
  ensure(needed: number): void {
    if (this.y - needed >= MARGIN) return;
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN;
  }

  text(value: string, opts: { size?: number; font?: PDFFont; color?: typeof INK; x?: number; gap?: number } = {}): void {
    const size = opts.size ?? 9;
    const font = opts.font ?? this.fonts.regular;
    this.ensure(size + 4);
    this.y -= size;
    this.page.drawText(value, {
      x: opts.x ?? MARGIN,
      y: this.y,
      size,
      font,
      color: opts.color ?? INK,
    });
    this.y -= opts.gap ?? 4;
  }

  /**
   * Draws a run of prose, wrapped to the page width. pdf-lib's drawText never
   * wraps, so a long sentence handed to text() runs straight off the right
   * margin and is clipped — which is exactly how the explanatory paragraphs used
   * to lose their last few words. Everything narrative goes through here.
   */
  paragraph(
    value: string,
    opts: { size?: number; font?: PDFFont; color?: typeof INK; gap?: number; lineGap?: number } = {}
  ): void {
    const size = opts.size ?? 9;
    const font = opts.font ?? this.fonts.regular;
    const lines = wrap(value, font, size, PAGE_W - MARGIN * 2);
    lines.forEach((line, i) => {
      const last = i === lines.length - 1;
      this.text(line, { size, font, color: opts.color, gap: last ? opts.gap ?? 6 : opts.lineGap ?? 3 });
    });
  }

  rule(gap = 10): void {
    this.ensure(gap);
    this.y -= gap / 2;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_W - MARGIN, y: this.y },
      thickness: 0.75,
      color: RULE,
    });
    this.y -= gap / 2;
  }

  space(points: number): void {
    this.y -= points;
  }

  /** Two-column label / value row used in the document summary table. */
  kv(label: string, value: string, opts: { mono?: boolean } = {}): void {
    const size = 9;
    const valueFont = opts.mono ? this.fonts.mono : this.fonts.regular;
    const valueWidth = PAGE_W - MARGIN * 2 - LABEL_W;
    const lines = wrap(value || '—', valueFont, size, valueWidth);
    this.ensure(size * lines.length + 8);
    this.y -= size;
    this.page.drawText(label, {
      x: MARGIN,
      y: this.y,
      size,
      font: this.fonts.regular,
      color: MUTED,
    });
    let valueY = this.y;
    lines.forEach((line, i) => {
      if (i > 0) valueY -= size + 2;
      this.page.drawText(line, {
        x: MARGIN + LABEL_W,
        y: valueY,
        size,
        font: valueFont,
        color: INK,
      });
    });
    this.y = valueY - 6;
  }

  /** Soft bordered box for the integrity hash. */
  hashBox(hash: string): void {
    const size = 8;
    const pad = 10;
    const innerW = PAGE_W - MARGIN * 2 - pad * 2;
    const lines = wrap(hash, this.fonts.mono, size, innerW);
    const boxH = pad * 2 + lines.length * (size + 3);
    this.ensure(boxH + 8);
    this.y -= boxH;
    this.page.drawRectangle({
      x: MARGIN,
      y: this.y,
      width: PAGE_W - MARGIN * 2,
      height: boxH,
      color: FILL,
      borderColor: RULE,
      borderWidth: 0.75,
    });
    let ty = this.y + boxH - pad - size;
    for (const line of lines) {
      this.page.drawText(line, {
        x: MARGIN + pad,
        y: ty,
        size,
        font: this.fonts.mono,
        color: BRAND,
      });
      ty -= size + 3;
    }
    this.y -= 10;
  }

  getPages(): PDFPage[] {
    return this.pages;
  }
}

/** Wraps text to a pixel width. pdf-lib draws raw strings and will not wrap. */
function wrap(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      // A single word longer than the line (a hash, a long URL) is hard-split
      // rather than allowed to run off the page.
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        let chunk = '';
        for (const char of word) {
          if (font.widthOfTextAtSize(chunk + char, size) > maxWidth) {
            lines.push(chunk);
            chunk = char;
          } else chunk += char;
        }
        line = chunk;
      } else {
        line = word;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fmt(value: Date | string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  // UTC throughout. A certificate read in another country must not silently
  // shift a signing timestamp by the reader's local offset.
  return `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

function softAction(action: string): string {
  return ACTION_LABEL[action] ?? action.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

function statusLabel(status: string): { text: string; color: typeof OK } {
  if (status === 'COMPLETED') return { text: 'Signed', color: OK };
  if (status === 'DECLINED') return { text: 'Declined', color: BAD };
  return { text: status, color: MUTED };
}

export const certificateService = {
  /**
   * Builds the certificate of completion.
   *
   * ── On hashes ──────────────────────────────────────────────────────────────
   * This cites the ORIGINAL document's hash, never the final one. The
   * certificate is appended INTO the signed PDF, so any hash it printed of that
   * PDF would be invalidated the moment it was embedded — a self-referential
   * hash is impossible, and printing one that doesn't verify is worse than
   * printing none. The final hash is computed after assembly and recorded on
   * the version row (and served by /status), where it can actually be checked.
   *
   * What this proves, and the audit trail behind it, is deliberately spelled
   * out on the page: a certificate nobody can interpret is decoration.
   */
  async build(documentId: string): Promise<Buffer> {
    const doc = await db.select('tbl_sign_document', '*', 'id = ?', [documentId]);
    if (!doc) throw new AppError('Document not found', 404);

    const recipients = await db.selectAll(
      'tbl_sign_recipient',
      '*',
      'documentId = ?',
      [documentId],
      'ORDER BY signingOrder ASC, createdAt ASC'
    );
    const audit = await db.queryAll(
      `SELECT action, actorName, actorEmail, detail, ipAddress, browser, os, createdAt
         FROM tbl_sign_audit WHERE documentId = ? ORDER BY createdAt ASC`,
      [documentId]
    );
    const owner: any = (await db.select('tbl_user', 'name, email', 'id = ?', [doc.ownerId])) ?? {};

    const pdf = await PDFDocument.create();
    const fonts: Fonts = {
      regular: await pdf.embedFont(StandardFonts.Helvetica),
      bold: await pdf.embedFont(StandardFonts.HelveticaBold),
      mono: await pdf.embedFont(StandardFonts.Courier),
    };
    const L = new Layout(pdf, fonts);
    const contentWidth = PAGE_W - MARGIN * 2;

    // ── Letterhead ──
    L.ensure(36);
    L.space(2);
    const markY = L.y - 16;
    L.page.drawRectangle({
      x: MARGIN,
      y: markY,
      width: 16,
      height: 16,
      color: BRAND,
    });
    L.page.drawText('P', {
      x: MARGIN + 4.5,
      y: markY + 4,
      size: 11,
      font: fonts.bold,
      color: rgb(1, 1, 1),
    });
    L.page.drawText('PDFProduct', {
      x: MARGIN + 22,
      y: markY + 4,
      size: 11,
      font: fonts.bold,
      color: INK,
    });
    L.y = markY - 14;
    L.text('Certificate of Completion', { size: 18, font: fonts.bold, gap: 6 });
    L.paragraph('Who signed this document, when they signed, and how the file was protected.', {
      size: 9,
      color: MUTED,
      gap: 4,
    });
    L.ensure(10);
    L.y -= 4;
    L.page.drawLine({
      start: { x: MARGIN, y: L.y },
      end: { x: PAGE_W - MARGIN, y: L.y },
      thickness: 2,
      color: BRAND,
    });
    L.y -= 14;

    // ── Document summary ──
    L.text('DOCUMENT', { size: 8, font: fonts.bold, color: BRAND, gap: 10 });
    for (const line of wrap(String(doc.title || 'Untitled'), fonts.bold, 13, contentWidth)) {
      L.text(line, { size: 13, font: fonts.bold, gap: 3 });
    }
    L.space(8);
    L.kv('File name', String(doc.fileName || '—'));
    L.kv('Document ID', String(doc.id), { mono: true });
    L.kv('Pages', String(doc.pageCount || '—'));
    L.kv('Sender', `${owner.name ?? '—'} <${owner.email ?? '—'}>`);
    L.kv(
      'Signing order',
      doc.flowType === 'SEQUENTIAL' ? 'Sequential (one after another)' : 'Parallel (any order)'
    );
    L.kv('Created', fmt(doc.createdAt));
    L.kv('Sent', fmt(doc.sentAt));
    L.kv('Completed', fmt(doc.completedAt));
    L.rule(14);

    // ── Integrity ──
    L.text('DOCUMENT INTEGRITY', { size: 8, font: fonts.bold, color: BRAND, gap: 8 });
    L.paragraph(
      'Fingerprint of the original file before anyone signed. It proves signers saw this exact document.',
      { size: 8, color: MUTED, gap: 4 }
    );
    L.text('Original SHA-256', { size: 8, font: fonts.bold, gap: 6 });
    L.hashBox(String(doc.originalHash ?? 'not recorded'));
    L.paragraph(
      'The finished PDF is also digitally sealed. Any later change will show as invalid in a PDF reader.',
      { size: 8, color: MUTED, gap: 4 }
    );
    L.rule(14);

    // ── Signers ──
    L.text('SIGNERS', { size: 8, font: fonts.bold, color: BRAND, gap: 10 });

    for (const r of recipients) {
      L.ensure(78);
      const cardTop = L.y;
      const deviceLine = [r.ipAddress, r.deviceInfo].filter(Boolean).join(' · ');
      const cardH = deviceLine ? 70 : 58;
      L.y -= cardH;
      L.page.drawRectangle({
        x: MARGIN,
        y: L.y,
        width: PAGE_W - MARGIN * 2,
        height: cardH,
        color: FILL,
        borderColor: RULE,
        borderWidth: 0.75,
      });
      L.page.drawRectangle({
        x: MARGIN,
        y: L.y,
        width: 3,
        height: cardH,
        color: BRAND,
      });

      const status = statusLabel(String(r.status));
      const name = String(r.name || 'Signer');
      const email = String(r.email || '');
      L.page.drawText(name, {
        x: MARGIN + 12,
        y: cardTop - 16,
        size: 10,
        font: fonts.bold,
        color: INK,
      });
      const statusW = fonts.bold.widthOfTextAtSize(status.text, 8);
      L.page.drawText(status.text, {
        x: PAGE_W - MARGIN - 12 - statusW,
        y: cardTop - 16,
        size: 8,
        font: fonts.bold,
        color: status.color,
      });
      L.page.drawText(email, {
        x: MARGIN + 12,
        y: cardTop - 30,
        size: 8,
        font: fonts.regular,
        color: MUTED,
      });

      const roleBit = `Role ${r.role}${r.signingOrder ? ` · Order ${r.signingOrder}` : ''}`;
      const when =
        r.status === 'DECLINED'
          ? `Declined ${fmt(r.completedAt)}`
          : `Signed ${fmt(r.completedAt)} · Viewed ${fmt(r.viewedAt)}`;
      L.page.drawText(roleBit, {
        x: MARGIN + 12,
        y: cardTop - 44,
        size: 7,
        font: fonts.regular,
        color: MUTED,
      });
      L.page.drawText(when, {
        x: MARGIN + 12,
        y: cardTop - 56,
        size: 7,
        font: fonts.regular,
        color: MUTED,
      });
      if (deviceLine) {
        L.page.drawText(deviceLine, {
          x: MARGIN + 12,
          y: cardTop - 66,
          size: 7,
          font: fonts.regular,
          color: MUTED,
        });
      }

      L.y -= 8;
      if (r.declineReason) {
        for (const line of wrap(`Reason: ${r.declineReason}`, fonts.regular, 8, contentWidth - 12)) {
          L.text(line, { size: 8, color: BAD, x: MARGIN + 12, gap: 2 });
        }
      }
      L.space(4);
    }

    L.rule(14);

    // ── Audit trail ──
    L.text('ACTIVITY', { size: 8, font: fonts.bold, color: BRAND, gap: 4 });
    L.text(`${audit.length} event${audit.length === 1 ? '' : 's'}, in order.`, {
      size: 8,
      color: MUTED,
      gap: 10,
    });

    for (const entry of audit) {
      L.ensure(28);
      L.text(fmt(entry.createdAt), { size: 7, font: fonts.mono, color: MUTED, gap: 2 });
      const who = entry.actorName ? String(entry.actorName) : 'System';
      const where = [entry.ipAddress, entry.browser, entry.os].filter(Boolean).join(' · ');
      const line = `${softAction(String(entry.action))} — ${who}${entry.detail ? `: ${entry.detail}` : ''}`;
      for (const l of wrap(line, fonts.regular, 8, contentWidth)) {
        L.text(l, { size: 8, gap: 2 });
      }
      if (where) L.text(where, { size: 7, color: MUTED, gap: 6 });
      else L.space(4);
    }

    // ── Footer on every page ──
    const pages = L.getPages();
    pages.forEach((page, i) => {
      page.drawLine({
        start: { x: MARGIN, y: MARGIN - 10 },
        end: { x: PAGE_W - MARGIN, y: MARGIN - 10 },
        thickness: 0.75,
        color: RULE,
      });
      page.drawText(`PDFProduct · Certificate of Completion · ${doc.id}`, {
        x: MARGIN,
        y: MARGIN - 22,
        size: 7,
        font: fonts.regular,
        color: MUTED,
      });
      const label = `Page ${i + 1} of ${pages.length}`;
      page.drawText(label, {
        x: PAGE_W - MARGIN - fonts.regular.widthOfTextAtSize(label, 7),
        y: MARGIN - 22,
        size: 7,
        font: fonts.regular,
        color: MUTED,
      });
    });

    return Buffer.from(await pdf.save({ useObjectStreams: false }));
  },

  /**
   * Appends the certificate's pages onto the signed document.
   *
   * Builds a fresh document and copies pages from both sources — mutating the
   * stamped PDF in place (load→addPage→save) can blank Word-converted content
   * streams the same way in-place stamping does. Page-count is asserted so a
   * silent loss of document pages cannot ship as a "certificate-only" file.
   */
  async appendTo(signedBytes: Buffer, certificateBytes: Buffer): Promise<Buffer> {
    const stamped = await PDFDocument.load(signedBytes, { ignoreEncryption: true });
    const certificate = await PDFDocument.load(certificateBytes, { ignoreEncryption: true });
    const expected = stamped.getPageCount() + certificate.getPageCount();

    const out = await PDFDocument.create();
    const stampedPages = await out.copyPages(stamped, stamped.getPageIndices());
    for (const page of stampedPages) out.addPage(page);
    const certPages = await out.copyPages(certificate, certificate.getPageIndices());
    for (const page of certPages) out.addPage(page);

    if (out.getPageCount() !== expected) {
      throw new Error(
        `Certificate append lost pages: expected ${expected}, got ${out.getPageCount()}`
      );
    }

    return Buffer.from(await out.save({ useObjectStreams: false }));
  },
};
