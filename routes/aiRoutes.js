const router = require('express').Router();
const { protect } = require('../middleware/auth');
const { readPrescription } = require('../controllers/aiController');

// Login-gated: a prescription is health data, and every call spends
// OpenRouter credit. Drop `protect` to open it up for a public demo.
router.post('/prescription', protect, readPrescription);

module.exports = router;
