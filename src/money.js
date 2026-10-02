function toCents(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100);
}

function fromCents(value) {
  return Number((value / 100).toFixed(2));
}

module.exports = { toCents, fromCents };