const router = require('express').Router();
const { protect, restrictTo } = require('../middleware/auth');
const c = require('../controllers/partnerController');

// Every partner route requires a logged-in user with role 'pharmacy'.
router.use(protect, restrictTo('pharmacy'));

router.post('/shop', c.registerShop);
router.get('/shop', c.getShop);
router.patch('/shop', c.updateShop);

router.get('/inventory', c.getInventory);
router.put('/inventory', c.bulkUpdateInventory);
router.post('/inventory/confirm', c.confirmAll);
router.patch('/inventory/:sku', c.updateOneSku);

module.exports = router;
