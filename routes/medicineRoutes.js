const router = require('express').Router();
const { list, getBySku, pharmaciesForSku } = require('../controllers/medicineController');

router.get('/', list);
router.get('/:sku', getBySku);
router.get('/:sku/pharmacies', pharmaciesForSku);

module.exports = router;
