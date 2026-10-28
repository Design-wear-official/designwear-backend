// Picks the local team that will make and deliver an order, by PIN code.
import { bad } from './validate.js';

export function createFulfilment({ catalog }) {
  // A catalog without teams support (or a shop that never set teams up) has none.
  const teams = async () => (await catalog.teams?.()) ?? [];

  // Whether teams are in use at all (the `teams` collection has active rows).
  async function teamsInUse() {
    return (await teams()).length > 0;
  }

  async function teamsServing(pin) {
    return (await teams()).filter((team) => team.pins.includes(pin));
  }

  // Prices the lines using the first team that serves the PIN and has stock for
  // all of them. Returns { team, priced }. Without teams, { team: null, priced }
  // using the catalog's own stock, so a single-brand shop keeps working.
  async function assign({ pin, price }) {
    if (!(await teamsInUse())) return { team: null, priced: await price({}) };

    const candidates = await teamsServing(pin);
    if (!candidates.length) {
      throw bad('not_serviceable', 'We do not deliver to this PIN code yet.');
    }

    let firstProblem;
    for (const team of candidates) {
      try {
        const priced = await price({ stockOf: (product) => catalog.teamStock(team.id, product.id) });
        return { team, priced };
      } catch (error) {
        firstProblem ??= error;
      }
    }
    throw firstProblem;
  }

  // For the checkout screen: can anyone deliver here?
  async function serviceability(pin) {
    if (!(await teamsInUse())) return { serviceable: true, teams: 0 };
    const serving = await teamsServing(pin);
    return { serviceable: serving.length > 0, teams: serving.length };
  }

  return { assign, serviceability };
}
