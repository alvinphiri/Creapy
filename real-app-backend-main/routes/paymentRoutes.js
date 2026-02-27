const express = require("express");
const authController = require("../controllers/authController");
const paymentController = require("../controllers/paymentController");

const router = express.Router();

router.use(authController.protect);

router.post(
  "/listing-fee",
  authController.requireRole("landlord"),
  paymentController.initiateListingFee
);

router.post(
  "/tenant-premium",
  authController.requireRole("tenant"),
  paymentController.initiateTenantPremium
);

router.get("/mine", paymentController.getMyPayments);

module.exports = router;

