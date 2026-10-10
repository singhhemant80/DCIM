import PDFDocument from 'pdfkit';

export interface ReportColumn {
  key: string;
  label: string;
  /** Right-aligned numbers; `decimals` rounds them for display. */
  numeric?: boolean;
  decimals?: number;
}

export interface Report {
  type: string;
  title: string;
  period: { name: string; from: string; to: string; timezone: string };
  generatedAt: string;
  /** Who the report covers: the organization, or one customer. */
  scope: string;
  columns: ReportColumn[];
  rows: Record<string, string | number | boolean | null | undefined>[];
  /** Plain statements about data quality (measured vs estimated, gaps). */
  notes: string[];
}

/**
 * CSV cell. Text starting with = + - @ (or a tab/CR) is prefixed with an
 * apostrophe so spreadsheet programs don't run it as a formula; numbers are
 * written as numbers.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(r: Report): string {
  const lines = [r.columns.map((c) => csvCell(c.label)).join(',')];
  for (const row of r.rows) lines.push(r.columns.map((c) => csvCell(row[c.key])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

function fmt(c: ReportColumn, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return c.decimals !== undefined ? v.toLocaleString('en-US', { minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals }) : v.toLocaleString('en-US');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

/** A simple tabular PDF: title, period, notes, then the table across as many pages as needed. */
export function toPdf(r: Report): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: r.title, Producer: 'NexoraDC', Creator: 'NexoraDC by Crapplet Cloud' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#0f172a').text(r.title);
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(9).fillColor('#475569');
    doc.text(`${r.scope} · ${r.period.from.slice(0, 16).replace('T', ' ')} → ${r.period.to.slice(0, 16).replace('T', ' ')} UTC (${r.period.name}, ${r.period.timezone}) · generated ${r.generatedAt.slice(0, 16).replace('T', ' ')} UTC`);
    for (const n of r.notes) doc.text(`• ${n}`);
    doc.moveDown(0.6);

    // Column widths: proportional to the longest of header and (sampled) cells, numbers narrower.
    const sample = r.rows.slice(0, 200);
    const weights = r.columns.map((c) => Math.min(40, Math.max(c.label.length, ...sample.map((row) => fmt(c, row[c.key]).length), 4)));
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / total) * width);
    const rowH = 14;
    const bottom = () => doc.page.height - doc.page.margins.bottom;

    const header = () => {
      const y = doc.y;
      doc.rect(left, y - 2, width, rowH).fill('#e2e8f0');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#0f172a');
      let x = left;
      r.columns.forEach((c, i) => {
        doc.text(c.label, x + 2, y + 1, { width: widths[i]! - 4, height: rowH, ellipsis: true, lineBreak: false, align: c.numeric ? 'right' : 'left' });
        x += widths[i]!;
      });
      doc.y = y + rowH;
    };
    header();
    doc.font('Helvetica').fontSize(8);
    r.rows.forEach((row, n) => {
      if (doc.y + rowH > bottom()) {
        doc.addPage();
        header();
        doc.font('Helvetica').fontSize(8);
      }
      const y = doc.y;
      if (n % 2 === 1) doc.rect(left, y - 2, width, rowH).fill('#f8fafc');
      doc.fillColor('#0f172a');
      let x = left;
      r.columns.forEach((c, i) => {
        doc.text(fmt(c, row[c.key]), x + 2, y + 1, { width: widths[i]! - 4, height: rowH, ellipsis: true, lineBreak: false, align: c.numeric ? 'right' : 'left' });
        x += widths[i]!;
      });
      doc.y = y + rowH;
    });
    if (!r.rows.length) doc.font('Helvetica-Oblique').fillColor('#64748b').text('No data for this period.', left, doc.y + 4);
    doc.end();
  });
}
