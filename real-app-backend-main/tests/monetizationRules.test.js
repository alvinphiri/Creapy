const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const paymentController = require("../controllers/paymentController");
const webhookController = require("../controllers/webhookController");
const Payment = require("../models/paymentModel");
const Listing = require("../models/listingModel");
const User = require("../models/userModel");

const invokeController = (handler, req) =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        resolve({ statusCode: this.statusCode, body: this.body });
      },
    };

    handler(req, res, (err) => {
      if (err) {
        resolve({ error: err });
      } else {
        reject(new Error("Expected controller to resolve or error"));
      }
    });
  });

const invokeWebhookHandler = (handler, req) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        resolve({ statusCode: this.statusCode, body: this.body });
      },
    };

    handler(req, res);
  });

test("listing routes keep browse/view public and publish landlord-only", async () => {
  const file = fs.readFileSync(
    path.join(__dirname, "..", "routes", "listingRoutes.js"),
    "utf8"
  );

  assert.ok(file.includes('router.get("/", listingController.getListings);'));
  assert.ok(file.includes('router.get("/:id", listingController.getListing);'));
  assert.ok(file.includes('authController.requireRole("landlord")'));
  assert.ok(file.includes("listingController.createListing"));
  assert.ok(file.includes("listingController.updateListing"));

  const publicListIndex = file.indexOf('router.get("/", listingController.getListings);');
  const publicDetailIndex = file.indexOf('router.get("/:id", listingController.getListing);');
  const protectIndex = file.indexOf("router.use(authController.protect);");
  assert.ok(publicListIndex > -1 && publicListIndex < protectIndex);
  assert.ok(publicDetailIndex > -1 && publicDetailIndex < protectIndex);
});

test("tenant saved searches no longer require premium middleware", async () => {
  const file = fs.readFileSync(
    path.join(__dirname, "..", "routes", "savedSearchRoutes.js"),
    "utf8"
  );

  assert.ok(!file.includes("requirePremium"));
});

test("landlord can initiate listing fee payment", async () => {
  const originalCreate = Payment.create;
  const originalFindById = Listing.findById;

  let capturedPayment = null;

  Payment.create = async (data) => {
    capturedPayment = data;
    return { _id: "pay_1", ...data, status: "pending" };
  };

  Listing.findById = async () => ({
    _id: "listing_1",
    user: "u_1",
    status: "pending_payment",
  });

  const result = await invokeController(paymentController.initiateListingFee, {
    user: {
      _id: "u_1",
      toObject: () => ({ _id: "u_1", email: "test@example.com", phone: "256700000000" }),
    },
    body: { listingId: "listing_1", phone: "256700000000" },
  });

  Payment.create = originalCreate;
  Listing.findById = originalFindById;

  assert.equal(result.statusCode, 201);
  assert.equal(result.body.status, "success");
  assert.ok(result.body.data.transactionRef);
  assert.equal(capturedPayment.type, "listing_fee");
  assert.equal(capturedPayment.status, "pending");
});

test("tenant can initiate premium subscription payment", async () => {
  const originalCreate = Payment.create;

  let capturedPayment = null;

  Payment.create = async (data) => {
    capturedPayment = data;
    return { _id: "pay_2", ...data, status: "pending" };
  };

  const result = await invokeController(paymentController.initiateTenantPremium, {
    user: {
      _id: "u_2",
      toObject: () => ({ _id: "u_2", email: "tenant@example.com", phone: "256700000001" }),
    },
    body: { phone: "256700000001" },
  });

  Payment.create = originalCreate;

  assert.equal(result.statusCode, 201);
  assert.equal(result.body.status, "success");
  assert.ok(result.body.data.transactionRef);
  assert.equal(capturedPayment.type, "premium_subscription");
  assert.equal(capturedPayment.status, "pending");
});

test("webhook ignores payments with invalid hash", async () => {
  const originalGetProvider = require("../utils/paymentProvider").getProvider;
  require("../utils/paymentProvider").getProvider = () => ({
    verifyWebhook: () => ({ valid: false, transactionRef: "tx_1" }),
  });

  const result = await invokeWebhookHandler(webhookController.handlePaynowWebhook, {
    body: { reference: "tx_1", status: "paid" },
  });

  require("../utils/paymentProvider").getProvider = originalGetProvider;

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "ignored");
  assert.equal(result.body.reason, "invalid hash");
});

test("webhook marks failed payments as failed without granting access", async () => {
  const originalGetProvider = require("../utils/paymentProvider").getProvider;
  const originalFindOneAndUpdate = Payment.findOneAndUpdate;

  let updateCall = null;

  require("../utils/paymentProvider").getProvider = () => ({
    verifyWebhook: () => ({
      valid: true,
      transactionRef: "tx_failed",
      status: "failed",
    }),
  });

  Payment.findOneAndUpdate = async (filter, update) => {
    updateCall = { filter, update };
    return { _id: "pay_3", transactionRef: "tx_failed", status: "failed" };
  };

  const result = await invokeWebhookHandler(webhookController.handlePaynowWebhook, {
    body: { reference: "tx_failed", status: "failed" },
  });

  require("../utils/paymentProvider").getProvider = originalGetProvider;
  Payment.findOneAndUpdate = originalFindOneAndUpdate;

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "ok");
  assert.equal(updateCall.update.status, "failed");
  assert.equal(updateCall.update.webhookVerified, true);
});

