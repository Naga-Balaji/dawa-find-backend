const router = require('express').Router();
const { list, nearby, nearbyMedicine, inventory, getById } = require('../controllers/pharmacyController');

router.get('/', list);
router.get('/nearby', nearby);
router.get('/medicines/nearby', nearbyMedicine);
router.get('/:id/inventory', inventory);
router.get('/:id', getById);

module.exports = router;
