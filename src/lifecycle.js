// The order lifecycle: which statuses exist, which moves are allowed, who may
// make them. The API, vms and scm all follow these rules.

export const STATUSES = [
  'awaiting_payment', 'placed', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled',
];

export const FINAL = ['delivered', 'cancelled'];

/** status -> the statuses it may move to. */
export const TRANSITIONS = {
  awaiting_payment: ['placed', 'cancelled'],
  placed: ['confirmed', 'cancelled'],
  confirmed: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

/** Who may make each move. The customer may cancel only before the order is confirmed. */
export const ROLES = {
  customer: { placed: ['cancelled'], awaiting_payment: ['cancelled'] },
  vendor: { placed: ['confirmed'], confirmed: ['packed'] },
  desk: { placed: ['confirmed', 'cancelled'], awaiting_payment: ['cancelled'], confirmed: ['cancelled'] },
  delivery: { packed: ['shipped'], shipped: ['delivered'] },
  owner: { awaiting_payment: ['cancelled'], placed: ['cancelled'], confirmed: ['cancelled'], packed: ['cancelled'] },
};

export const isFinal = (status) => FINAL.includes(status);

export function canMove(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function canRoleMove(role, from, to) {
  return canMove(from, to) && (ROLES[role]?.[from] ?? []).includes(to);
}
