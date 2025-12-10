const parseLimit = (value, defaultValue = 20, max = 100) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, max);
};

const parseOffset = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
};

const fillPercentageSelect =
  "CASE WHEN p.pool_size > 0 THEN (p.deposited::numeric / p.pool_size::numeric) * 100 ELSE 0 END";

module.exports = {
  parseLimit,
  parseOffset,
  fillPercentageSelect
};
