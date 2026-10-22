// Clean sales dataset (sent daily by apps-script/SalesToDashboard.gs) → the row shape the metrics engine reads.
// Clean columns: order_date (YYYY-MM-DD, IST), order_id (Shopify name), store_id, store_name, employee_name,
// order_type (CASH_AND_CARRY | ONLINE_ORDER), phone (10 digits), financial_status, is_cancelled, sku,
// product_name, category, quantity, price, gross, discount, net, discount_codes.

// Owner decision (22 Oct 2026): keep all orders, including cancelled and refunded (fully or partially), as recorded —
// everywhere: revenue, order counts, conversion, capture and attribution. Setting a flag to true leaves those orders out
// again without re-syncing.
export const EXCLUDE = { cancelled: false, refunded: false, partially_refunded: false };

export const isExcluded = (r) => {
  const canc = r.is_cancelled === true || String(r.is_cancelled).toLowerCase() === 'true';
  const fs = String(r.financial_status || '').toLowerCase();
  return (EXCLUDE.cancelled && canc) || (EXCLUDE.refunded && fs === 'refunded') || (EXCLUDE.partially_refunded && fs === 'partially_refunded');
};

export function excludedSummary(rows) {
  const orders = new Map();
  for (const r of rows) if (isExcluded(r)) {
    const o = orders.get(r.order_id) || { canc: false, fs: String(r.financial_status || '').toLowerCase(), net: 0 };
    o.canc = o.canc || r.is_cancelled === true || String(r.is_cancelled).toLowerCase() === 'true'; o.net += Number(r.net) || 0; orders.set(r.order_id, o);
  }
  const v = [...orders.values()];
  return { orders: v.length, revenue: Math.round(v.reduce((s, o) => s + o.net, 0)), cancelled: v.filter((o) => o.canc).length,
    refunded: v.filter((o) => !o.canc && o.fs === 'refunded').length, partially_refunded: v.filter((o) => !o.canc && o.fs === 'partially_refunded').length };
}

export function cleanToEngineRows(rows) {
  return rows.filter((r) => !isExcluded(r)).map((r) => ({
    'POS Order ID': r.order_id, 'Shopify Order ID': r.order_id,
    'POS Created At': r.order_date, 'Store ID': r.store_id, 'Store Name': r.store_name,
    'Customer Phone': r.phone, 'Customer Email': '', 'Employee Name': r.employee_name || '',
    'Order Type': r.order_type === 'CASH_AND_CARRY' ? 'RETAIL' : r.order_type === 'ONLINE_ORDER' ? 'ONLINE' : String(r.order_type || '').toUpperCase(),
    'Product Name': r.product_name, Quantity: r.quantity, 'Ret/Exc': '-',
    __gross: r.gross, __net: r.net,
  }));
}
