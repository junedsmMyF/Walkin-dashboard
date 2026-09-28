// Manual walk-in overrides — orders the Founders Office has confirmed as walk-in orders even though
// no Bigin lead matches them. Each one is counted as attributed revenue, credited to the store that
// billed it, and listed under Funnel & definitions → Data quality.
// Add one POS Order ID per line, with a short note. Removing a line removes the override.
export const MANUAL_WALKIN_ORDERS = new Map([
  ['INV_2627_FRIDO_0013_2205', 'Marked Walkin Order in OLM_Raw.xlsx (13 Sep, Banjara Hills); phone not in Bigin'],
]);
