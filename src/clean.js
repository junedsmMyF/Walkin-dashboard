// Clean sales dataset (uploaded daily by the BigQuery notebook) → the row shape the metrics engine reads.
// Clean columns: order_date (YYYY-MM-DD, IST), order_id (Shopify name), store_id, store_name, employee_name,
// order_type (CASH_AND_CARRY | ONLINE_ORDER), phone (10 digits), financial_status, is_cancelled, sku,
// product_name, quantity, price, gross, discount, net, discount_codes.
export function cleanToEngineRows(rows) {
  return rows.map((r) => ({
    'POS Order ID': r.order_id, 'Shopify Order ID': r.order_id,
    'POS Created At': r.order_date, 'Store ID': r.store_id, 'Store Name': r.store_name,
    'Customer Phone': r.phone, 'Customer Email': '',
    'Order Type': r.order_type === 'CASH_AND_CARRY' ? 'RETAIL' : r.order_type === 'ONLINE_ORDER' ? 'ONLINE' : String(r.order_type || '').toUpperCase(),
    'Product Name': r.product_name, Quantity: r.quantity, 'Ret/Exc': '-',
    __gross: r.gross, __net: r.net,
  }));
}
