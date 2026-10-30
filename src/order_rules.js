// How the API applies the order lifecycle (src/lifecycle.js, copied unchanged from
// the `orders` repo; copy it again when those rules change).
import { FINAL, STATUSES, canMove, canRoleMove } from './lifecycle.js';

/** Whether a customer may cancel an order that is in `status`. */
export const customerCanCancel = (status) => canRoleMove('customer', status, 'cancelled');

/**
 * Whether the API should accept a status that the business set in SethuCMS.
 * The business may skip ahead (a desk can mark an order shipped without every
 * step), but never go back, leave a final status, or cancel what already shipped.
 */
export function acceptRemoteStatus(from, to) {
  if (from === to || !STATUSES.includes(to) || FINAL.includes(from)) return false;
  if (to === 'cancelled') return canMove(from, 'cancelled');
  return STATUSES.indexOf(to) > STATUSES.indexOf(from);
}
