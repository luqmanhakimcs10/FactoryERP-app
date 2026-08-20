/**
 * Purchase-order PDF export + share.
 *
 * Exists because "view, save, or download" is the whole of what Procurement can
 * do with a PO now (0089), and two of those three verbs need a file. Same
 * shape as `jobCardExport`: client-side HTML -> expo-print -> the OS share
 * sheet, which is both "save to Files" and "send on WhatsApp" depending on what
 * the user picks. Nothing here touches the database.
 */
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import type { PurchaseOrder } from '../models/inventoryTypes';
import { PO_STATUS_LABEL } from '../models/inventoryTypes';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}

function money(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : Number(n).toLocaleString();
}

function buildPoHtml(po: PurchaseOrder): string {
  const items = po.po_items ?? [];
  const rows = items
    .map(
      (i) => `<tr>
        <td>${escapeHtml(i.color_code ?? i.description ?? 'Item')}</td>
        <td class="num">${Number(i.quantity_meters).toLocaleString()}</td>
      </tr>`
    )
    .join('');

  const total = items.reduce((n, i) => n + Number(i.quantity_meters ?? 0), 0);

  return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #1B2E2D; padding: 28px; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  .sub { color: #6B7B7A; font-size: 13px; margin: 0 0 18px; }
  .meta { font-size: 13px; margin-bottom: 18px; }
  .meta span { color: #6B7B7A; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border-bottom: 1px solid #E3EFEE; padding: 8px 6px; text-align: left; }
  th { color: #6B7B7A; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 600; border-top: 2px solid #E3EFEE; border-bottom: none; }
  .note { margin-top: 18px; font-size: 12px; color: #6B7B7A; }
</style></head>
<body>
  <h1>Purchase order ${escapeHtml(po.po_code)}</h1>
  <p class="sub">${escapeHtml(po.suppliers?.name ?? 'No supplier assigned')}</p>
  <p class="meta">
    <span>Status</span> ${escapeHtml(PO_STATUS_LABEL[po.status] ?? po.status)} &nbsp;·&nbsp;
    <span>Raised</span> ${new Date(po.created_at).toLocaleDateString()} &nbsp;·&nbsp;
    <span>Amount</span> ${money(po.amount)}
    ${po.orders?.order_code ? `&nbsp;·&nbsp; <span>Order</span> ${escapeHtml(po.orders.order_code)}` : ''}
  </p>
  <table>
    <thead><tr><th>Item</th><th class="num">Quantity</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="2">No lines</td></tr>'}</tbody>
    <tfoot><tr><td>Total</td><td class="num">${total.toLocaleString()}</td></tr></tfoot>
  </table>
  ${po.notes ? `<p class="note">${escapeHtml(po.notes)}</p>` : ''}
</body></html>`;
}

/** Render the PO to a PDF and hand it to the OS share sheet (save or send). */
export async function sharePoPdf(po: PurchaseOrder): Promise<void> {
  const { uri } = await Print.printToFileAsync({ html: buildPoHtml(po) });
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(uri, {
    mimeType: 'application/pdf',
    dialogTitle: `Purchase order — ${po.po_code}`,
    UTI: 'com.adobe.pdf',
  });
}
