/**
 * Job card PDF export + share.
 *
 * Client-side only — nothing here persists to the DB. Renders a plain HTML
 * summary and hands it to expo-print for a PDF, then to the OS share sheet
 * (which already lists WhatsApp as a target on both platforms) rather than a
 * hardcoded `whatsapp://` deep link, since that scheme fails silently with no
 * error when WhatsApp isn't installed.
 */
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import type { Order, OrderStage, JobCard, JobCardLine } from '../models/orderTypes';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}

function buildJobCardHtml(
  order: Order,
  card: JobCard,
  lines: JobCardLine[],
  stages: OrderStage[],
  repeatCount: number
): string {
  const vendorName = escapeHtml(order.vendors?.name ?? '—');
  const totalStitches =
    card.stitches_per_repeat && repeatCount ? Math.round(card.stitches_per_repeat * repeatCount) : null;
  const designMeta = card.design_code
    ? ` · Design ${escapeHtml(card.design_code)}${
        card.stitches_per_repeat ? ` · ${card.stitches_per_repeat.toLocaleString()} stitches/repeat` : ''
      }${totalStitches !== null ? ` · ${totalStitches.toLocaleString()} total stitches` : ''}`
    : '';
  const rows = lines
    .slice()
    .sort((a, b) => a.needle_number - b.needle_number)
    .map(
      (l) => `<tr>
        <td>${String(l.needle_number).padStart(2, '0')}</td>
        <td>${escapeHtml(l.thread_color_code)}</td>
        <td style="text-align:right">${l.stitch_count?.toLocaleString() ?? '—'}</td>
      </tr>`
    )
    .join('');
  const stageList = stages
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map(
      (s) =>
        `<li>${s.sequence}. ${escapeHtml(s.stage_type)}${s.is_outsourced ? ' (outsourced' + (s.finishing_partners?.name ? ' — ' + escapeHtml(s.finishing_partners.name) : '') + ')' : ''} — SLA ${s.sla_hours}h</li>`
    )
    .join('');

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: Inter, -apple-system, Helvetica, Arial, sans-serif; padding: 24px; color: #1B2E2D; }
      h1 { font-family: Poppins, Inter, sans-serif; font-size: 20px; margin-bottom: 4px; color: #0D7377; }
      h2 { font-family: Poppins, Inter, sans-serif; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: #6B7B7A; margin-top: 24px; }
      .meta { color: #6B7B7A; font-size: 13px; }
      table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      th, td { border: 1px solid #E3EFEE; padding: 6px 10px; font-size: 13px; text-align: left; }
      th { background: #E3F5F3; color: #0D7377; }
      ol, ul { padding-left: 20px; font-size: 13px; }
    </style>
  </head>
  <body>
    <h1>Job card — ${escapeHtml(order.order_code ?? '(draft)')}</h1>
    <div class="meta">Vendor: ${vendorName} · Revision ${card.revision}${designMeta}</div>

    <h2>Needle &amp; colour mapping</h2>
    <table>
      <tr><th>Needle</th><th>Thread colour</th><th>Stitches</th></tr>
      ${rows || '<tr><td colspan="3">No lines generated yet.</td></tr>'}
    </table>

    <h2>Stage sequence</h2>
    <ul>${stageList || '<li>Not set.</li>'}</ul>
  </body>
</html>`;
}

/** Generate the job card PDF and return its local file uri. */
export async function generateJobCardPdf(
  order: Order,
  card: JobCard,
  lines: JobCardLine[],
  stages: OrderStage[],
  repeatCount: number = 0
): Promise<string> {
  const html = buildJobCardHtml(order, card, lines, stages, repeatCount);
  const { uri } = await Print.printToFileAsync({ html });
  return uri;
}

/** Generate the PDF and hand it to the OS share sheet (Download/Save or Share). */
export async function shareJobCardPdf(
  order: Order,
  card: JobCard,
  lines: JobCardLine[],
  stages: OrderStage[],
  repeatCount: number = 0
): Promise<void> {
  const uri = await generateJobCardPdf(order, card, lines, stages, repeatCount);
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(uri, {
    mimeType: 'application/pdf',
    dialogTitle: `Job card — ${order.order_code ?? ''}`,
    UTI: 'com.adobe.pdf',
  });
}
