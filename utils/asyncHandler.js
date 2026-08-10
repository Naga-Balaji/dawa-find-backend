// Express 4 does not catch rejected promises from async handlers — an
// unhandled rejection would crash the process instead of reaching the
// error middleware in server.js. Wrap every async route with this.
module.exports = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
